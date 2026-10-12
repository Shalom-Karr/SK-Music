/**
 * Anti-scraping / abuse gate for the Worker's own routes (static assets never reach the Worker).
 *
 * Per request: resolve IP + signed-in identity (Supabase ES256 JWT from the `sk_at` cookie or a Bearer
 * header) + datacenter flag, then allowlist → ban → datacenter block → rate limit → escalation.
 * Rate limiting and datacenter blocking need only the `ratelimit` bindings; allowlist, bans and event
 * logging need Supabase (SUPABASE_URL / SUPABASE_KEY / SEC_TOKEN) and fail OPEN when it is unreachable.
 * Contract: security_state / security_log / security_ban RPCs (supabase/security.sql), catalog_state /
 * catalog_usage_add (supabase/catalog-gate.sql), bindings in wrangler.jsonc.
 *
 * Catalog files (the dataset + per-entity artist/album/curated-playlist JSON, see isCatalogPath) get two extra
 * controls, both read from catalog_state and both OFF while it can't be read: the account gate (signed-out ⇒
 * 401 account_required, when the admin switched it on) and a daily per-key quota (over it ⇒ security_ban's
 * escalation). They count against the burst limiter only, never the per-minute one.
 *
 * Signed-out limits (docs/anon-limits.md): without an account, 5 detail pages and 1 song start per 7 minutes per
 * client (IP, IPv6 /64, the X-Forwarded-For listener behind a content-filter proxy, or the signed sk_dev cookie),
 * and no search dataset — 401 signin_required. Counted by RateLimiter's anchored windows; fail open.
 */

// Test seam: the clock and the log-flush delay. Production never touches these.
export const _t = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

// ─── Datacenter detection ─────────────────────────────────────────────────────

// Hosting / cloud ASNs. Deliberately absent: Cloudflare 13335 (WARP, iCloud Private Relay), Akamai
// 20940/16625 and Fastly 54113 (Private Relay egress), Cogent 174 (also a consumer ISP) — real people.
const DC_ASNS = new Set([
  16509, 14618, 8987, // AWS
  396982, 19527, 15169, // Google Cloud
  8075, 8068, // Microsoft / Azure
  14061, // DigitalOcean
  24940, 213230, // Hetzner
  16276, // OVH
  63949, // Linode / Akamai cloud
  20473, // Vultr / Choopa
  31898, // Oracle
  45102, 37963, // Alibaba
  132203, 45090, // Tencent
  51167, 40021, // Contabo
  12876, // Scaleway
  60781, 28753, // Leaseweb
  9009, // M247
  60068, // DataCamp / CDN77
  40676, // Psychz
  8100, // QuadraNet
  47583, // Hostinger
  8560, // IONOS
  36007, 41436, // Kamatera
  203020, // HostRoyale
  7979, // Servers.com
  199524, // G-Core
  20081, // Net2Atlanta (vulnerability scanner seen in production)
  209366, // Semrush crawler
]);

// Content-filter proxies (Techloq, NetFree, …). Each egress IP carries many real listeners, and several sit
// on hosting networks — CLOUDWEBMANAGE-IL would match DC_ORG_RX — so they are never treated as datacenter.
// From Radar lookups of the busiest production IPs (Oct 2026); add new ones from the Security tab.
const FILTER_ASNS = new Set([
  402239, 397263, 211476, // Techloq US / US-02 / UK
  44709, // CloudWebManage IL
  395383, // DataVerge (Brooklyn)
  208172, 26548, // PV-Hosted, PureVoltage
]);
const DC_ORG_RX = /hosting|datacenter|data center|cloud|server|vps|colo/i;
const DC_ORG_EXCLUDE_RX = /cloudflare|akamai|fastly|apple|comcast|verizon|t-mobile|at&t|charter|spectrum|cox|frontier|bezeq|partner|hot-net|cellcom|vodafone|bt |sky|virgin|orange|telekom/i;

// Returns the reason a request counts as "datacenter" (logged as the event detail), or null.
// Location-less traffic — country XX (Cloudflare can't place it) or T1 (Tor) — gets the same policy,
// but only on a real edge cf object: a missing cf (local dev, internal fetches) is never location-less.
export function datacenterReason(cf) {
  if (!cf) return null;
  const asn = Number(cf.asn);
  if (FILTER_ASNS.has(asn)) return null;
  if (asn && DC_ASNS.has(asn)) return { reason: "hosting_asn", asn };
  const org = typeof cf.asOrganization === "string" ? cf.asOrganization : "";
  if (org && DC_ORG_RX.test(org) && !DC_ORG_EXCLUDE_RX.test(org)) return { reason: "hosting_org", as_org: org.slice(0, 200) };
  if ((asn || cf.colo) && (cf.country === "XX" || cf.country === "T1")) return { reason: "no_location", country: cf.country };
  return null;
}
export const isDatacenter = (cf) => !!datacenterReason(cf);

// ─── Search-engine crawlers ───────────────────────────────────────────────────

// Googlebot and Bingbot crawl from Google (15169) and Microsoft (8075) — both datacenter ASNs — and
// they are how people find the catalog. A UA claim alone is spoofable, so a claim is honoured only when
// the IP is inside the engine's published crawler ranges (cached 24h per isolate). If the range list
// can't be fetched, fall back to "UA claim + the engine's own ASN". Cloudflare's own verified-bot
// signal (Bot Management plans) is honoured when present.
const CRAWLERS = [
  { rx: /googlebot|google-inspectiontool|storebot-google/i, asn: 15169, url: "https://developers.google.com/static/search/apis/ipranges/googlebot.json" },
  { rx: /bingbot|msnbot|bingpreview/i, asn: 8075, url: "https://www.bing.com/toolbox/bingbot.json" },
];
const crawlerRanges = new Map(); // url → { at, nets: [[bytes, prefixLen]] | null, p: Promise | null }
const CRAWLER_TTL = 24 * 3600e3;

function parseIp(ip) {
  if (!ip) return null;
  if (ip.includes(".") && !ip.includes(":")) {
    const p = ip.split(".");
    if (p.length !== 4) return null;
    const b = p.map((x) => (/^\d{1,3}$/.test(x) ? +x : 256));
    return b.some((x) => x > 255) ? null : Uint8Array.from(b);
  }
  if (!ip.includes(":")) return null;
  let s = ip.split("%")[0];
  let tail = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const b = parseIp(v4[1]);
    if (!b) return null;
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    s = s.slice(0, -v4[1].length) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const grp = (h) => (h ? h.split(":") : []);
  const head = grp(halves[0]), back = grp(halves[1]);
  const fill = halves.length === 2 ? 8 - head.length - back.length : 0;
  const all = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...back];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  const words = all.map((g) => parseInt(g, 16));
  if (tail.length) words.splice(6, 2, ...tail);
  const out = new Uint8Array(16);
  words.forEach((w, i) => { out[2 * i] = w >> 8; out[2 * i + 1] = w & 255; });
  return out;
}

