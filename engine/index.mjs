/**
 * SK Music edge Worker.
 *
 * Owns live routes (/playlist, /zp-live, /trending, /a) and server-side
 * Open Graph injection for shareable deep links and named tab routes.
 * Static assets are served via env.ASSETS; KV page overrides via env.PAGES.
 */

// YouTube Music internal API base + context payload used for every browse call.
const YTM_BASE = "https://music.youtube.com/youtubei/v1";
const YTM_CTX = {
  client: { clientName: "WEB_REMIX", clientVersion: "1.20260213.01.00", hl: "en", gl: "US" },
};

// ─── HTML escaping ────────────────────────────────────────────────────────────

// Escape the four XML-dangerous characters so values are safe inside tag attributes.
const escAttr = (v) =>
  String(v == null ? "" : v).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );

// ─── Open Graph / Twitter Card tag generation ─────────────────────────────────

// Assemble the full OG + Twitter Card meta tag string from a descriptor object.
// image and type are optional; title and description are always emitted.
// schema.org JSON-LD for Google rich results. `<` is escaped so the JSON can never break out of the
// <script>. Returns "" for unknown/empty types so callers can append unconditionally.
function jsonLdTag({ type, title, image, artist, url }) {
  const T = { "music.song": "MusicRecording", profile: "MusicGroup", "music.album": "MusicAlbum", "music.playlist": "MusicPlaylist" }[type];
  if (!T || !title) return "";
  const o = { "@context": "https://schema.org", "@type": T, name: title };
  if (url) o.url = url;
  if (image) o.image = image;
  if (artist && (T === "MusicRecording" || T === "MusicAlbum")) o.byArtist = { "@type": "MusicGroup", name: artist };
  return `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
}

function buildMetaTags({ title, description, image, type, artist, url }) {
  const parts = [];
  if (type) parts.push(`<meta property="og:type" content="${escAttr(type)}">`);
  parts.push(
    `<meta property="og:title" content="${escAttr(title)}">`,
    `<meta name="twitter:title" content="${escAttr(title)}">`
  );
  parts.push(
    `<meta property="og:description" content="${escAttr(description)}">`,
    `<meta name="twitter:description" content="${escAttr(description)}">`
  );
  if (image) {
    parts.push(
      `<meta property="og:image" content="${escAttr(image)}">`,
      `<meta name="twitter:image" content="${escAttr(image)}">`
    );
  }
  const ld = jsonLdTag({ type, title, image, artist, url });
  if (ld) parts.push(ld);
  return parts.join("");
}

// Generic fallback used when no entity-specific data can be resolved.
const genericPreviewBlock = () =>
  buildMetaTags({
    title: "SK Music",
    description: "Kosher music, by construction — a whitelisted catalog of Jewish music.",
  });

// ─── Per-tab static route previews ───────────────────────────────────────────

// Maps a lowercase pathname to the { title, description } injected into the app shell.
// "/" keeps whatever the app shell bakes in; only named routes need entries here.
// Deep-link routes (/song/:id, /artists/:id, …) are handled separately below.
const ROUTE_PREVIEWS = {
  "/foryou": {
    title: "For You | SK Music",
    description:
      "Personalized picks — trending songs and artists, fresh releases, and recommendations from the whitelisted catalog of Jewish music.",
  },
  "/search": {
    title: "Search | SK Music",
    description:
      "Search the whitelisted catalog of Jewish music — songs, artists, albums, and playlists.",
  },
  "/artists": {
    title: "Artists | SK Music",
    description: "Browse every artist in the whitelisted catalog of Jewish music.",
  },
  "/playlists": {
    title: "Playlists | SK Music",
    description:
      "Curated playlists — trending, top songs, and themed collections of Jewish music.",
  },
  "/podcasts": {
    title: "Podcasts | SK Music",
    description: "Podcasts and spoken-word audio from the whitelisted catalog.",
  },
  "/kidzone": {
    title: "Kid Zone | SK Music",
    description:
      "Kid-friendly Jewish music — a curated, whitelisted catalog just for kids, filtered by construction.",
  },
  "/library": {
    title: "Library | SK Music",
    description: "Your recently played and saved music.",
  },
  "/about": {
    title: "About | SK Music",
    description:
      "About SK Music — a fast, kosher, filtered YouTube music client built on the Zemer catalog.",
  },
};

// ─── App-shell OG injection ───────────────────────────────────────────────────

// Module-level cache for the compact song OG map (videoId → [title, artist]).
// Populated on first use; survives across requests within one isolate lifetime.
let songOgCache = null;

// Resolve entity-specific preview data for a deep link.
// Returns { title: string|null, tags: string } — title for the <title> override,
// tags for the <!--OG-->…<!--/OG--> slot.
async function resolveEntityPreview(env, baseUrl, request, entityType, entityId) {
  // Fetch a data file through ASSETS so it inherits the right origin and request headers.
  const fetchDataFile = (path) =>
    env.ASSETS.fetch(new Request(new URL(path, baseUrl), request));

  try {
    if (entityType === "song") {
      // The song map is a compact flat blob — cache it in the isolate after the first fetch.
      if (!songOgCache) {
        const res = await fetchDataFile("/data/og.json");
        if (res.ok) songOgCache = await res.json();
      }
      const entry = songOgCache && songOgCache[entityId];
      if (entry) {
        const [songTitle, artist] = entry;
        return {
          title: songTitle,
          tags: buildMetaTags({
            title: songTitle,
            description: `${artist} · SK Music`,
            image: `https://i.ytimg.com/vi/${entityId}/hqdefault.jpg`,
            type: "music.song",
            artist,
            url: request.url,
          }),
        };
      }
    } else if (entityType === "artists") {
      const res = await fetchDataFile(`/data/artist/${entityId}.json`);
      if (res.ok) {
        const data = await res.json();
        if (data.artist) {
          return {
            title: data.artist.name,
            tags: buildMetaTags({
              title: data.artist.name,
              description: "Artist · SK Music",
              image: data.artist.thumbnail,
              type: "profile",
              url: request.url,
            }),
          };
        }
      }
    } else if (entityType === "albums") {
      const res = await fetchDataFile(`/data/album/${entityId}.json`);
      if (res.ok) {
        const data = await res.json();
        if (data.album) {
          return {
            title: data.album.title,
            tags: buildMetaTags({
              title: data.album.title,
              description: `${data.album.artist} · SK Music`,
              image: data.album.thumbnail,
              type: "music.album",
              artist: data.album.artist,
              url: request.url,
            }),
          };
        }
      }
    } else if (entityType === "zemer-playlists") {
      const res = await fetchDataFile(`/data/zemer-playlist/${entityId}.json`);
      if (res.ok) {
        const data = await res.json();
        if (data.playlist) {
          return {
            title: data.playlist.title,
            tags: buildMetaTags({
              title: data.playlist.title,
              description: "Curated Playlist · SK Music",
              image: data.playlist.thumbnail
                ? new URL(data.playlist.thumbnail, baseUrl).toString()
                : null,
              type: "music.playlist",
              url: request.url,
            }),
          };
        }
      }
    }
  } catch {
    // Any network or parse failure falls through to the generic block.
  }

  return { title: null, tags: genericPreviewBlock() };
}

