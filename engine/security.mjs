/**
 * Anti-scraping / abuse gate for the Worker's own routes (static assets never reach the Worker).
 *
 * Per request: resolve IP + signed-in identity (Supabase ES256 JWT from the `sk_at` cookie or a Bearer
 * header) + datacenter flag, then allowlist → ban → datacenter block → rate limit → escalation.
 * Rate limiting and datacenter blocking need only the `ratelimit` bindings; allowlist, bans and event
 * logging need Supabase (SUPABASE_URL / SUPABASE_KEY / SEC_TOKEN) and fail OPEN when it is unreachable.
 * Contract: security_state / security_log / security_ban RPCs (supabase/), bindings in wrangler.jsonc.
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
]);
const DC_ORG_RX = /hosting|datacenter|data center|cloud|server|vps|colo/i;
const DC_ORG_EXCLUDE_RX = /cloudflare|akamai|fastly|apple|comcast|verizon|t-mobile|at&t|charter|spectrum|cox|frontier|bezeq|partner|hot-net|cellcom|vodafone|bt |sky|virgin|orange|telekom/i;

// Returns the reason a request counts as "datacenter" (logged as the event detail), or null.
// Location-less traffic — country XX (Cloudflare can't place it) or T1 (Tor) — gets the same policy,
// but only on a real edge cf object: a missing cf (local dev, internal fetches) is never location-less.
export function datacenterReason(cf) {
  if (!cf) return null;
  const asn = Number(cf.asn);
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
  const c = CRAWLERS.find((x) => x.rx.test(ua));
  if (!c) return false;
  const ipBytes = parseIp(ip);
  const nets = ipBytes ? await loadCrawlerRanges(c.url) : null;
  if (nets) return nets.some((n) => inNet(ipBytes, n));
  return Number(cf?.asn) === c.asn;
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
  const token = readToken(request);
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!token || !base) return null;
  const now = _t.now();
  const hit = tokenCache.get(token);
  if (hit) {
    if (hit.exp > now) return hit.id;
    tokenCache.delete(token);
  }
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = b64uJson(parts[0]);
    const claims = b64uJson(parts[1]);
    if (header.alg !== "ES256" || !header.kid) return null;
    const expMs = Number(claims.exp) * 1000;
    if (!(expMs + 30e3 > now)) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes("authenticated") || claims.iss !== `${base}/auth/v1` || !claims.sub) return null;
    const key = await keyFor(base, header.kid);
    if (!key) return null;
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
    return id;
  } catch {
    return null;
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
const EMPTY_STATE = { allowIps: new Set(), allowEmails: new Set(), banIp: new Map(), banUser: new Map() };
let state = { data: EMPTY_STATE, at: 0, loaded: false, p: null, failAt: 0 };

// Ban end time in ms. Permanent bans arrive as Postgres 'infinity'; anything unparseable is treated as
// never-ending too (a ban we can't read must not silently lapse).
const parseUntil = (v) => {
  const t = typeof v === "string" && v.trim().toLowerCase() !== "infinity" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : Infinity;
};

function buildState(j) {
  const s = { allowIps: new Set(), allowEmails: new Set(), banIp: new Map(), banUser: new Map() };
  for (const ip of j?.allow_ips || []) if (ip) s.allowIps.add(String(ip).trim());
  for (const e of j?.allow_emails || []) if (e) s.allowEmails.add(String(e).trim().toLowerCase());
  for (const b of j?.bans || []) {
    const until = parseUntil(b.until);
    if (b.ip) s.banIp.set(String(b.ip), Math.max(until, s.banIp.get(String(b.ip)) || 0));
    if (b.user_id) s.banUser.set(String(b.user_id), Math.max(until, s.banUser.get(String(b.user_id)) || 0));
  }
  return s;
}

function refreshState(env) {
  if (state.p) return state.p;
  state.p = rpc(env, "security_state", {}, 2500)
    .then((j) => { state = { data: buildState(j), at: _t.now(), loaded: true, p: null, failAt: 0 }; })
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

// A "trip" is one limit-exceeded episode, not every rejected request: further 429s for the same key
// within 10s (from either limiter — a flood that trips the burst limiter usually trips the minute one
// too) belong to the same episode. Sustained hammering therefore trips once per 10s (ban after ~30s),
// while one over-eager page load trips once.
const TRIP_EPISODE = 10e3;
function recordTrip(env, ctx, key, binding, ip, identity) {
  const now = _t.now();
  if (now - (lastTrip.get(key) || 0) < TRIP_EPISODE) return;
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

// Returns the first tripped [binding, period], or null. Missing binding / limiter error ⇒ not limited.
async function checkLimits(env, cls, key) {
  const tiers = LIMITS[cls].filter(([b]) => env[b] && typeof env[b].limit === "function");
  if (!tiers.length) return null;
  const res = await Promise.all(tiers.map(([b]) => env[b].limit({ key }).then((r) => r?.success !== false, () => true)));
  const i = res.indexOf(false);
  return i === -1 ? null : tiers[i];
}

// ─── Responses ────────────────────────────────────────────────────────────────

const CONTACT_PATH = "/unblock-request";
const HTML_TEXT = {
  banned: ["Access paused", "Too many requests came from your connection, so access is paused for a while."],
  datacenter: ["Sign in to continue", "This connection looks like a server or hosting network rather than a home or mobile one. Sign in to SK Music to continue."],
  rate_limited: ["Slow down a little", "Too many requests in a short time. Please wait a few seconds and try again."],
};
const PAGE_CSS = "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px;box-sizing:border-box}main{max-width:460px;width:100%;box-sizing:border-box;background:#1e293b;border-radius:12px;padding:28px}h1{margin:0 0 8px;font-size:20px}h2{margin:20px 0 4px;font-size:16px}p{margin:8px 0}.m{color:#94a3b8;font-size:14px}a{color:#60a5fa}label{display:block;margin:10px 0 4px;font-size:14px;color:#cbd5e1}input,textarea{width:100%;box-sizing:border-box;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px;font:inherit}textarea{min-height:96px;resize:vertical}button{margin-top:12px;background:#2563eb;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}";
const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · SK Music</title><style>${PAGE_CSS}</style></head><body><main><h1>${title}</h1>${inner}</main></body></html>`;
const wantsHtml = (request) => (request.headers.get("Accept") || "").includes("text/html");

// Plain HTML form (no script) so a blocked person can ask for a review.
const CONTACT_FORM = `<h2>Think this is a mistake?</h2><p class="m">Tell us and we'll review it.</p><form method="post" action="${CONTACT_PATH}"><label for="e">Email (optional, so we can reply)</label><input id="e" name="email" type="email" maxlength="320" autocomplete="email"><label for="msg">Message</label><textarea id="msg" name="message" required maxlength="2000"></textarea><button type="submit">Send</button></form>`;

function blockResponse(request, status, body, retryAfter) {
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  if (wantsHtml(request)) {
    const [title, msg] = HTML_TEXT[body.error];
    let extra = "";
    if (body.error === "datacenter") extra = `<p><a href="/">Go to SK Music and sign in</a></p>${CONTACT_FORM}`;
    else if (body.error === "banned") extra = (body.permanent
      ? `<p>This block is permanent unless it is lifted after review.</p>`
      : `<p class="m">Try again after ${new Date(body.until).toUTCString()}.</p>`) + CONTACT_FORM;
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
  const [st, identity] = await Promise.all([getState(env, ctx), resolveIdentity(request, env)]);
  const allowed = st.allowIps.has(ip) || !!(identity?.email && st.allowEmails.has(identity.email));
  const who = identity ? "u:" + identity.userId : "ip:" + ip;
  const until = allowed ? 0 : banUntil(st, ip, identity, _t.now());
  const dcWhy = datacenterReason(cf);
  const crawler = async () => ((dcWhy || !identity) ? isVerifiedCrawler(cf, ua, ip) : false);
  return { ip, cf, ua, identity, allowed, who, until, dcWhy, crawler };
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

    if (UNCOUNTED_PATHS.has(pathname)) return null;
    if (!identity && !ip) return null; // no attributable key (local dev); production always sets CF-Connecting-IP
    const cls = identity ? (dcWhy ? "dc" : "account") : "anon";
    const tripped = await checkLimits(env, cls, who);
    if (!tripped) return null;
    const [binding, period] = tripped;
    logEvent(env, ctx, "rate_limited", who, { ...ev, detail: { limiter: binding, class: cls } });
    recordTrip(env, ctx, who, binding, ip, identity);
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
  localBans.clear(); trips.clear(); lastTrip.clear(); crawlerRanges.clear();
}