function inNet(ipBytes, [net, len]) {
  if (ipBytes.length !== net.length) return false;
  let bits = len;
  for (let i = 0; i < net.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 255 : (0xff << (8 - bits)) & 255;
    if ((ipBytes[i] & mask) !== (net[i] & mask)) return false;
  }
  return true;
}

function loadCrawlerRanges(url) {
  const now = _t.now();
  let e = crawlerRanges.get(url);
  if (e && (e.nets || e.p) && now - e.at < CRAWLER_TTL) return e.p || Promise.resolve(e.nets);
  if (e && !e.nets && !e.p && now - e.at < 600e3) return Promise.resolve(null); // failed recently
  e = { at: now, nets: e?.nets || null, p: null };
  crawlerRanges.set(url, e);
  e.p = fetch(url, { signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then((j) => {
      const nets = [];
      for (const p of j.prefixes || []) {
        const cidr = p.ipv4Prefix || p.ipv6Prefix;
        if (!cidr) continue;
        const [a, l] = cidr.split("/");
        const b = parseIp(a);
        if (b) nets.push([b, Number(l)]);
      }
      if (!nets.length) throw new Error("empty");
      e.nets = nets;
      return nets;
    })
    .catch(() => e.nets)
    .finally(() => { e.p = null; e.at = _t.now(); });
  return e.p;
}

async function isVerifiedCrawler(cf, ua, ip) {
  if (cf && (cf.botManagement?.verifiedBot === true || cf.verifiedBotCategory)) return true;
  // No UA claim still counts from the engine's own ASN when the IP is in its published ranges: Bing renders
  // pages with a plain "HeadlessChrome" UA from bingbot IPs.
  const claimed = CRAWLERS.find((x) => x.rx.test(ua));
  const c = claimed || CRAWLERS.find((x) => x.asn === Number(cf?.asn));
  if (!c) return false;
  const ipBytes = parseIp(ip);
  const nets = ipBytes ? await loadCrawlerRanges(c.url) : null;
  if (nets) return nets.some((n) => inNet(ipBytes, n));
  return !!claimed && Number(cf?.asn) === c.asn;
}

// ─── Identity (Supabase ES256 access token) ───────────────────────────────────

const b64uBytes = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64uJson = (s) => JSON.parse(new TextDecoder().decode(b64uBytes(s)));

const JWKS_TTL = 3600e3;
let jwks = { base: "", at: 0, keys: new Map(), p: null, lastRefetch: 0 }; // kid → Promise<CryptoKey>
const tokenCache = new Map(); // jwt → { exp(ms), id: identity|null }

function fetchJwks(base) {
  if (jwks.p) return jwks.p;
  jwks.p = fetch(`${base}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(3000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then((j) => {
      const keys = new Map();
      for (const k of j.keys || []) {
        if (k.kty !== "EC" || k.crv !== "P-256" || !k.kid || (k.alg && k.alg !== "ES256")) continue;
        const pub = { kty: "EC", crv: "P-256", x: k.x, y: k.y, ext: true };
        keys.set(k.kid, crypto.subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
      }
      jwks = { base, at: _t.now(), keys, p: null, lastRefetch: jwks.lastRefetch };
    })
    .catch(() => { jwks.p = null; jwks.at = _t.now() - JWKS_TTL + 30e3; }); // keep old keys, retry in 30s
  return jwks.p;
}

async function keyFor(base, kid) {
  const now = _t.now();
  if (jwks.base !== base) jwks = { base, at: 0, keys: new Map(), p: null, lastRefetch: 0 };
  let fetched = false;
  if (!jwks.at || now - jwks.at > JWKS_TTL) { await fetchJwks(base); fetched = true; }
  if (!fetched && !jwks.keys.has(kid) && now - jwks.lastRefetch > 60e3) {
    // Unknown kid ⇒ the keys may have rotated: refetch once (at most once a minute, so a stream of
    // forged kids can't turn into a JWKS fetch per request).
    jwks.lastRefetch = now;
    await fetchJwks(base);
  }
  const k = jwks.keys.get(kid);
  return k ? k.catch(() => null) : null;
}

function readToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (m && m[1].split(".").length === 3) return m[1];
  const cookie = request.headers.get("Cookie") || "";
  const c = /(?:^|;\s*)sk_at=([^;]+)/.exec(cookie);
  return c ? decodeURIComponent(c[1].trim()) : null;
}

// Returns { userId, email } for a valid token, else null (anonymous). Never throws.
export async function resolveIdentity(request, env) {
  return (await verifyToken(request, env)).id;
}

// { id, unverified }: unverified = a well-formed, unexpired token for this project that could not be checked
// because the signing keys are unavailable (JWKS never loaded / Supabase unreachable). It still counts as
// anonymous everywhere it did before; only the signed-out limits skip it, so an outage can't put a signed-in
// listener on them.
async function verifyToken(request, env) {
  const no = { id: null, unverified: false };
  const token = readToken(request);
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!token || !base) return no;
  const now = _t.now();
  const hit = tokenCache.get(token);
  if (hit) {
    if (hit.exp > now) return { id: hit.id, unverified: false };
    tokenCache.delete(token);
  }
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return no;
    const header = b64uJson(parts[0]);
    const claims = b64uJson(parts[1]);
    if (header.alg !== "ES256" || !header.kid) return no;
    const expMs = Number(claims.exp) * 1000;
    if (!(expMs + 30e3 > now)) return no;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes("authenticated") || claims.iss !== `${base}/auth/v1` || !claims.sub) return no;
    const key = await keyFor(base, header.kid);
    if (!key) return { id: null, unverified: jwks.keys.size === 0 };
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64uBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
    const id = ok ? { userId: String(claims.sub), email: String(claims.email || "").trim().toLowerCase() || null } : null;
    if (tokenCache.size > 2000) tokenCache.clear();
    // Cache good tokens until they expire; cache bad ones briefly so a replayed forgery isn't re-verified.
    tokenCache.set(token, { exp: ok ? expMs + 30e3 : now + 60e3, id });
    return { id, unverified: false };
  } catch {
    return no;
  }
}

// ─── Supabase RPCs ────────────────────────────────────────────────────────────

const supabaseReady = (env) => !!(env.SUPABASE_URL && env.SUPABASE_KEY && env.SEC_TOKEN);

async function rpc(env, name, body, timeoutMs = 4000) {
  const res = await fetch(`${String(env.SUPABASE_URL).replace(/\/+$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_token: env.SEC_TOKEN, ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  return res.json();
}

// security_state: 60s per isolate, stale-while-revalidate, fail open (last good copy; never loaded ⇒ empty).
const STATE_TTL = 60e3;
// Catalog gate + quota as last read from catalog_state. Never read (migration not applied, Supabase down) ⇒ gate
// off and no quota: fail open.
const CATALOG_OFF = { requiresAccount: false, dailyQuota: 0, blockIds: new Set(), blockIp: new Map(), blockUser: new Map() };
const EMPTY_STATE = { allowIps: new Set(), allowEmails: new Set(), banIp: new Map(), banUser: new Map(), catalog: CATALOG_OFF };
let state = { data: EMPTY_STATE, at: 0, loaded: false, p: null, failAt: 0 };

// Ban end time in ms. Permanent bans arrive as Postgres 'infinity'; anything unparseable is treated as
// never-ending too (a ban we can't read must not silently lapse).
const parseUntil = (v) => {
  const t = typeof v === "string" && v.trim().toLowerCase() !== "infinity" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : Infinity;
};

// quota_blocks = active daily-quota bans (security_bans.catalog_only). They block catalog files only, so they
// are kept apart from the site-wide ban maps (security_state lists them as ordinary bans).
function buildCatalog(j) {
  if (!j || typeof j !== "object") return null;
  const q = Number(j.daily_quota);
  const c = { requiresAccount: j.requires_account === true, dailyQuota: Number.isFinite(q) && q > 0 ? Math.floor(q) : 0,
    blockIds: new Set(), blockIp: new Map(), blockUser: new Map() };
  for (const b of Array.isArray(j.quota_blocks) ? j.quota_blocks : []) {
    if (!b || b.id == null) continue;
    const until = parseUntil(b.until);
    c.blockIds.add(String(b.id));
    if (b.ip) c.blockIp.set(String(b.ip), Math.max(until, c.blockIp.get(String(b.ip)) || 0));
    if (b.user_id) c.blockUser.set(String(b.user_id), Math.max(until, c.blockUser.get(String(b.user_id)) || 0));
  }
  return c;
}

function buildState(j, catalog) {
  const s = { allowIps: new Set(), allowEmails: new Set(), banIp: new Map(), banUser: new Map(), catalog: catalog || CATALOG_OFF };
  for (const ip of j?.allow_ips || []) if (ip) s.allowIps.add(String(ip).trim());
  for (const e of j?.allow_emails || []) if (e) s.allowEmails.add(String(e).trim().toLowerCase());
  const quotaIds = s.catalog.blockIds;
  for (const b of j?.bans || []) {
    if (quotaIds && b.id != null && quotaIds.has(String(b.id))) continue; // daily-quota ban: catalog only
    const until = parseUntil(b.until);
    if (b.ip) s.banIp.set(String(b.ip), Math.max(until, s.banIp.get(String(b.ip)) || 0));
    if (b.user_id) s.banUser.set(String(b.user_id), Math.max(until, s.banUser.get(String(b.user_id)) || 0));
  }
  return s;
}

function refreshState(env) {
  if (state.p) return state.p;
  // catalog_state rides along; if only it fails, keep the catalog settings this isolate last had.
  const cat = rpc(env, "catalog_state", {}, 2500).then(buildCatalog, () => null);
  state.p = Promise.all([rpc(env, "security_state", {}, 2500), cat])
    .then(([j, c]) => { state = { data: buildState(j, c || state.data.catalog), at: _t.now(), loaded: true, p: null, failAt: 0 }; })
    .catch(() => { state.p = null; state.failAt = _t.now(); });
  return state.p;
}

async function getState(env, ctx) {
  if (!supabaseReady(env)) return EMPTY_STATE;
  const now = _t.now();
  const fresh = state.loaded && now - state.at < STATE_TTL;
  const backoff = now - state.failAt < 10e3; // don't hammer a down Supabase from every request
  if (!fresh && !backoff) {
    const p = refreshState(env);
    if (state.loaded) ctx?.waitUntil?.(p); // serve the last good copy, refresh in the background
    else await p; // first load in this isolate
  }
  return state.data;
}

// The app learns whether the catalog needs an account from this header on a few Worker responses it fetches
// at boot anyway (no extra request). "<0|1>;<ms the setting was read>": the client keeps the newest reading,
// so a browser-cached response can't roll a newer setting back.
export const CATALOG_GATE_HEADER = "X-SK-Catalog-Gate";
export async function catalogGateValue(env, ctx) {
  try {
    const st = await getState(env, ctx);
    return `${st.catalog.requiresAccount ? 1 : 0};${state.loaded ? state.at : 0}`;
  } catch {
    return "0;0";
  }
}

// ─── Event log (batched, deduped) ─────────────────────────────────────────────

const LOG_DEDUPE_MS = 60e3, LOG_FLUSH_MS = 10e3, LOG_BATCH = 20, LOG_RPC_CAP = 50, LOG_QUEUE_MAX = 500;
let logQ = [];
const logSeen = new Map(); // `${kind}|${key}` → ts
let logTimer = false;
let logFlushing = null;

async function flushLog(env) {
  if (logFlushing) await logFlushing;
  if (!logQ.length) return;
  const batch = logQ.splice(0, LOG_RPC_CAP);
  logFlushing = rpc(env, "security_log", { p_events: batch }).catch(() => {}).finally(() => { logFlushing = null; });
  await logFlushing;
  if (logQ.length >= LOG_BATCH) return flushLog(env);
}

function logEvent(env, ctx, kind, key, ev) {
  if (!supabaseReady(env)) return;
  const now = _t.now();
  const dk = kind + "|" + key;
  const seen = logSeen.get(dk);
  if (seen && now - seen < LOG_DEDUPE_MS) return;
  if (logSeen.size > 5000) for (const [k, t] of logSeen) if (now - t >= LOG_DEDUPE_MS) logSeen.delete(k);
  logSeen.set(dk, now);
  if (logQ.length >= LOG_QUEUE_MAX) return;
  logQ.push({ kind, ...ev });
  if (logQ.length >= LOG_BATCH) {
    ctx?.waitUntil?.(flushLog(env));
  } else if (!logTimer) {
    // First event of a batch: this invocation keeps itself alive ~10s and ships whatever has queued by
    // then, so a quiet isolate can't sit on events indefinitely.
    logTimer = true;
    ctx?.waitUntil?.(_t.sleep(LOG_FLUSH_MS).then(() => { logTimer = false; return flushLog(env); }));
  }
}

// ─── Catalog files: which paths, daily quota counting (batched) ───────────────

const CATALOG_ENTITY_RX = /^\/data\/(artist|album|zemer-playlist)\/[A-Za-z0-9_-]+\.json$/;
// The dataset and the per-entity detail files. zemer-playlist/acapella.json stays a public static file (the
// Acapella filter needs it signed out), so in production it never reaches the Worker.
export const isCatalogPath = (pathname) => pathname === "/data/dataset.json.gz" || CATALOG_ENTITY_RX.test(pathname);

// key → requests since the last flush. Flushed like the event log: ~10s after the first count, or as soon as
// QUOTA_BATCH keys are waiting. A failed flush drops its counts (fail open).
const QUOTA_FLUSH_MS = 10e3, QUOTA_BATCH = 200, QUOTA_MAX_KEYS = 1000; // 1000 = catalog_usage_add's per-call cap
let quotaQ = new Map();
let quotaEmail = new Map();
let quotaTimer = false;
let quotaFlushing = null;

async function flushQuota(env) {
  if (quotaFlushing) await quotaFlushing;
  if (!quotaQ.size) return;
  const counts = Object.fromEntries(quotaQ);
  const emails = Object.fromEntries(quotaEmail);
  quotaQ = new Map();
  quotaEmail = new Map();
  quotaFlushing = rpc(env, "catalog_usage_add", { p_counts: counts, p_emails: emails })
    .then((rows) => {
      // Keys now over quota come back with the ban security_ban gave them: enforce it here at once (other
      // isolates pick it up from security_state within a minute).
      const now = _t.now();
      for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || typeof r.key !== "string" || r.until == null) continue;
        const until = parseUntil(r.until);
        if (until > now) localCatalogBlocks.set(r.key, { until, at: now });
      }
    })
    .catch(() => {})
    .finally(() => { quotaFlushing = null; });
  await quotaFlushing;
}

// Daily-quota blocks this isolate learned from its own flush, before security_state/catalog_state carry them.
// A state read after the flush is authoritative (so an admin's unban takes effect within a minute here too).
const localCatalogBlocks = new Map(); // key → { until, at }

function catalogBlockUntil(st, ip, identity, now) {
  const key = identity ? "u:" + identity.userId : "ip:" + ip;
  let until = identity ? st.catalog.blockUser.get(identity.userId) || 0 : (ip && st.catalog.blockIp.get(ip)) || 0;
  const l = localCatalogBlocks.get(key);
  if (l && l.until > now && !(state.loaded && state.at > l.at)) until = Math.max(until, l.until);
  else if (l) localCatalogBlocks.delete(key);
  return until > now ? until : 0;
}

function countCatalog(env, ctx, key, email) {
  if (!supabaseReady(env)) return;
  if (!quotaQ.has(key) && quotaQ.size >= QUOTA_MAX_KEYS) return;
  quotaQ.set(key, (quotaQ.get(key) || 0) + 1);
  if (email && key.startsWith("u:")) quotaEmail.set(key, email);
  if (quotaQ.size >= QUOTA_BATCH) {
    ctx?.waitUntil?.(flushQuota(env));
  } else if (!quotaTimer) {
    quotaTimer = true;
    ctx?.waitUntil?.(_t.sleep(QUOTA_FLUSH_MS).then(() => { quotaTimer = false; return flushQuota(env); }));
  }
}

// ─── Bans + escalation (isolate memory) ───────────────────────────────────────

const localBans = new Map(); // "ip:<ip>" | "u:<id>" → until ms
const trips = new Map(); // limiter key → [ts]
const lastTrip = new Map(); // limiter key → start of its current trip episode
const TRIP_WINDOW = 600e3, TRIPS_TO_BAN = 3, PROVISIONAL_BAN = 15 * 60e3;

function prune(map, maxAge, now) {
  if (map.size < 5000) return;
  for (const [k, v] of map) {
    const t = Array.isArray(v) ? v[v.length - 1] : v;
    if (now - t > maxAge) map.delete(k);
  }
}

function banUntil(st, ip, identity, now) {
  let until = 0;
  const check = (t) => { if (t && t > now && t > until) until = t; };
  if (ip) { check(st.banIp.get(ip)); check(localBans.get("ip:" + ip)); }
  if (identity) { check(st.banUser.get(identity.userId)); check(localBans.get("u:" + identity.userId)); }
  return until;
}

// A "trip" is one limit-exceeded episode, not every rejected request: further 429s for the same key within
// the tripped limiter's own window belong to the same episode. A flood keeps re-tripping the 10s burst
// limiter (ban after ~30s); a person clicking past the per-minute limit trips at most once a minute, so
// it takes three separate over-limit minutes inside 10 minutes to ban them.
function recordTrip(env, ctx, key, binding, ip, identity, period) {
  const now = _t.now();
  if (now - (lastTrip.get(key) || 0) < (period || 10) * 1000) return;
  lastTrip.set(key, now);
  prune(lastTrip, TRIP_WINDOW, now);
  const list = (trips.get(key) || []).filter((t) => now - t < TRIP_WINDOW);
  list.push(now);
  if (list.length < TRIPS_TO_BAN) { trips.set(key, list); prune(trips, TRIP_WINDOW, now); return; }
  trips.delete(key);
  // Effective immediately with a provisional 15 min; the DB's escalated duration (possibly permanent)
  // replaces it. Neither step ever shortens a longer ban already held for this key.
  const prior = localBans.get(key) > now ? localBans.get(key) : 0;
  localBans.set(key, Math.max(prior, now + PROVISIONAL_BAN));
  prune(localBans, 0, now);
  if (!supabaseReady(env)) return;
  const p = rpc(env, "security_ban", {
    p_ip: identity ? null : ip,
    p_user_id: identity ? identity.userId : null,
    p_email: identity ? identity.email : null,
    p_reason: `auto: ${TRIPS_TO_BAN} rate-limit trips in 10 min (${binding})`,
  })
    .then((r) => {
      if (r && r.until != null) localBans.set(key, Math.max(parseUntil(r.until), prior));
    })
    .catch(() => {});
  ctx?.waitUntil?.(p);
}

// ─── Rate limiters ────────────────────────────────────────────────────────────

const LIMITS = {
  account: [["RL_ACCT_BURST", 10], ["RL_ACCT_MIN", 60]],
  anon: [["RL_ANON_BURST", 10], ["RL_ANON_MIN", 60]],
  dc: [["RL_DC_MIN", 60]],
};
// Requests allowed per tier and window. The exact counter is the RateLimiter Durable Object
// (engine/limiter.mjs); the matching wrangler `ratelimits` bindings are only the fallback when it is absent.
const LIMIT_COUNTS = { RL_ACCT_BURST: 45, RL_ACCT_MIN: 120, RL_ANON_BURST: 15, RL_ANON_MIN: 20, RL_DC_MIN: 10 };
const LIMITER_TIMEOUT = 1500;

// Returns the first tripped [tier, period], or null. Limiter missing / slow / erroring ⇒ not limited.
// opts.skipMinute counts only the burst tier (for requests that must not use up the per-minute budget).
async function checkLimits(env, cls, key, opts) {
  const tiers = LIMITS[cls].filter(([, period]) => !(opts && opts.skipMinute && period === 60));
  if (!tiers.length) return null;
  if (env.LIMITER && typeof env.LIMITER.idFromName === "function") {
    try {
      const stub = env.LIMITER.get(env.LIMITER.idFromName(key));
      const r = await stub.fetch("https://limiter/", {
        method: "POST",
        body: JSON.stringify({ tiers: tiers.map(([b, period]) => [b, LIMIT_COUNTS[b], period]) }),
        signal: AbortSignal.timeout(LIMITER_TIMEOUT),
      });
      const { tripped } = await r.json();
      return tiers.find(([b]) => b === tripped) || null;
    } catch {
      return null;
    }
  }
  const bound = tiers.filter(([b]) => env[b] && typeof env[b].limit === "function");
  if (!bound.length) return null;
  const res = await Promise.all(bound.map(([b]) => env[b].limit({ key }).then((r) => r?.success !== false, () => true)));
  const i = res.indexOf(false);
  return i === -1 ? null : bound[i];
}

// ─── Signed-out limits ────────────────────────────────────────────────────────
//
// Without an account, per client: 5 detail pages (artist / album / playlist) and 1 song start per 7 minutes,
// each window opening at the first use (RateLimiter's anchored windows, distinct ids). Search needs the full
// dataset, which signed-out visitors never get. Over a limit ⇒ 401 {error:"signin_required", kind, resetAt,
// retryAfter}. Allowlisted visitors and verified search crawlers return before this and are never limited.
const ANON_WINDOW = 7 * 60; // seconds
const ANON_LIMITS = { detail: 5, play: 1 };
// The upstream trending playlists Home and For You read through /zp-live at boot — public rows, not a detail.
export const PUBLIC_LIVE_PLAYLISTS = ["auto-trending", "auto-top-50", "auto-acapella-top-50"];
const PUBLIC_LIVE_SET = new Set(PUBLIC_LIVE_PLAYLISTS);
const ENTITY_FILE_RX = /^\/data\/(artist|album|zemer-playlist)\/([A-Za-z0-9_-]+)\.json$/;
// Same id shapes the routes themselves accept (anything else is answered 400 / an empty stub, not a track list).
const ID_ARTIST_TRENDING = /^[A-Za-z0-9_-]{1,64}$/, ID_PLAYLIST = /^[A-Za-z0-9_-]{6,64}$/, ID_ZP_LIVE = /^[A-Za-z0-9_-]{2,60}$/;
const ID_PLAY = /^[A-Za-z0-9_-]{1,64}$/;

// What a request would use up: { kind: "detail", member } | { kind: "play", member } | { kind: "search" } | null.
// member = the entity (or video) id, so loading the same page twice in a window counts once.
export function anonUse(request, url) {
  const p = url.pathname, m = request.method;
  if (p === "/play-start") {
    if (m !== "POST") return null;
    const v = url.searchParams.get("v") || "";
    return { kind: "play", member: ID_PLAY.test(v) ? "v:" + v : null };
  }
  if (m !== "GET" && m !== "HEAD") return null;
  if (p === "/data/dataset.json.gz") return { kind: "search" };
  const f = ENTITY_FILE_RX.exec(p);
  if (f) return f[1] === "zemer-playlist" && f[2] === "acapella" ? null : { kind: "detail", member: f[1] + ":" + f[2] };
  const id = url.searchParams.get("id") || "";
  // An artist page also asks /artist-trending for the same artist: one slot for both.
  if (p === "/artist-trending") return ID_ARTIST_TRENDING.test(id) ? { kind: "detail", member: "artist:" + id } : null;
  if (p === "/playlist") return ID_PLAYLIST.test(id) ? { kind: "detail", member: "playlist:" + id } : null;
  if (p === "/zp-live") return ID_ZP_LIVE.test(id) && !PUBLIC_LIVE_SET.has(id) ? { kind: "detail", member: "zemer-playlist:" + id } : null;
  return null;
}

// ── Which client: IP (IPv6 by /64), the X-Forwarded-For client behind a content-filter proxy, or a device cookie.

const hex4 = (b, i) => ((b[i] << 8) | b[i + 1]).toString(16);
// Canonical key for an address: "ip:1.2.3.4", or "ip6:2001:db8:1:2::/64" (one household's /64 is one client).
// IPv4-mapped IPv6 is the IPv4 address. null when unparseable.
function ipKey(ip) {
  const b = parseIp(String(ip || "").trim());
  return b ? bytesKey(b) : null;
}
function bytesKey(b) {
  if (b.length === 4) return "ip:" + b.join(".");
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return "ip:" + [b[12], b[13], b[14], b[15]].join(".");
  return "ip6:" + [0, 2, 4, 6].map((i) => hex4(b, i)).join(":") + "::/64";
}

const cidr = (s) => { const [a, l] = s.split("/"); return [parseIp(a), Number(l)]; };
// Not a real client address: private, loopback, link-local, CGNAT, documentation, benchmarking, multicast, reserved.
const NON_PUBLIC_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3"].map(cidr);
// Cloudflare's published ranges (cloudflare.com/ips): a Cloudflare address is never the listener.
const CLOUDFLARE_NETS = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
  "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14",
  "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32"].map(cidr);
const GLOBAL_V6 = cidr("2000::/3"), DOC_V6 = cidr("2001:db8::/32"), TEREDO_V6 = cidr("2001::/32"), SIXTOFOUR_V6 = cidr("2002::/16");

function publicClientIp(bytes) {
  let b = bytes;
  if (b.length === 16 && b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) b = b.slice(12);
  if (b.length === 4) { if (NON_PUBLIC_V4.some((n) => inNet(b, n))) return false; }
  else if (!inNet(b, GLOBAL_V6) || inNet(b, DOC_V6) || inNet(b, TEREDO_V6) || inNet(b, SIXTOFOUR_V6)) return false;
  return !CLOUDFLARE_NETS.some((n) => inNet(b, n));
}

// One X-Forwarded-For entry → address bytes. Tolerates "1.2.3.4:5678", "[2001:db8::1]:443", quotes; else null.
function xffEntry(s) {
  let v = String(s || "").trim().replace(/^"|"$/g, "");
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (br) v = br[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.replace(/:\d+$/, "");
  return v.length <= 64 ? parseIp(v) : null;
}
const sameIp = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

// The listener behind a content-filter proxy. Cloudflare appends the address that connected to it (the proxy)
// to any X-Forwarded-For it receives, so the proxy's own entry is last and the one before it is what the proxy
// added: its client. Trusted ONLY for FILTER_ASNS requests (anyone else could write any value), and only when
// that entry is a public address that isn't Cloudflare's or the proxy's. Returns an ipKey, or null.
export function xffClient(xff, connectingIp) {
  if (!xff || xff.length > 1024) return null;
  const parts = xff.split(",");
  if (parts.length < 2) return null;
  const proxy = parseIp(String(connectingIp || "").trim());
  if (!sameIp(xffEntry(parts[parts.length - 1]), proxy)) return null;
  const c = xffEntry(parts[parts.length - 2]);
  if (!c || sameIp(c, proxy) || !publicClientIp(c)) return null;
  return bytesKey(c);
}

// Device cookie: sk_dev=<128-bit random id>.<HMAC-SHA256(id) under a key derived from SEC_TOKEN>. Issued on Worker
// responses to signed-out visitors on content-filter networks that don't carry a valid one; a forged or unsigned
// value is ignored (and replaced).
const DEV_COOKIE = "sk_dev", DEV_MAX_AGE = 365 * 86400;
const DEV_RX = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
let devKey = { token: null, p: null };
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const utf8 = (s) => new TextEncoder().encode(s);
function deviceKey(env) {
  const token = env.SEC_TOKEN ? String(env.SEC_TOKEN) : "";
  if (!token) return null;
  if (devKey.token !== token) {
    const hmac = { name: "HMAC", hash: "SHA-256" };
    const p = crypto.subtle.importKey("raw", utf8(token), hmac, false, ["sign"])
      .then((k) => crypto.subtle.sign("HMAC", k, utf8("sk_dev cookie key v1")))
      .then((raw) => crypto.subtle.importKey("raw", raw, hmac, false, ["sign", "verify"]));
    devKey = { token, p };
    p.catch(() => { if (devKey.p === p) devKey = { token: null, p: null }; });
  }
  return devKey.p;
}
const deviceSeen = new WeakMap(); // request → verified device id | null
async function readDevice(request, env) {
  if (deviceSeen.has(request)) return deviceSeen.get(request);
  let id = null;
  try {
    const m = new RegExp(`(?:^|;\\s*)${DEV_COOKIE}=([^;]+)`).exec(request.headers.get("Cookie") || "");
    const v = m && DEV_RX.exec(m[1].trim());
    const key = v && deviceKey(env);
    if (key && await crypto.subtle.verify("HMAC", await key, b64uBytes(v[2]), utf8("dev:" + v[1]))) id = v[1];
  } catch {}
  deviceSeen.set(request, id);
  return id;
}
async function mintDeviceCookie(env) {
  const key = deviceKey(env);
  if (!key) return null;
  const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const sig = b64u(new Uint8Array(await crypto.subtle.sign("HMAC", await key, utf8("dev:" + id))));
  return `${DEV_COOKIE}=${id}.${sig}; Max-Age=${DEV_MAX_AGE}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
const cookieToSet = new WeakMap(); // request → Set-Cookie value for its response

// Adds the device cookie the gate decided to issue for this request (engine/index.mjs wraps every response).
// The one response that carries it is made `private`, so a shared cache (filter proxies cache) never hands
// one listener's id to another.
export function withDeviceCookie(request, res) {
  const c = cookieToSet.get(request);
  if (!c || !res) return res;
  try {
    const out = new Response(res.body, res);
    out.headers.append("Set-Cookie", c);
    if (!/no-store/i.test(out.headers.get("Cache-Control") || "")) out.headers.set("Cache-Control", "private, no-cache");
    return out;
  } catch {
    return res;
  }
}

// The key a signed-out request is limited under, and how it was found (logged as detail.via).
async function anonClient(request, env, ip, cf) {
  if (FILTER_ASNS.has(Number(cf?.asn))) {
    const x = xffClient(request.headers.get("X-Forwarded-For"), ip);
    if (x) return { key: x, via: "xff" };
    const dev = await readDevice(request, env);
    if (dev) return { key: "dev:" + dev, via: "device" };
  }
  const k = ipKey(ip);
  return k ? { key: k, via: "ip" } : null;
}

// RateLimiter anchored window for this client and kind → { ok, resetAt } | null (no limiter / slow / error: the
// caller lets the request through — an infrastructure problem must never block a real listener).
async function anonCheck(env, clientKey, kind, member) {
  if (!env.LIMITER || typeof env.LIMITER.idFromName !== "function") return null;
  try {
    const stub = env.LIMITER.get(env.LIMITER.idFromName("anon:" + clientKey));
    const r = await stub.fetch("https://limiter/", {
      method: "POST",
      body: JSON.stringify({ anchored: [kind, ANON_LIMITS[kind], ANON_WINDOW, member ?? null] }),
      signal: AbortSignal.timeout(LIMITER_TIMEOUT),
    });
    const a = (await r.json())?.anchored;
    return a && typeof a.ok === "boolean" && Number.isFinite(a.resetAt) ? a : null;
  } catch {
    return null;
  }
}

// ─── Responses ────────────────────────────────────────────────────────────────

const CONTACT_PATH = "/unblock-request";
const HTML_TEXT = {
  banned: ["Access paused", "Too many requests came from your connection, so access is paused for a while."],
  datacenter: ["Sign in to continue", "This connection looks like a server or hosting network rather than a home or mobile one. Sign in to SK Music to continue."],
  rate_limited: ["Slow down a little", "Too many requests in a short time. Please wait a few seconds and try again."],
  account_required: ["Sign in to keep listening", "A free SK Music account is needed to browse and play the catalog."],
  daily_limit: ["Daily browsing limit reached", "This connection or account has opened more of the catalog today than the daily limit allows."],
  signin_required: ["You've reached the limit without an account", "Sign in or create a free account to keep browsing and listening."],
};
const PAGE_CSS = "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px;box-sizing:border-box}main{max-width:460px;width:100%;box-sizing:border-box;background:#1e293b;border-radius:12px;padding:28px}h1{margin:0 0 8px;font-size:20px}h2{margin:20px 0 4px;font-size:16px}p{margin:8px 0}.m{color:#94a3b8;font-size:14px}a{color:#60a5fa}label{display:block;margin:10px 0 4px;font-size:14px;color:#cbd5e1}input,textarea{width:100%;box-sizing:border-box;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px;font:inherit}textarea{min-height:96px;resize:vertical}button{margin-top:12px;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}";
const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · SK Music</title><style>${PAGE_CSS}</style></head><body><main><h1>${title}</h1>${inner}</main></body></html>`;
const wantsHtml = (request) => (request.headers.get("Accept") || "").includes("text/html");

// Plain HTML form (no script) so a blocked person can ask for a review.
const CONTACT_FORM = `<h2>Think this is a mistake?</h2><p class="m">Tell us and we'll review it.</p><form method="post" action="${CONTACT_PATH}"><label for="e">Email (optional, so we can reply)</label><input id="e" name="email" type="email" maxlength="320" autocomplete="email"><label for="msg">Message</label><textarea id="msg" name="message" required maxlength="2000"></textarea><button type="submit">Send</button></form>`;

function blockResponse(request, status, body, retryAfter, extraHeaders) {
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...extraHeaders };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  if (wantsHtml(request)) {
    const [title, msg] = HTML_TEXT[body.error];
    let extra = "";
    if (body.error === "datacenter") extra = `<p><a href="/">Go to SK Music and sign in</a></p>${CONTACT_FORM}`;
    else if (body.error === "banned") extra = (body.permanent
      ? `<p>This block is permanent unless it is lifted after review.</p>`
      : `<p class="m">Try again after ${new Date(body.until).toUTCString()}.</p>`) + CONTACT_FORM;
    else if (body.error === "account_required" || body.error === "signin_required") extra = `<p><a href="/">Go to SK Music and sign in</a></p>`
      + (retryAfter ? `<p class="m">Or try again in ${Math.ceil(retryAfter / 60)} min.</p>` : "");
    else if (body.error === "daily_limit") extra = (body.permanent ? "" : `<p class="m">It opens again ${new Date(body.until).toUTCString()}.</p>`) + CONTACT_FORM;
    else if (retryAfter) extra = `<p class="m">Try again in ${retryAfter} seconds.</p>`;
    headers["Content-Type"] = "text/html; charset=utf-8";
    return new Response(page(title, `<p>${msg}</p>${extra}`), { status, headers });
  }
  return Response.json(body, { status, headers });
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

// Image proxies that a single screen requests dozens of at once (station covers, status avatars/media).
// Counting them would 429 an ordinary page load, so they skip the limiters — bans and the datacenter
// block still apply. Both are edge-cached proxies of public images.
const UNCOUNTED_PATHS = new Set(["/stations/cover", "/statuses/media"]);

// Everything the gate decides on, without consuming a limiter or logging anything.
async function inspect(request, env, ctx) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const cf = request.cf;
  const ua = request.headers.get("User-Agent") || "";
  const [st, tok] = await Promise.all([getState(env, ctx), verifyToken(request, env)]);
  const identity = tok.id;
  const allowed = st.allowIps.has(ip) || !!(identity?.email && st.allowEmails.has(identity.email));
  const who = identity ? "u:" + identity.userId : "ip:" + ip;
  const until = allowed ? 0 : banUntil(st, ip, identity, _t.now());
  const dcWhy = datacenterReason(cf);
  const crawler = async () => ((dcWhy || !identity) ? isVerifiedCrawler(cf, ua, ip) : false);
  return { st, ip, cf, ua, identity, tokenUnverified: tok.unverified, allowed, who, until, dcWhy, crawler };
}

// null = let it through. Search: never (the dataset is account-only). Detail / play: the client's anchored window;
// no answer from the limiter ⇒ through (fail open).
async function anonGate(request, env, ctx, x, use, ev) {
  const client = await anonClient(request, env, x.ip, x.cf);
  let resetAt = 0;
  if (use.kind !== "search") {
    if (!client) return null;
    const a = await anonCheck(env, client.key, use.kind, use.member);
    if (!a || a.ok) return null;
    resetAt = a.resetAt;
  }
  logEvent(env, ctx, "signin_required", x.who + "|" + use.kind, { ...ev, detail: { kind: use.kind, via: client ? client.via : null } });
  if (use.kind === "search") return blockResponse(request, 401, { error: "signin_required", kind: "search", resetAt: null, retryAfter: null });
  const secs = Math.max(1, Math.ceil((resetAt - _t.now()) / 1000));
  return blockResponse(request, 401, { error: "signin_required", kind: use.kind, resetAt: new Date(resetAt).toISOString(), retryAfter: secs }, secs);
}

const banBody = (until) => until === Infinity
  ? { error: "banned", until: "infinity", permanent: true, contact: CONTACT_PATH }
  : { error: "banned", until: new Date(until).toISOString(), permanent: false, contact: CONTACT_PATH };

/** Returns a blocking Response, or null to let the request through. Never throws. */
export async function securityGate(request, env, ctx, url) {
  const pathname = url.pathname;
  if (request.method === "OPTIONS" || pathname === "/robots.txt" || pathname === "/csp-report" || pathname === CONTACT_PATH) return null;
  try {
    const x = await inspect(request, env, ctx);
    if (x.allowed) return null;
    const { ip, cf, ua, identity, who, dcWhy } = x;
    const ev = {
      ip: ip || null, user_id: identity?.userId || null, email: identity?.email || null, asn: Number(cf?.asn) || null,
      as_org: typeof cf?.asOrganization === "string" ? cf.asOrganization.slice(0, 200) : null,
      path: (pathname + url.search).slice(0, 300), ua: ua.slice(0, 300) || null, detail: null,
    };

    if (x.until) {
      logEvent(env, ctx, "banned_hit", who, ev);
      return blockResponse(request, 403, banBody(x.until));
    }
    if (await x.crawler()) return null;
    if (dcWhy && !identity) {
      logEvent(env, ctx, "datacenter_block", who, { ...ev, detail: dcWhy });
      return blockResponse(request, 403, { error: "datacenter", signIn: true, contact: CONTACT_PATH });
    }
    // Signed out behind a content-filter proxy without a valid device cookie: issue one with this response.
    if (!identity && FILTER_ASNS.has(Number(cf?.asn)) && !(await readDevice(request, env))) {
      const c = await mintDeviceCookie(env);
      if (c) cookieToSet.set(request, c);
    }

    // Catalog files (GET/HEAD): account gate, burst limiter only, daily quota. Allowlisted visitors and verified
    // search crawlers returned above, so they are never gated or counted.
    const catalog = (request.method === "GET" || request.method === "HEAD") && isCatalogPath(pathname);
    // What a signed-out request would use up (detail page / song start / the search dataset); null when signed in.
    const use = identity ? null : anonUse(request, url);
    if ((catalog || use) && !identity && x.st.catalog.requiresAccount) {
      logEvent(env, ctx, "account_required", who, ev);
      return blockResponse(request, 401, { error: "account_required", signIn: true }, 0,
        { [CATALOG_GATE_HEADER]: `1;${state.loaded ? state.at : 0}` });
    }
    // Over today's catalog quota: catalog files only, until the next 00:00 UTC (or the ban's end). Not logged
    // per hit — catalog_usage_add wrote one quota_exceeded event for the ban.
    const qUntil = catalog ? catalogBlockUntil(x.st, ip, identity, _t.now()) : 0;
    if (qUntil) {
      const perm = qUntil === Infinity, secs = perm ? 0 : Math.max(1, Math.ceil((qUntil - _t.now()) / 1000));
      return blockResponse(request, 429, {
        error: "daily_limit", until: perm ? "infinity" : new Date(qUntil).toISOString(), permanent: perm,
        signIn: !identity, contact: CONTACT_PATH, ...(perm ? {} : { retryAfter: secs }),
      }, secs);
    }

    if (UNCOUNTED_PATHS.has(pathname)) return null;
    // No attributable key (local dev); production always sets CF-Connecting-IP. The dataset stays account-only.
    if (!identity && !ip) return use && use.kind === "search" && !x.tokenUnverified ? anonGate(request, env, ctx, x, use, ev) : null;
    const cls = identity ? (dcWhy ? "dc" : "account") : "anon";
    // A person opening artists quickly also spends 1–2 API calls per page, so catalog files skip the per-minute
    // tier; the daily quota is the slow-scraper control.
    const tripped = await checkLimits(env, cls, who, catalog ? { skipMinute: true } : undefined);
    if (!tripped) {
      // Signed-out limits. A token we couldn't check (signing keys unavailable) is not held to them.
      if (use && !x.tokenUnverified) {
        const denied = await anonGate(request, env, ctx, x, use, ev);
        if (denied) return denied;
      }
      // Quota key: the account, else the IP — except content-filter proxies (FILTER_ASNS), whose IPs carry
      // many listeners each.
      if (catalog && x.st.catalog.dailyQuota > 0 && (identity || !FILTER_ASNS.has(Number(cf?.asn))))
        countCatalog(env, ctx, who, identity?.email || null);
      return null;
    }
    const [binding, period] = tripped;
    logEvent(env, ctx, "rate_limited", who, { ...ev, detail: { limiter: binding, class: cls } });
    recordTrip(env, ctx, who, binding, ip, identity, period);
    return blockResponse(request, 429, { error: "rate_limited", retryAfter: period }, period);
  } catch {
    return null; // fail open: a bug or infrastructure error here must never take the site down
  }
}

// ─── POST /unblock-request ────────────────────────────────────────────────────

const CONTACT_MAX_BYTES = 8192;
// Same rule as security_contact in the DB (which stays authoritative).
const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function readCapped(request, cap) {
  const len = request.headers.get("Content-Length");
  if (len != null && !(Number(len) <= cap)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

const CONTACT_ERRORS = {
  limit: ["Too many messages", "<p>We've already received several messages from this connection. Please try again later.</p>"],
  unavailable: ["Couldn't send right now", "<p>Something went wrong on our side. Please try again in a few minutes.</p>"],
  invalid_message: ["Couldn't send", "<p>Please write a message (up to 2000 characters), then go back and send it again.</p>"],
  invalid_email: ["Couldn't send", "<p>That email doesn't look right — leave it blank or fix it, then go back and send again.</p>"],
  too_large: ["Couldn't send", "<p>That message is too long. Please shorten it and try again.</p>"],
  invalid: ["Couldn't send", "<p>Please go back and check the form, then try again.</p>"],
};

function contactResponse(request, status, body, extraHeaders = {}) {
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...extraHeaders };
  if (!wantsHtml(request)) return Response.json(body, { status, headers });
  const msg = body.ok
    ? ["Thanks — we'll review it", "<p>Your message was sent. If you left an email address we'll reply there.</p>"]
    : CONTACT_ERRORS[body.reason] || CONTACT_ERRORS.invalid;
  headers["Content-Type"] = "text/html; charset=utf-8";
  return new Response(page(msg[0], msg[1] + `<p><a href="/">Back to SK Music</a></p>`), { status, headers });
}

/** POST /unblock-request — exempt from bans and the datacenter block; its own 3/min/IP limiter. */
export async function handleUnblockRequest(request, env, ctx) {
  if (request.method !== "POST") return contactResponse(request, 405, { ok: false, reason: "method" }, { Allow: "POST" });
  const ip = request.headers.get("CF-Connecting-IP") || "";
  try {
    const rl = env.RL_CONTACT;
    if (ip && rl && typeof rl.limit === "function") {
      const r = await Promise.resolve().then(() => rl.limit({ key: "ip:" + ip })).catch(() => null);
      if (r && r.success === false) return contactResponse(request, 429, { ok: false, reason: "limit" }, { "Retry-After": "60" });
    }
    const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (type !== "application/x-www-form-urlencoded" && type !== "application/json")
      return contactResponse(request, 415, { ok: false, reason: "content_type" });
    const text = await readCapped(request, CONTACT_MAX_BYTES);
    if (text == null) return contactResponse(request, 413, { ok: false, reason: "too_large" });
    let email = "", message = "";
    if (type === "application/json") {
      let j;
      try { j = JSON.parse(text); } catch { return contactResponse(request, 400, { ok: false, reason: "invalid" }); }
      if (!j || typeof j !== "object") return contactResponse(request, 400, { ok: false, reason: "invalid" });
      email = typeof j.email === "string" ? j.email : "";
      message = typeof j.message === "string" ? j.message : "";
    } else {
      const f = new URLSearchParams(text);
      email = f.get("email") || "";
      message = f.get("message") || "";
    }
    email = email.trim().toLowerCase();
    message = message.trim();
    if (!message || message.length > 2000) return contactResponse(request, 400, { ok: false, reason: "invalid_message" });
    if (email && (email.length > 320 || !EMAIL_RX.test(email))) return contactResponse(request, 400, { ok: false, reason: "invalid_email" });
    if (!supabaseReady(env)) return contactResponse(request, 503, { ok: false, reason: "unavailable" });

    // block_reason = what the gate would answer this request with right now (without consuming a
    // limiter): recently rate-limited counts as "rate_limited".
    const x = await inspect(request, env, ctx);
    const blockReason = x.allowed ? "none"
      : x.until ? "banned"
      : x.dcWhy && !x.identity && !(await x.crawler()) ? "datacenter"
      : _t.now() - (lastTrip.get(x.who) ?? -Infinity) < 60e3 ? "rate_limited"
      : "none";
    let r;
    try {
      r = await rpc(env, "security_contact", {
        p_ip: ip || null,
        p_user_id: x.identity?.userId || null,
        p_email: email || x.identity?.email || null,
        p_message: message,
        p_block_reason: blockReason,
      });
    } catch {
      return contactResponse(request, 503, { ok: false, reason: "unavailable" });
    }
    if (r && r.ok === true) return contactResponse(request, 200, { ok: true });
    const reason = typeof r?.reason === "string" ? r.reason : "invalid";
    return contactResponse(request, reason === "limit" ? 429 : 400, { ok: false, reason });
  } catch {
    return contactResponse(request, 503, { ok: false, reason: "unavailable" });
  }
}

// Test seam: reset all isolate memory between scenarios.
export function _resetSecurityState() {
  state = { data: EMPTY_STATE, at: 0, loaded: false, p: null, failAt: 0 };
  jwks = { base: "", at: 0, keys: new Map(), p: null, lastRefetch: 0 };
  tokenCache.clear(); logQ = []; logSeen.clear(); logTimer = false; logFlushing = null;
  localBans.clear(); localCatalogBlocks.clear(); trips.clear(); lastTrip.clear(); crawlerRanges.clear();
  quotaQ = new Map(); quotaEmail = new Map(); quotaTimer = false; quotaFlushing = null;
  devKey = { token: null, p: null };
}