// Fetch the SPA shell, swap the <!--OG-->…<!--/OG--> slot with entity-specific tags,
// and optionally replace <title>SK Music</title> with the entity name.
// Uses a function replacer so a '$' in a title is treated as a literal character.
async function renderDeepLinkShell(request, env, baseUrl, entityType, entityId) {
  const shell = await env.ASSETS.fetch(new Request(new URL("/", baseUrl), request));
  const { title, tags } = await resolveEntityPreview(
    env, baseUrl, request, entityType, entityId
  );
  let html = (await shell.text()).replace(/<!--OG-->[\s\S]*?<!--\/OG-->/, () => tags);
  if (title) {
    html = html.replace(
      "<title>SK Music</title>",
      () => `<title>${escAttr(title)} | SK Music</title>`
    );
  }
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Inject a static per-tab preview (title + og.png) into the SPA shell.
async function renderTabShell(request, env, baseUrl, preview) {
  const shell = await env.ASSETS.fetch(new Request(new URL("/", baseUrl), request));
  const tags = buildMetaTags({
    title: preview.title,
    description: preview.description,
    image: new URL("/assets/og.png", baseUrl).toString(),
  });
  const html = (await shell.text())
    .replace(/<!--OG-->[\s\S]*?<!--\/OG-->/, () => tags)
    .replace("<title>SK Music</title>", () => `<title>${escAttr(preview.title)}</title>`);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ─── YouTube Music browse ─────────────────────────────────────────────────────

// POST to the YTM internal browse endpoint. Returns parsed JSON or null on any failure.
async function ytBrowse(payload) {
  const res = await fetch(`${YTM_BASE}/browse?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": "67",
      "X-YouTube-Client-Version": YTM_CTX.client.clientVersion,
      "X-Origin": "https://music.youtube.com",
      Origin: "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; rv:140.0) Gecko/20100101 Firefox/140.0",
    },
    body: JSON.stringify({ context: YTM_CTX, ...payload }),
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Playlist track parsing ───────────────────────────────────────────────────

// Pull the text runs from a specific flex column of a list-item renderer.
const getFlexRuns = (row, col) =>
  row?.flexColumns?.[col]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;

// Extract a normalized track object from a raw musicResponsiveListItemRenderer.
// Returns null if the minimum required fields (videoId + title) are missing.
function extractTrack(row) {
  const videoId =
    row?.playlistItemData?.videoId ||
    getFlexRuns(row, 0)?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
  const title = getFlexRuns(row, 0)?.[0]?.text;
  if (!videoId || !title) return null;

  const thumbs = row?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  const explicit = (row.badges || []).some(
    (b) => b.musicInlineBadgeRenderer?.icon?.iconType === "MUSIC_EXPLICIT_BADGE"
  );
  // First non-separator text run in flex col 1 is the primary artist display name.
  const artist =
    (getFlexRuns(row, 1) || [])
      .map((x) => x.text)
      .filter((t) => t && t !== " • " && t.trim() !== "•")[0] || "";

  return {
    videoId,
    title,
    artist,
    explicit,
    thumbnail: thumbs ? thumbs[thumbs.length - 1].url : null,
  };
}

// Recursively collect every musicResponsiveListItemRenderer from a YTM response tree.
// Recursive traversal is intentional — the exact shelf/layout path varies across playlists.
function gatherListItems(node, acc) {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const child of node) gatherListItems(child, acc);
    return acc;
  }
  if (node.musicResponsiveListItemRenderer) acc.push(node.musicResponsiveListItemRenderer);
  for (const key in node) {
    if (key !== "musicResponsiveListItemRenderer") gatherListItems(node[key], acc);
  }
  return acc;
}

// Find the first continuation token anywhere in a YTM response tree.
function extractContinuationToken(node) {
  if (!node || typeof node !== "object") return null;
  const token =
    node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
    node.nextContinuationData?.continuation;
  if (token) return token;
  if (Array.isArray(node)) {
    for (const child of node) {
      const t = extractContinuationToken(child);
      if (t) return t;
    }
    return null;
  }
  for (const key in node) {
    const t = extractContinuationToken(node[key]);
    if (t) return t;
  }
  return null;
}

// Collect deduplicated tracks from a single browse response page.
// Returns the next continuation token, or null if there are no more pages.
function processBrowsePage(json, seenIds, trackList) {
  for (const row of gatherListItems(json, [])) {
    const track = extractTrack(row);
    if (track && !seenIds.has(track.videoId)) {
      seenIds.add(track.videoId);
      trackList.push(track);
    }
  }
  return extractContinuationToken(json);
}

// Pull the playlist display title from the header of the first browse response.
function extractPlaylistTitle(json) {
  const header =
    json?.header?.musicDetailHeaderRenderer ||
    json?.header?.musicEditablePlaylistDetailHeaderRenderer?.header?.musicDetailHeaderRenderer;
  return header?.title?.runs?.[0]?.text || null;
}

// ─── /playlist handler ────────────────────────────────────────────────────────

async function servePlaylist(url, ctx) {
  const id = url.searchParams.get("id") || "";

  // Return a safe stub on bad or missing IDs — the client degrades gracefully on this shape.
  const stub = (note) =>
    Response.json(
      {
        playlist: { id, title: "Playlist", artist: "", thumbnail: null },
        tracks: [],
        total: 0,
        note: note || "playlist contents unavailable",
      },
      { headers: { "Cache-Control": "no-store" } }
    );

  // YouTube playlist ids are base64url and bounded (PL… ~34, OLAK5uy_… ~41, RD… mixes, etc.); cap the
  // length so the route can't be handed arbitrary/oversized junk. Restricting to a known-id allowlist is
  // too risky here — the app feeds this route corpus-sourced ids of many shapes (featured/followed
  // playlists, album playlistIds, search results) — so we tighten the shape/method rather than the set.
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return stub("invalid playlist id");

  // Edge cache is shared across users — most requests skip the ~700 ms upstream round-trip.
  const edgeCache = caches.default;
  const cacheKey = new Request(`https://sk/playlist?id=${id}`);
  const cached = await edgeCache.match(cacheKey);
  if (cached) return cached;

  try {
    const firstPage = await ytBrowse({ browseId: "VL" + id });
    if (!firstPage) return stub();

    const seen = new Set();
    const tracks = [];
    let token = processBrowsePage(firstPage, seen, tracks);

    // Follow continuation pages up to 6 times, capping at 500 tracks.
    for (let guard = 0; token && tracks.length < 500 && guard < 6; guard++) {
      const nextPage = await ytBrowse({ continuation: token });
      if (!nextPage) break;
      const nextToken = processBrowsePage(nextPage, seen, tracks);
      token = nextToken === token ? null : nextToken; // repeated token → API is stuck, bail
    }

    const response = Response.json(
      {
        playlist: {
          id,
          title: extractPlaylistTitle(firstPage) || "Playlist",
          artist: "",
          thumbnail: null,
        },
        tracks,
        total: tracks.length,
      },
      { headers: { "Cache-Control": "public, max-age=1800" } }
    );

    // Only cache non-empty results — never cache a failed or empty parse.
    if (ctx && tracks.length > 0) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
    return response;
  } catch {
    return stub();
  }
}

// ─── Analytics (/a) ──────────────────────────────────────────────────────────

// Classify browser, OS, and device category from a raw User-Agent string.
function detectClient(uaString) {
  const ua = uaString || "";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /CriOS/.test(ua) ? "Chrome iOS"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Other";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Other";
  const device =
    /iPad|Tablet/.test(ua) ? "tablet"
    : /Mobi|Android|iPhone/.test(ua) ? "mobile"
    : "desktop";
  return { browser, os, device };
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bulk-insert event rows into Supabase. If a 400 comes back and any rows carry
// a `screen` field (not yet in older schemas), fold it into meta and retry so
// no data is lost during a schema migration window.
async function persistEvents(env, rows) {
  const endpoint = `${env.SUPABASE_URL}/rest/v1/${env.SUPABASE_TABLE || "analytics"}`;
  const headers = {
    "Content-Type": "application/json",
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${env.SUPABASE_KEY}`,
    Prefer: "return=minimal",
  };

  let result = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(rows),
  }).catch(() => null);

  // Schema-migration tolerance: a column the deployed DB doesn't have yet 400s the whole batch.
  // Fold `screen` into meta and drop `user_id` entirely, then retry, so analytics keeps flowing in
  // the window between deploying this Worker and running the migration that adds the column.
  if (result && result.status === 400 && rows.some((r) => r.screen != null || r.user_id != null)) {
    const adapted = rows.map(({ screen, user_id, ...rest }) => ({
      ...rest,
      meta: Object.assign({}, rest.meta, screen != null ? { screen } : {}),
    }));
    result = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(adapted),
    }).catch(() => null);
  }

  if (!result) console.error("supabase err (network)");
  else if (!result.ok)
    console.error("supabase insert", result.status, (await result.text()).slice(0, 200));
  else console.log("supabase insert ok", rows.length);
}

// Handle POST /a — accepts a single event object or a batched array of events.
async function handleAnalyticsBeacon(request, env, ctx) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY)
    return new Response(null, { status: 204 });

  // Drop obvious cross-site beacons. Browsers set Sec-Fetch-Site; same-origin web app → "same-origin",
  // native/desktop clients omit the header entirely → those still pass (don't hard-fail when absent).
  if (request.headers.get("Sec-Fetch-Site") === "cross-site")
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

  let body = {};
  try {
    body = await request.json();
  } catch {
    // Empty or malformed beacon body — treat as a bare event with no payload.
  }

  const eventList = Array.isArray(body) ? body : [body];
  const cf = request.cf || {};
  const rawUa = request.headers.get("user-agent") || "";
  const { browser, os, device } = detectClient(rawUa);
  const clamp = (v, n) => (v == null ? null : String(v).slice(0, n));
  // meta is caller-controlled and stored as-is; drop it when serialization exceeds 2 KB so an
  // unauthenticated beacon can't park arbitrarily large blobs (up to 60 rows per request).
  const clampMeta = (m) => {
    if (!m || typeof m !== "object") return null;
    try { return JSON.stringify(m).length <= 2048 ? m : null; } catch { return null; }
  };

  // These request-level fields are identical for every event in a batch.
  const ip = request.headers.get("cf-connecting-ip") || null;
  const country = cf.country || request.headers.get("cf-ipcountry") || null;
  const city = clamp(cf.city, 120);
  const region = clamp(cf.region, 120);
  const ua = clamp(rawUa, 500);

  const rows = eventList
    .slice(0, 60)
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      event: clamp(e.event || "nav", 64),
      url: clamp(e.url, 500),
      path: clamp(e.path, 300),
      referrer: clamp(e.ref, 500),
      ip,
      country,
      city,
      region,
      user_agent: ua,
      browser,
      os,
      device,
      screen: clamp(e.screen, 24),
      session: clamp(e.sid, 64),
      // Account attribution. Shape-checked as a UUID and otherwise dropped, so a malformed or
      // oversized value can't reach the uuid column and 400 the whole batch. NOT verified against a
      // token — the beacon is unauthenticated and this is attribution only, never authorization
      // (the trust model is spelled out in supabase/v1.2.3-analytics-identity.sql).
      user_id: UUID_RX.test(String(e.uid || "")) ? String(e.uid) : null,
      meta: clampMeta(e.meta),
    }));

  if (rows.length) ctx.waitUntil(persistEvents(env, rows));
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// ─── Trending (/trending) ────────────────────────────────────────────────────

// Return aggregated top-played songs and artists over a configurable day window, blended from
// TWO populations: our own web plays (Supabase RPCs, day-window follows ?days) and the Zemer
// app's listening stats (KV, cron-resolved to catalog ids, fixed 30-day window). Both songs and
// artists carry catalog ids so the client can merge/route without name matching. Edge-cached 30 min.
async function handleTrending(request, url, env, ctx) {
  const days = Math.min(
    365,
    Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30)
  );
  const edgeCache = caches.default;
  const cacheKey = new Request(`https://sk/trending?days=${days}&v=3`); // v3: abandons pre-fix web-only entries that were cached for 30 min per colo
  const cached = await edgeCache.match(cacheKey);
  if (cached) return cached;

  let songs = [], artists = [];
  if (env.SUPABASE_URL && env.SUPABASE_KEY) {
    const sbHeaders = {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
    };
    const callRpc = (fn, body) =>
      fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify(body),
      })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []);

    const [rawSongs, rawArtists] = await Promise.all([
      callRpc("top_songs", { days, lim: 40 }),
      callRpc("top_artists", { days, lim: 30 }),
    ]);
    songs = (Array.isArray(rawSongs) ? rawSongs : []).map((x) => ({
      videoId: x.video_id,
      title: x.title,
      artist: x.artist,
      plays: x.plays,
    }));
    artists = (Array.isArray(rawArtists) ? rawArtists : []).map((x) => ({
      artist: x.artist,
      plays: x.plays,
    }));
  }

  // Blend in the Zemer app's listening stats (KV, cron-refreshed, already resolved to catalog
  // ids). Missing KV (fresh namespace / expired) → serve web-only now and self-heal in the
  // background so the next cache miss has it.
  let ext = null;
  if (env.PAGES) {
    try { ext = await env.PAGES.get(EXT_TRENDING_KEY, "json"); } catch { /* malformed → web-only */ }
    // Self-heal, then evict this cache entry so the very next request serves the blend instead of
    // waiting out the web-only copy's TTL.
    if (!ext) ctx.waitUntil(refreshExternalTrending(env).then(() => edgeCache.delete(cacheKey)).catch(() => {}));
  }
  const idx = await getArtistNameIndex(env);
  const extSongs = (ext && Array.isArray(ext.songs)) ? ext.songs : [];
  const extArtists = (ext && Array.isArray(ext.artists)) ? ext.artists : [];

  // Union by videoId. Score = web share + app share, each normalized to its own top item so
  // neither platform's absolute volume dominates; app share is DEVICE-weighted (unique listeners),
  // which one looping device can't inflate. Cross-platform hits naturally rise to the top.
  const maxWeb = Math.max(1, ...songs.map((s) => s.plays || 0));
  const maxApp = Math.max(1, ...extSongs.map((s) => s.devices || 0));
  const byVid = new Map();
  for (const s of songs) {
    byVid.set(s.videoId, {
      videoId: s.videoId, title: s.title, artist: s.artist,
      artistId: resolveArtistId(idx, s.artist),
      plays: s.plays || 0, appPlays: 0, appDevices: 0, skipRate: null, sources: ["web"],
    });
  }
  for (const e of extSongs) {
    const cur = byVid.get(e.videoId);
    if (cur) {
      cur.appPlays = e.plays || 0; cur.appDevices = e.devices || 0;
      cur.skipRate = e.skipRate ?? null;
      if (!cur.artistId) cur.artistId = e.artistId || null;
      if (e.offCatalog) cur.offCatalog = true;
      cur.sources.push("app");
    } else {
      byVid.set(e.videoId, {
        videoId: e.videoId, title: e.title, artist: e.artist, artistId: e.artistId || null,
        plays: 0, appPlays: e.plays || 0, appDevices: e.devices || 0,
        skipRate: e.skipRate ?? null, ...(e.offCatalog ? { offCatalog: true } : {}), sources: ["app"],
      });
    }
  }
  const mergedSongs = [...byVid.values()]
    .map((s) => ({ ...s, score: +(s.plays / maxWeb + s.appDevices / maxApp).toFixed(4) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 40);

  // Artists: same union, keyed by resolved channel id (name-keyed fallback for the rare
  // web-side name that doesn't resolve — it still shows, it just can't merge).
  const maxWebA = Math.max(1, ...artists.map((a) => a.plays || 0));
  const maxAppA = Math.max(1, ...extArtists.map((a) => a.devices || 0));
  const byArtist = new Map();
  for (const a of artists) {
    const id = resolveArtistId(idx, a.artist);
    byArtist.set(id || "name:" + normArtistName(a.artist), {
      id, artist: a.artist, plays: a.plays || 0, appPlays: 0, appDevices: 0, sources: ["web"],
    });
  }
  for (const e of extArtists) {
    const cur = byArtist.get(e.id);
    if (cur) { cur.appPlays = e.plays || 0; cur.appDevices = e.devices || 0; cur.sources.push("app"); }
    else byArtist.set(e.id, { id: e.id, artist: e.name, plays: 0, appPlays: e.plays || 0, appDevices: e.devices || 0, sources: ["app"] });
  }
  const mergedArtists = [...byArtist.values()]
    .map((a) => ({ ...a, score: +(a.plays / maxWebA + a.appDevices / maxAppA).toFixed(4) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);

  // A blend-less response is a transient state (KV gap; the self-heal above is already running) —
  // cache it briefly, not for the full 30 min, so nobody is pinned to web-only trending.
  const res = Response.json(
    { days, songs: mergedSongs, artists: mergedArtists, app: ext ? { fetchedAt: ext.fetchedAt, days: ext.days } : null },
    { headers: { "Cache-Control": `public, max-age=${ext ? 1800 : 120}` } }
  );
  ctx.waitUntil(edgeCache.put(cacheKey, res.clone()));
  return res;
}

// ─── External listening stats (tracking.zemer.io) ────────────────────────────

// The Zemer Android app reports plays to tracking.zemer.io ("Zemer Usage Stats"); its public
// aggregate — GET /stats/public — carries topPlays (videoId-keyed, ~200) and topArtists
// (name-keyed, ~50) over a 30-day window. The cron below resolves both to OUR catalog ids
// (videoId membership in og.json doubles as the whitelist filter; artist names → channel ids
// via artists.json) and parks the result in KV for /trending to blend at read time.
const EXT_TRENDING_KEY = "ext-trending-v1";

// Fetch a dist/data JSON through the assets binding (routes purely on pathname, so a synthetic
// origin is fine — scheduled() has no incoming request to derive one from).
async function fetchAssetJSON(env, path) {
  try {
    const res = await env.ASSETS.fetch("https://assets" + path);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const normArtistName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Exact name → id map, plus an unambiguous prefix map: channel names often differ only by a
// " - Hebrew" suffix between their index and ours ("Shmulik Sukkot - שמוליק סוכות" vs
// "Shmulik Sukkot"), so a stripped-suffix key resolves those — but only when it's unique.
function buildArtistNameIndex(artists) {
  const exact = new Map(), prefix = new Map(), dupes = new Set();
  for (const a of artists) {
    const n = normArtistName(a.name);
    if (n) exact.set(n, a.id);
    const p = n.split(" - ")[0].trim();
    if (p && p !== n) {
      if (prefix.has(p) && prefix.get(p) !== a.id) dupes.add(p);
      else prefix.set(p, a.id);
    }
  }
  for (const d of dupes) prefix.delete(d);
  return { exact, prefix };
}

const resolveArtistId = (idx, name) => {
  const n = normArtistName(name);
  return idx.exact.get(n) || idx.prefix.get(n) || idx.exact.get(n.split(" - ")[0].trim()) || null;
};

// ── same-song title matching ──
// The app frequently plays a channel's plain-YouTube upload while our corpus catalogs the
// YouTube Music release of the SAME song under a different videoId. Titles are the bridge:
// normalize hard (any-language letters/digits only), and generate looser variants — each " | "
// dual-language segment, with and without "(ווקאלי)"-style parenthetical suffixes.
const normTitle = (s) =>
  String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function titleVariants(title) {
  const raw = String(title || "");
  const out = new Set();
  for (const part of [raw, ...raw.split("|")]) {
    for (const cand of [part, part.replace(/[([].*?[)\]]/g, " ")]) {
      const n = normTitle(cand);
      if (n) out.add(n);
    }
  }
  return out;
}

// title+artist → videoId over the whole catalog. A key claimed by two different tracks is
// poisoned (null) so we never remap onto a guess — e.g. an artist with three distinct
// "Lecha Dodi" recordings simply doesn't remap and the play stays on its original id.
function buildTitleIndex(og, idx) {
  const map = new Map();
  for (const [vid, [title, artistName]] of Object.entries(og)) {
    const aid = resolveArtistId(idx, artistName);
    if (!aid) continue;
    for (const v of titleVariants(title)) {
      const k = v + "|" + aid;
      map.set(k, map.has(k) && map.get(k) !== vid ? null : vid);
    }
  }
  return map;
}

const remapByTitle = (titleIdx, title, artistId) => {
  if (!artistId) return null;
  for (const v of titleVariants(title)) {
    const hit = titleIdx.get(v + "|" + artistId);
    if (hit) return hit;
  }
  return null;
};

// Module-level cache: the /trending merge needs the name index on every edge-cache miss;
// artists.json is ~550 KB, so parse it once per isolate.
let artistIndexCache = null;
async function getArtistNameIndex(env) {
  if (artistIndexCache) return artistIndexCache;
  const f = await fetchAssetJSON(env, "/data/artists.json");
  const artists = f && Array.isArray(f.artists) ? f.artists : null;
  const idx = buildArtistNameIndex(artists || []);
  // Only PIN a real, non-empty index (like songOgCache). A transient fetch failure returns a usable
  // empty index for this call but leaves the cache null so the next call retries instead of pinning
  // an empty index for the whole isolate lifetime (which would break every later /trending merge).
  if (artists && artists.length) artistIndexCache = idx;
  return idx;
}

// Cron half: pull the public stats, resolve to catalog ids, store in KV.
// TTL bridges two cron cycles with margin (same rationale as refreshTrending).
async function refreshExternalTrending(env) {
  if (!env.PAGES) return;
  let stats = null;
  try {
    const res = await fetch("https://tracking.zemer.io/stats/public?days=30", {
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) stats = await res.json();
  } catch { /* best-effort — stale KV (or none) simply means web-only trending */ }
  if (!stats || (!Array.isArray(stats.topPlays) && !Array.isArray(stats.topArtists))) return;

  const [og, artistsFile] = await Promise.all([
    fetchAssetJSON(env, "/data/og.json"),
    fetchAssetJSON(env, "/data/artists.json"),
  ]);
  if (!og) return;
  const idx = buildArtistNameIndex((artistsFile && artistsFile.artists) || []);
  const nameById = new Map(((artistsFile && artistsFile.artists) || []).map((a) => [a.id, a.name]));

  // Songs, in three tiers. (1) Catalog id → take OUR canonical title/artist. (2) Not a catalog
  // id but the same song exists in the catalog under another id (their app plays the channel's
  // plain-YouTube upload; we index the YouTube Music release) → remap the play onto our id.
  // (3) No remap but the artist resolves to a whitelisted channel → KEEP the original id, marked
  // offCatalog — everything in these stats was played inside the whitelist-locked Zemer app, so
  // the id is kosher by construction and our player handles any videoId. Only rows their tracker
  // never titled (deleted videos etc.) are dropped — there's nothing to attribute them to.
  const titleIdx = buildTitleIndex(og, idx);
  const songs = [];
  const songByVid = new Map(); // kept videoId → songs[] row (remaps can collapse two of their rows onto one song)
  const agg = new Map(); // artistId → { id, name, plays, devices }
  for (const p of stats.topPlays || []) {
    let vid = p.videoId;
    let entry = og[vid];
    let offCatalog = false;
    if (!entry) {
      const aid = resolveArtistId(idx, p.artist);
      if (!aid || !normTitle(p.title)) continue;
      const remap = remapByTitle(titleIdx, p.title, aid);
      if (remap) { vid = remap; entry = og[vid]; }
      else offCatalog = true;
    }
    const artistId = resolveArtistId(idx, entry ? entry[1] : p.artist);
    const prev = songByVid.get(vid);
    if (prev) {
      prev.plays += p.n || 0;
      prev.devices = Math.max(prev.devices, p.devices || 0); // the two versions' device sets may overlap → max
    } else {
      const row = {
        videoId: vid,
        title: entry ? entry[0] : p.title,
        artist: entry ? entry[1] : (nameById.get(artistId) || p.artist),
        artistId,
        plays: p.n || 0, devices: p.devices || 0,
        skipRate: typeof p.skipRate === "number" ? p.skipRate : null,
      };
      if (offCatalog) row.offCatalog = true;
      songByVid.set(vid, row);
      songs.push(row);
    }
    if (artistId) {
      const a = agg.get(artistId) || { id: artistId, name: nameById.get(artistId) || p.artist, plays: 0, devices: 0 };
      a.plays += p.n || 0;
      a.devices = Math.max(a.devices, p.devices || 0); // per-song device sets overlap → max, never sum
      agg.set(artistId, a);
    }
  }
  // …then let topArtists override where it matches: it's the per-artist truth (devices deduped
  // across the artist's whole catalog, not just their charting songs).
  for (const t of stats.topArtists || []) {
    const artistId = resolveArtistId(idx, t.artist);
    if (!artistId) continue;
    const a = agg.get(artistId) || { id: artistId, name: nameById.get(artistId) || t.artist, plays: 0, devices: 0 };
    a.plays = Math.max(a.plays, t.n || 0);
    a.devices = Math.max(a.devices, t.devices || 0);
    agg.set(artistId, a);
  }

  // Rank by unique listeners first — reach, not volume (mirrors the upstream dashboard's own sort).
  songs.sort((x, y) => y.devices - x.devices || y.plays - x.plays);
  const artists = [...agg.values()].sort((x, y) => y.devices - x.devices || y.plays - x.plays);

  await env.PAGES.put(
    EXT_TRENDING_KEY,
    JSON.stringify({ fetchedAt: Date.now(), days: 30, songs: songs.slice(0, 100), artists: artists.slice(0, 50) }),
    { expirationTtl: 46800 }
  );
}

// ─── Live upstream playlist proxy (/zp-live) ─────────────────────────────────

// The upstream Zemer index refreshes these auto-playlists ~twice daily.
// The cron keeps a warm KV copy so /zp-live is always fast and same-origin
// (works behind content filters; no per-build staleness).
const LIVE_PLAYLIST_IDS = ["auto-trending", "auto-top-50", "auto-acapella-top-50"];
const zpKvKey = (id) => "zp:" + id;

// Fetch a fresh copy of one auto-playlist from the upstream Zemer search index.
// Returns the raw JSON text, or null on any error.
async function fetchUpstreamPlaylist(id) {
  try {
    const res = await fetch(
      `https://search.zemer.io/zemer-playlists?id=${encodeURIComponent(id)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.length > 2 ? text : null;
  } catch {
    return null;
  }
}

// Serve /zp-live: KV → edge cache → live upstream fetch (in that priority order).
async function handleLivePlaylist(url, env, ctx) {
  const id = url.searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{2,60}$/.test(id)) {
    return Response.json(
      { error: "bad id" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // 1. KV — written by cron or a previous on-demand fetch. A KV error degrades to edge/live below.
  if (env.PAGES) {
    let kvText = null;
    try { kvText = await env.PAGES.get(zpKvKey(id)); } catch { /* KV read failed → fall through */ }
    if (kvText) {
      return new Response(kvText, {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      });
    }
  }

  // 2. Edge cache — populated on a previous on-demand fetch.
  const edgeCache = caches.default;
  const cacheKey = new Request(`https://sk/zp-live?id=${id}`);
  const edgeHit = await edgeCache.match(cacheKey);
  if (edgeHit) return edgeHit;

  // 3. Live upstream fetch.
  const text = await fetchUpstreamPlaylist(id);
  if (text == null) {
    return Response.json(
      { error: "unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Populate KV (3h TTL) so the next request in this region is fast even before the cron runs.
  if (env.PAGES && ctx) {
    ctx.waitUntil(env.PAGES.put(zpKvKey(id), text, { expirationTtl: 10800 }));
  }

  const response = new Response(text, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10800" },
  });
  if (ctx) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
}

// Cron handler: pull all live trending playlists into KV right after the upstream update.
// TTL is 13 hours (46800 s) — long enough to bridge two cron cycles with margin.
async function refreshTrending(env) {
  if (!env.PAGES) return;
  for (const id of LIVE_PLAYLIST_IDS) {
    const text = await fetchUpstreamPlaylist(id);
    if (text) await env.PAGES.put(zpKvKey(id), text, { expirationTtl: 46800 });
  }
}

// ─── Zemer home rows (/zemer-home-rows) ──────────────────────────────────────

// Upstream /home-rows: telemetry-ranked Top Albums / Videos / Artists computed twice daily
// from the Zemer app fleet's 30-day device reach. Served same-origin (works behind content
// filters) with the same KV → edge cache → live priority as /zp-live; the cron keeps KV warm.
const HOME_ROWS_KV_KEY = "home-rows:v1";

async function fetchUpstreamHomeRows() {
  try {
    const res = await fetch("https://search.zemer.io/home-rows", { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.length > 2 ? text : null;
  } catch {
    return null;
  }
}

async function handleHomeRows(env, ctx) {
  if (env.PAGES) {
    let kvText = null;
    try { kvText = await env.PAGES.get(HOME_ROWS_KV_KEY); } catch { /* KV read failed → fall through to edge/live */ }
    if (kvText) {
      return new Response(kvText, {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      });
    }
  }

  const edgeCache = caches.default;
  const cacheKey = new Request("https://sk/zemer-home-rows");
  const edgeHit = await edgeCache.match(cacheKey);
  if (edgeHit) return edgeHit;

  const text = await fetchUpstreamHomeRows();
  if (text == null) {
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  if (env.PAGES && ctx) ctx.waitUntil(env.PAGES.put(HOME_ROWS_KV_KEY, text, { expirationTtl: 10800 }));
  const response = new Response(text, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10800" },
  });
  if (ctx) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
}

// Cron half: same 13 h TTL bridging discipline as refreshTrending.
async function refreshHomeRows(env) {
  if (!env.PAGES) return;
  const text = await fetchUpstreamHomeRows();
  if (text) await env.PAGES.put(HOME_ROWS_KV_KEY, text, { expirationTtl: 46800 });
}

// ─── Zemer new releases (/zemer-new) ─────────────────────────────────────────

// Upstream /new: recent releases with REAL release dates from the releases feed (fallback: corpus
// harvest dates). Fetched UNFILTERED (no content flags) so one cached copy serves everyone — the
// client applies its own gate(), exactly as it does for /home data. KV → edge → live, 3 h TTL.
const ZEMER_NEW_KV_KEY = "zemer-new:v1";

async function handleZemerNew(env, ctx) {
  if (env.PAGES) {
    let kvText = null;
    try { kvText = await env.PAGES.get(ZEMER_NEW_KV_KEY); } catch { /* KV read failed → fall through to edge/live */ }
    if (kvText) {
      return new Response(kvText, {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
      });
    }
  }
  const edgeCache = caches.default;
  const cacheKey = new Request("https://sk/zemer-new");
  const edgeHit = await edgeCache.match(cacheKey);
  if (edgeHit) return edgeHit;

  let text = null;
  try {
    const res = await fetch("https://search.zemer.io/new?k=60&days=14", { signal: AbortSignal.timeout(15000) });
    if (res.ok) { const t = await res.text(); if (t && t.length > 2) text = t; }
  } catch {}
  if (text == null) {
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  if (env.PAGES && ctx) ctx.waitUntil(env.PAGES.put(ZEMER_NEW_KV_KEY, text, { expirationTtl: 10800 }));
  const response = new Response(text, {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10800" },
  });
  if (ctx) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
}

// ─── Zemer Podcasts (/podcasts/*, /podcast, /podcast-channel) ────────────────

// Spoken-word content from the Zemer stack (zemer-app#355). Discovery is whitelist-pure upstream,
// exactly like the music catalog; an episode is a plain videoId, so playback needs nothing special.
//
// Two upstreams: search.zemer.io for shows/channels/episodes, and content.zemer.io for the podcast
// whitelist — content.zemer.io is a NEW host for this Worker, added deliberately and only for the
// whitelist mirror. Same allowlist posture as /radio: rebuild the upstream query, never forward
// url.search, so this can't be used as an open proxy.
const POD_ID_RX = /^[A-Za-z0-9_=-]{1,128}$/;
const podBad = (m) => Response.json({ error: m }, { status: 400, headers: { "Cache-Control": "no-store" } });

async function podUpstream(url, cacheKey, ttl, ctx) {
  const cache = caches.default;
  if (cacheKey) { const hit = await cache.match(cacheKey); if (hit) return hit; }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    const out = new Response(text, {
      status: res.status,
      headers: { "Content-Type": "application/json", "Cache-Control": res.ok && ttl ? `public, max-age=${ttl}` : "no-store" },
    });
    if (res.ok && ttl && cacheKey && ctx) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch {
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

async function handlePodcasts(request, url, ctx) {
  if (request.method !== "GET")
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });
  const p = url.pathname;

  if (p === "/podcasts/new-episodes") {
    const out = new URLSearchParams();
    for (const f of ["allowFemale", "blockVideos", "kidZone"]) {
      const v = url.searchParams.get(f);
      if (v != null) out.set(f, v === "1" || v === "true" ? "1" : "0");
    }
    const k = parseInt(url.searchParams.get("k") || "", 10);
    if (Number.isFinite(k)) out.set("k", String(Math.min(100, Math.max(1, k))));
    const qs = out.toString();
    return podUpstream("https://search.zemer.io/podcasts/new-episodes" + (qs ? "?" + qs : ""),
      new Request("https://sk/pod-new?" + qs), 1800, ctx); // 30 min — shows publish on a weekly cadence, not a minutely one
  }

  if (p === "/podcast" || p === "/podcast-channel") {
    const id = url.searchParams.get("id") || "";
    if (!POD_ID_RX.test(id)) return podBad("bad id");
    const out = new URLSearchParams({ id });
    for (const f of ["allowFemale", "blockVideos", "kidZone"]) {
      const v = url.searchParams.get(f);
      if (v != null) out.set(f, v === "1" || v === "true" ? "1" : "0");
    }
    const qs = out.toString();
    // 6 h. A show/channel page only gains an episode when the podcast publishes, and /podcasts/new-episodes
    // is the surface that has to be fresh — so this trades staleness we can't see for Worker requests we pay for.
    return podUpstream("https://search.zemer.io" + p + "?" + qs, new Request("https://sk" + p + "?" + qs), 21600, ctx);
  }

  // The whitelist mirror. The SPA does NOT read this — it reads the build-time snapshot in
  // /data/podcasts.json, which costs no Worker request at all. These stay for external callers, and
  // are cached to the same 6 h as the show endpoints: a stale allow-set only ever hides new shows.
  if (p === "/podcasts-whitelist")
    return podUpstream("https://content.zemer.io/podcastsWhitelist", new Request("https://sk/pod-wl"), 21600, ctx);
  if (p === "/podcasts-whitelist/version")
    return podUpstream("https://content.zemer.io/podcastsWhitelist/version", new Request("https://sk/pod-wlv"), 3600, ctx);

  return podBad("unknown podcast route");
}

// ─── Zemer Stations (/stations, /station, /stations/cover) ───────────────────

// Synchronized broadcast radio: ONE shared wall-clock program per station, so every listener hears
// the same track at the same moment (see zemer-search docs/stations.md). Distinct from /radio, which
// is a personalized queue. Proxied same-origin so it works behind content filters, and — like /radio —
// the upstream query is rebuilt from a validated allowlist rather than forwarding url.search.
//
// Caching is per-route because the time-sensitivity differs sharply:
//   /station       — carries offsetMs (where in the track the broadcast currently is). NEVER cache;
//                    a stale offset would drop the listener into the wrong point of the song.
//   /stations      — the card list, whose nowPlaying turns over per track (~3 min). A short edge
//                    cache keeps Home cheap without the cards visibly lagging.
//   /stations/cover — a generated SVG that only changes when the station catalog does. Cache hard.
const STATION_ID_RX = /^[a-z0-9][a-z0-9-]{0,31}$/; // shape-checked, not hardcoded — a new upstream station works without a deploy
const STATIONS_EDGE_TTL = 15;

async function handleStations(request, url, ctx) {
  if (request.method !== "GET")
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });

  const cache = caches.default;
  const cacheKey = new Request("https://sk/stations");
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const res = await fetch("https://search.zemer.io/stations", { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    const out = new Response(text, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
        // Only cache a healthy list; an upstream error must not stick for 15s.
        "Cache-Control": res.ok ? `public, max-age=${STATIONS_EDGE_TTL}` : "no-store",
      },
    });
    if (res.ok && ctx) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch {
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

async function handleStation(request, url) {
  if (request.method !== "GET")
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });

  const id = url.searchParams.get("id") || "";
  if (!STATION_ID_RX.test(id))
    return Response.json({ error: "bad id" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  const out = new URLSearchParams({ id });
  const nextRaw = url.searchParams.get("next");
  if (nextRaw != null) {
    const n = parseInt(nextRaw, 10);
    if (Number.isFinite(n)) out.set("next", String(Math.min(10, Math.max(1, n))));
  }

  try {
    const res = await fetch("https://search.zemer.io/station?" + out.toString(), {
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

async function handleStationCover(request, url, ctx) {
  if (request.method !== "GET")
    return new Response("method not allowed", { status: 405, headers: { "Cache-Control": "no-store" } });

  const id = url.searchParams.get("id") || "";
  if (!STATION_ID_RX.test(id))
    return new Response("bad id", { status: 400, headers: { "Cache-Control": "no-store" } });

  const cache = caches.default;
  const cacheKey = new Request(`https://sk/stations/cover?id=${id}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const res = await fetch(`https://search.zemer.io/stations/cover?id=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return new Response("unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
    const body = await res.arrayBuffer();
    const out = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      },
    });
    if (ctx) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch {
    return new Response("unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

// ─── Zemer Radio (/radio) ────────────────────────────────────────────────────

// Live pass-through to the upstream corpus radio (co-occurrence "what plays next"; see
// zemer-search docs/radio.md). Served same-origin so it works behind content filters.
// Stations are per-session (rngSeed inside the opaque continuation token), so responses are
// deliberately NOT KV/edge cached — each page is a cheap deterministic read upstream.
const RADIO_KINDS = ["song", "artist", "album", "shuffle", "playlist"];
const badRadio = (msg) =>
  Response.json({ error: msg }, { status: 400, headers: { "Cache-Control": "no-store" } });

async function handleRadio(request, url) {
  // GET only, and never forward url.search verbatim — rebuild the upstream query from a validated
  // allowlist so /radio can't be used to pass arbitrary/unbounded params to search.zemer.io.
  if (request.method !== "GET")
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });

  const p = url.searchParams;
  const out = new URLSearchParams();

  // A pagination request carries only the opaque continuation token (no kind); a fresh station carries kind.
  const continuation = p.get("continuation");
  if (continuation != null) {
    if (!/^[A-Za-z0-9_=-]{1,2048}$/.test(continuation)) return badRadio("bad continuation");
    out.set("continuation", continuation);
  }
  const kind = p.get("kind");
  if (kind != null) {
    if (!RADIO_KINDS.includes(kind)) return badRadio("bad kind");
    out.set("kind", kind);
  }
  if (!out.has("kind") && !out.has("continuation")) return badRadio("bad request");

  const seed = p.get("seed");
  if (seed != null) {
    if (!/^[A-Za-z0-9_=-]{1,64}$/.test(seed)) return badRadio("bad seed");
    out.set("seed", seed);
  }
  const limitRaw = p.get("limit");
  if (limitRaw != null) {
    const lim = parseInt(limitRaw, 10);
    if (Number.isFinite(lim)) out.set("limit", String(Math.min(50, Math.max(1, lim))));
  }
  for (const flag of ["allowFemale", "allowChasid", "kidZone", "blockVideos"]) {
    const v = p.get(flag);
    if (v != null) out.set(flag, v === "1" || v === "true" ? "1" : "0");
  }

  // NOTE: a per-IP rate limit would need infra not bound here (no Rate Limiting binding / Durable Object);
  // the param allowlist above is the required hardening. Add a binding-backed limiter if abuse appears.
  try {
    const res = await fetch("https://search.zemer.io/radio?" + out.toString(), {
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

// ─── Lyrics proxy (/lyrics) ──────────────────────────────────────────────────

// Proxy LRCLIB (lrclib.net — a free, open lyrics API the upstream project already uses) so the
// client can fetch lyrics same-origin (works behind content filters) and we can cache hard: lyrics
// are immutable per song, so a hit is edge-cached for a week. A miss (404 upstream) is a normal
// outcome, not an error — it returns nulls at 200 and is only cached briefly, since a song not yet
// on LRCLIB today may be synced there tomorrow.
async function handleLyrics(request, url, ctx) {
  if (request.method !== "GET")
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });

  // artist + title are required; length-cap each so the route can't be handed unbounded junk.
  const artist = (url.searchParams.get("artist") || "").trim().slice(0, 200);
  const title = (url.searchParams.get("title") || "").trim().slice(0, 200);
  if (!artist || !title)
    return Response.json({ error: "artist and title required" }, { status: 400, headers: { "Cache-Control": "no-store" } });

  // duration is optional but sharpens LRCLIB's match — keep it only when it's a small positive integer.
  const durRaw = parseInt(url.searchParams.get("duration") || "", 10);
  const duration = Number.isFinite(durRaw) && durRaw > 0 && durRaw < 36000 ? durRaw : null;

  // Edge cache is shared across users and keyed on a normalized query (case/whitespace-folded) so
  // "Uncle Moishy" and "uncle  moishy" collapse onto one entry.
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const edgeCache = caches.default;
  const cacheKey = new Request(
    `https://sk/lyrics?artist=${encodeURIComponent(norm(artist))}&title=${encodeURIComponent(norm(title))}&duration=${duration || ""}`
  );
  const cached = await edgeCache.match(cacheKey);
  if (cached) return cached;

  // Live LRCLIB lookup. They ask callers to identify themselves via a descriptive User-Agent.
  const params = new URLSearchParams({ artist_name: artist, track_name: title });
  if (duration) params.set("duration", String(duration));
  let res;
  try {
    res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      headers: { "User-Agent": "SK Music (https://github.com/Shalom-Karr/SK-Music)" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  // 404 / no match: normal miss. Nulls at 200, cached only briefly (never edge-put) so a song that
  // gets synced upstream later isn't pinned as missing for the full week.
  if (res.status === 404) {
    return Response.json(
      { synced: null, plain: null },
      { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } }
    );
  }
  if (!res.ok)
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });

  let data;
  try {
    data = await res.json();
  } catch {
    return Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  // Hit — lyrics are immutable per song, so cache aggressively (7 days) at both the edge and downstream.
  const response = Response.json(
    { synced: data.syncedLyrics ?? null, plain: data.plainLyrics ?? null, source: "lrclib" },
    { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=604800" } }
  );
  if (ctx) ctx.waitUntil(edgeCache.put(cacheKey, response.clone()));
  return response;
}

// ─── KV page overrides ────────────────────────────────────────────────────────

// Derive the correct MIME type from a file path extension.
const mimeForPath = (path) =>
  path.endsWith(".html") ? "text/html; charset=utf-8"
  : path.endsWith(".js") || path.endsWith(".mjs") ? "text/javascript; charset=utf-8"
  : path.endsWith(".css") ? "text/css; charset=utf-8"
  : path.endsWith(".json") ? "application/json; charset=utf-8"
  : path.endsWith(".xml") ? "application/xml; charset=utf-8"
  : "text/plain; charset=utf-8";

// Check whether env.PAGES has a published override for the given path.
// Returns a Response if found, null if not.
async function tryKvOverride(env, path) {
  if (!env.PAGES) return null;
  const content = await env.PAGES.get(path);
  if (content == null) return null;
  return new Response(content, {
    headers: { "Content-Type": mimeForPath(path), "Cache-Control": "no-store" },
  });
}

// Desktop auto-updater manifest. Proxies the signed `latest.json` from the newest published
// `desktop-*` GitHub release so the app checks updates against the trusted skmusic origin. The
// manifest's URLs point at the GitHub release assets (installers), so github must be reachable to
// apply an update — same as the manual /download path. The GitHub API subrequest is edge-cached
// (cf.cacheTtl) and the built manifest is cached ~10min, keeping us well under the API rate limit.
const UPDATE_REPO = "Shalom-Karr/SK-Music";
async function handleUpdateManifest(ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://sk-music.internal/__updates_latest.json");
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const noUpdate = () => new Response(null, { status: 204, headers: { "Cache-Control": "public, max-age=300" } });
  try {
    const gh = { "User-Agent": "sk-music-updater", Accept: "application/vnd.github+json" };
    const rel = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`, {
      headers: gh,
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!rel.ok) return noUpdate();
    const releases = await rel.json();
    const desktop = Array.isArray(releases)
      ? releases.find((r) => !r.draft && !r.prerelease && (r.tag_name || "").startsWith("desktop-v"))
      : null;
    const asset = desktop && (desktop.assets || []).find((a) => a.name === "latest.json");
    if (!asset) return noUpdate();
    const man = await fetch(asset.browser_download_url, { headers: gh, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!man.ok) return noUpdate();
    const resp = new Response(await man.text(), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=600" },
    });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  } catch (e) {
    return noUpdate();
  }
}

// Collect CSP violation reports (the policy ships report-only) so the allowlist can be verified against
// real web + desktop-webview traffic before flipping to an enforcing policy. Logs one compact line
// (visible via Workers logs / observability); always 204; never throws.
async function handleCspReport(request) {
  try {
    const body = await request.json();
    const r = (body && body["csp-report"]) || body || {};
    console.log("[csp-report]", JSON.stringify({
      directive: r["violated-directive"] || r["effective-directive"],
      blocked: r["blocked-uri"],
      doc: r["document-uri"],
    }));
  } catch {
    // ignore malformed reports
  }
  return new Response(null, { status: 204 });
}

// ─── JewishStatus statuses (/statuses/*) ─────────────────────────────────────

// WhatsApp-style creator story circles from jewishstatus.com. Their backend is a public Supabase
// project plus an R2 bucket — reverse-engineered, unversioned, and free to change under us — so every
// failure path here returns an error the client renders as "no row" rather than as a broken UI.
//
// It is proxied rather than called from the browser for three reasons: the anon key stays out of
// assets/ui.html, same-origin survives the content filters our users sit behind, and we stop
// depending on a third party's CORS policy. As with /radio, the upstream query is rebuilt from a
// validated allowlist — url.search is never forwarded.
const JS_REST = "https://raiodurvjneoehnphkrs.supabase.co/rest/v1";
const JS_CDN = "https://pub-0dd407ad34e240909673d1619658d5c2.r2.dev";
// A Supabase *publishable* (anon) key — RLS-scoped and already shipped in their own web client.
// Held here anyway so rotating it is a Worker deploy rather than a client cache-bust.
const JS_KEY = "sb_publishable_Pj9SDOxf5Xxw9LavwAl5yw_5ldleSyD";
const JS_HDRS = { apikey: JS_KEY, Authorization: "Bearer " + JS_KEY };
// Only the music categories. JewishStatus also carries news/food/real-estate creators, which have no
// business on a music home page, so the row is built from these three and nothing else.
const JS_CATEGORIES = [
  "dc207cab-3514-4ae8-a5c1-8a69fb27ced3", // Jewish Music & Events
  "02ed4e29-d461-43f4-9aab-e16d05d3f795", // Music (Independent)
  "5a08c0ba-400a-4576-aa33-97fa9ec38d0e", // Concerts
];
const JS_UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// R2 keys look like "creators/<uuid>/<uuid>.mp4" or "creators/<slug>.jpg". Every segment must start
// with an alphanumeric, which is what makes a ".." segment unrepresentable — this route can reach
// nothing but the two buckets' own objects, and the charset it allows is already URL-safe.
const JS_PATH_RX = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/;
const JS_DIRS = new Set(["avatars", "status-media"]);
const jsBad = (msg) => Response.json({ error: msg }, { status: 400, headers: { "Cache-Control": "no-store" } });
const jsDown = () => Response.json({ error: "unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });

async function handleStatuses(request, url, ctx) {
  if (request.method !== "GET")
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });
  const p = url.pathname;
  if (p === "/statuses/creators") return jsCreators(ctx);
  if (p === "/statuses/posts") return jsPosts(url, ctx);
  if (p === "/statuses/media") return jsMedia(request, url);
  return jsBad("unknown statuses route");
}

// The row itself: one RPC per category, merged in category order and deduped by id (a creator filed
// under two categories would otherwise appear twice). A category that fails is dropped rather than
// failing the whole row — a partial row still beats no row — so only a total outage 502s. Five
// minutes of edge cache: new statuses appear all day, but not by the second, and the row is shared
// by every visitor.
async function jsCreators(ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://sk/statuses/creators");
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const pages = await Promise.all(JS_CATEGORIES.map(async (cat) => {
    try {
      const res = await fetch(JS_REST + "/rpc/browse_creators_sorted", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, JS_HDRS),
        body: JSON.stringify({
          p_section: "all", p_search: null, p_limit: 100, p_offset: 0,
          p_category: cat, p_location: null, p_sort: "recent",
        }),
        // 6s, not 15s. These run under Promise.all, so the SLOWEST category sets the latency of the
        // whole row on a cache miss — and a category that times out is already dropped rather than
        // failing the row, so waiting 15s for one buys a few extra creators at the cost of everyone
        // else's first paint. Partial-and-quick beats complete-and-late here.
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return Array.isArray(rows) ? rows : null;
    } catch {
      return null;
    }
  }));
  if (pages.every((x) => x === null)) return jsDown();

  // Reshaped to the four fields the row draws with, so a schema addition upstream can't quietly grow
  // the payload every visitor downloads.
  const seen = new Set(), creators = [];
  for (const rows of pages) for (const r of rows || []) {
    if (!r || typeof r.id !== "string" || seen.has(r.id)) continue;
    seen.add(r.id);
    creators.push({
      id: r.id,
      name: typeof r.display_name === "string" ? r.display_name : "",
      avatar: typeof r.avatar_path === "string" && r.avatar_path ? r.avatar_path : null,
      recent: Array.isArray(r.recent_post_ids) ? r.recent_post_ids.filter((x) => typeof x === "string" && x) : [],
    });
  }

  const out = Response.json({ creators }, { headers: { "Cache-Control": "public, max-age=300" } });
  if (ctx) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// One creator's timeline, oldest-first — the order the viewer plays in. It is READ newest-first and
// reversed here on purpose: prolific creators run well past a page, and asc+limit would return their
// OLDEST hundred, i.e. months-old stories that don't match the ring the row just drew from `recent`.
async function jsPosts(url, ctx) {
  const id = url.searchParams.get("creator") || "";
  if (!JS_UUID_RX.test(id)) return jsBad("bad creator");

  const cache = caches.default;
  const cacheKey = new Request("https://sk/statuses/posts?creator=" + id);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const q = new URLSearchParams({
    creator_id: "eq." + id,
    select: "id,kind,media_path,thumb_path,caption,text_body,text_bg_color,link_url,duration_seconds,posted_at",
    order: "posted_at.desc",
    limit: "100",
    offset: "0",
  });
  try {
    const res = await fetch(JS_REST + "/public_posts?" + q.toString(), {
      headers: JS_HDRS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return jsDown();
    const rows = await res.json();
    if (!Array.isArray(rows)) return jsDown();
    const out = Response.json({ posts: rows.reverse() }, { headers: { "Cache-Control": "public, max-age=120" } });
    if (ctx) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  } catch {
    return jsDown();
  }
}

// CDN passthrough. `d` is an allowlist of exactly the two R2 directories the app reads and `p` must
// look like an R2 key, so this can never be pointed at an arbitrary host. Range is forwarded (and its
// 206 passed straight back) because <video> seeks with it; the Cache API is deliberately not used
// here, since it rejects a 206. Objects are uuid-named and never rewritten, hence immutable.
async function jsMedia(request, url) {
  const dir = url.searchParams.get("d") || "";
  const path = url.searchParams.get("p") || "";
  if (!JS_DIRS.has(dir)) return new Response("bad dir", { status: 400, headers: { "Cache-Control": "no-store" } });
  if (!JS_PATH_RX.test(path)) return new Response("bad path", { status: 400, headers: { "Cache-Control": "no-store" } });

  const range = request.headers.get("Range");
  try {
    const res = await fetch(`${JS_CDN}/${dir}/${path}`, {
      headers: range ? { Range: range } : {},
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return new Response("unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
    const h = new Headers({ "Cache-Control": "public, max-age=604800, immutable" });
    for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag"]) {
      const v = res.headers.get(k);
      if (v) h.set(k, v);
    }
    return new Response(res.body, { status: res.status, headers: h });
  } catch {
    return new Response("unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

// ─── Entry points ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Sitemaps + robots.txt: large, static SEO files hit by crawlers. Serve them straight from assets,
    // edge-cached via the Cache API with a real TTL, and skip the KV-override lookup below. Without this
    // every Googlebot fetch was a Worker call + KV read + a full, uncached transfer of the ~1 MB file,
    // which was slow enough to make Search Console's fetch fail.
    if (request.method === "GET" && (/^\/sitemap[\w.-]*\.xml$/.test(pathname) || pathname === "/robots.txt")) {
      const cache = caches.default;
      // Normalize the cache key to origin+pathname (drop the query) so /robots.txt?r=<rand> can't mint
      // unbounded distinct cache entries.
      const cacheKey = new Request(url.origin + url.pathname);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "public, max-age=3600, s-maxage=21600");
      const resp = new Response(asset.body, { status: asset.status, headers });
      // Never cache.put a 206 (range) response — the Cache API rejects it.
      if (asset.ok && asset.status !== 206) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return resp;
    }

    // KV overrides win over static assets for page-like file paths.
    // Scoped away from /data/ and /lib/ to avoid adding KV reads to hot asset traffic.
    if (
      env.PAGES &&
      request.method === "GET" &&
      /\.(html|js|mjs|css|json|xml|txt)$/.test(pathname) &&
      !pathname.startsWith("/data/") &&
      !pathname.startsWith("/lib/")
    ) {
      const override = await tryKvOverride(env, pathname);
      if (override) return override;
    }

    // Live data routes.
    if (pathname === "/playlist")
      return request.method === "GET"
        ? servePlaylist(url, ctx)
        : new Response("method not allowed", { status: 405, headers: { "Cache-Control": "no-store" } });
    if (pathname === "/zp-live") return handleLivePlaylist(url, env, ctx);
    if (pathname === "/zemer-home-rows") return handleHomeRows(env, ctx);
    if (pathname === "/zemer-new") return handleZemerNew(env, ctx);
    if (pathname === "/radio") return handleRadio(request, url);
    // /podcasts/new-episodes is the ONLY API path under /podcasts/ — matched exactly so the SPA's
    // shareable /podcasts/:podcaster falls through to the app shell instead of being answered with a
    // JSON 400. (Series and episodes live under /shows/, which the Worker never claimed.)
    if (pathname === "/podcast" || pathname === "/podcast-channel" || pathname === "/podcasts/new-episodes" || pathname.startsWith("/podcasts-whitelist"))
      return handlePodcasts(request, url, ctx);
    if (pathname === "/stations") return handleStations(request, url, ctx);
    if (pathname === "/station") return handleStation(request, url);
    if (pathname === "/stations/cover") return handleStationCover(request, url, ctx);
    if (pathname === "/lyrics") return handleLyrics(request, url, ctx);
    if (pathname.startsWith("/statuses/")) return handleStatuses(request, url, ctx);
    if (pathname === "/trending") {
      // Content negotiation: browser navigations (Accept: text/html) get the human-readable charts
      // page; the app's fetch() and API callers (Accept: */*) keep getting JSON. Fetch the extensionless
      // canonical (/charts, not /charts.html) — the asset layer 307s .html URLs to it.
      if (request.method === "GET" && (request.headers.get("Accept") || "").includes("text/html")) {
        return env.ASSETS.fetch(new Request(new URL("/charts", url), request));
      }
      return handleTrending(request, url, env, ctx);
    }
    if (pathname === "/a" && request.method === "POST")
      return handleAnalyticsBeacon(request, env, ctx);
    // Desktop auto-updater: serve the newest signed desktop release manifest (edge-cached). 204 =
    // up-to-date/no manifest yet.
    if (pathname.startsWith("/updates/")) return handleUpdateManifest(ctx);
    // CSP violation reports (policy ships report-only) — logged so the allowlist can be tuned.
    if (pathname === "/csp-report" && request.method === "POST") return handleCspReport(request);

    // Admin / tool pages — KV override always wins; never cache these responses.
    if (pathname === "/analytics" || pathname === "/analytics/") {
      const override = await tryKvOverride(env, "/analytics.html");
      if (override) return override;
      const asset = await env.ASSETS.fetch(
        new Request(new URL("/analytics.html", url), request)
      );
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(asset.body, { status: asset.status, headers });
    }
    // Admin console. Serving the page is not an authorization decision — the page is public HTML and
    // the anon key inside it is public too. Access is enforced entirely by the admin_* RPCs, which
    // re-check zemer_admin membership from the verified JWT on every call.
    if (pathname === "/admin" || pathname === "/admin/") {
      const asset = await env.ASSETS.fetch(new Request(new URL("/admin.html", url), request));
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("X-Robots-Tag", "noindex, nofollow");
      return new Response(asset.body, { status: asset.status, headers });
    }
    if (pathname === "/test" || pathname === "/test/") {
      const override = await tryKvOverride(env, "/test.html");
      if (override) return override;
      return env.ASSETS.fetch(new Request(new URL("/test.html", url), request));
    }
    if (pathname === "/israeli-tagger" || pathname === "/israeli-tagger/") {
      return env.ASSETS.fetch(new Request(new URL("/israeli-tagger.html", url), request));
    }
    if (pathname === "/chasidish-tagger" || pathname === "/chasidish-tagger/") {
      return env.ASSETS.fetch(new Request(new URL("/chasidish-tagger.html", url), request));
    }

    // Server-rendered OG shells for shareable deep links.
    // Matches one segment after the four known entity prefixes; excludes /zemer-playlists/cover
    // (that's a static asset, not an entity detail page).
    const deepLink = /^\/(song|artists|albums|zemer-playlists)\/([^/?#]+)$/.exec(pathname);
    if (
      request.method === "GET" &&
      deepLink &&
      !(deepLink[1] === "zemer-playlists" && deepLink[2] === "cover")
    ) {
      return renderDeepLinkShell(request, env, url, deepLink[1], deepLink[2]);
    }

    // /credits was the old name for /about — permanent redirect.
    if (pathname.toLowerCase() === "/credits") {
      return Response.redirect(new URL("/about", url).toString(), 301);
    }

    // Named tab routes each get their own injected title and social preview.
    const tabPreview = request.method === "GET" ? ROUTE_PREVIEWS[pathname.toLowerCase()] : null;
    if (tabPreview) return renderTabShell(request, env, url, tabPreview);

    // Everything else — static assets, /data/*, /lib/*, SPA fallback.
    // The SPA index.html bakes in the default OG block for unmatched client-side routes.
    return env.ASSETS.fetch(request);
  },

  // Cron trigger: keep the upstream trending playlists + the app listening stats warm in KV.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshTrending(env));
    ctx.waitUntil(refreshExternalTrending(env));
    ctx.waitUntil(refreshHomeRows(env));
  },
};
