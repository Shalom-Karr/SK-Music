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
function buildMetaTags({ title, description, image, type }) {
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

  if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return stub("invalid playlist id");

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

  if (result && result.status === 400 && rows.some((r) => r.screen != null)) {
    const adapted = rows.map(({ screen, ...rest }) => ({
      ...rest,
      meta: Object.assign({}, rest.meta, { screen }),
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
      meta: e.meta && typeof e.meta === "object" ? e.meta : null,
    }));

  if (rows.length) ctx.waitUntil(persistEvents(env, rows));
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// ─── Trending (/trending) ────────────────────────────────────────────────────

// Return aggregated top-played songs and artists over a configurable day window.
// Pulls from Supabase RPCs; edge-cached for 30 minutes.
async function handleTrending(request, url, env, ctx) {
  const days = Math.min(
    365,
    Math.max(1, parseInt(url.searchParams.get("days") || "30", 10) || 30)
  );
  const edgeCache = caches.default;
  const cacheKey = new Request(`https://sk/trending?days=${days}`);
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
      callRpc("top_songs", { days, lim: 24 }),
      callRpc("top_artists", { days, lim: 20 }),
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

  const res = Response.json(
    { days, songs, artists },
    { headers: { "Cache-Control": "public, max-age=1800" } }
  );
  ctx.waitUntil(edgeCache.put(cacheKey, res.clone()));
  return res;
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

  // 1. KV — written by cron or a previous on-demand fetch.
  if (env.PAGES) {
    const kvText = await env.PAGES.get(zpKvKey(id));
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

// ─── Entry points ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

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
    if (pathname === "/playlist") return servePlaylist(url, ctx);
    if (pathname === "/zp-live") return handleLivePlaylist(url, env, ctx);
    if (pathname === "/trending") return handleTrending(request, url, env, ctx);
    if (pathname === "/a" && request.method === "POST")
      return handleAnalyticsBeacon(request, env, ctx);

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

  // Cron trigger: keep the upstream trending playlists warm in KV.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshTrending(env));
  },
};
