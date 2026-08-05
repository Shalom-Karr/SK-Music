// Bakes the static Cloudflare bundle from the local corpus database.
// Runs in Node so it can use better-sqlite3 (same query layer as the live API),
// guaranteeing every prebuilt JSON is byte-identical to what the Worker would return.
//
// Outputs: dist/ = shell HTML + versioned /lib modules + pre-rendered /data JSON[.gz]
//
//   node engine/build-static.mjs          full bake (slow; needs corpus.db)
//   node engine/build-static.mjs --code   code-only (fast; re-uses existing dist/data)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  openCorpus, allTracks, allArtists, allAlbums, allPlaylists,
  artistDetail, albumDetail, recentTracks, recentAlbums, stats,
} from "./store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.resolve(HERE, "..");
const DIST  = path.join(ROOT, "dist");
const DATA  = path.join(DIST, "data");
const LIB   = path.join(DIST, "lib");

// Single timestamp shared by: meta.builtAt, sw.js cache key, and all ?v= lib imports.
const BUILD = Date.now();

// CODE_ONLY mode: re-emit only the site code (HTML, libs, sw.js, _headers)
// without touching the data layer. Ideal for fast UI/engine iteration.
// Activate with --code flag or CODE_ONLY=1 env var.
const CODE_ONLY = process.env.CODE_ONLY === "1" || process.argv.includes("--code");

// Canonical site origin — used in sitemaps, OG tags, and IndexNow.
// Canonical origin. Everything derived from it — sitemaps, the OG/canonical tags in the deep-link
// shells, the IndexNow key URL — has to name the host we actually want indexed, or we publish
// thousands of URLs on the host the Worker now redirects away from.
const SITE = (process.env.SITE_URL || "https://skmusic.shalomkarr.com").replace(/\/$/, "");
const CANON_HOST = new URL(SITE).hostname;

// The Worker's canonical redirect only fires for requests that REACH the Worker. run_worker_first is
// deliberately absent (see wrangler.jsonc), so "/" and every pre-baked deep-link shell are served by
// the asset layer and the Worker never runs — measured: /songs/:id 301s, "/" and /artists/:id do not.
// This is the other half, in the page itself, for exactly those asset-served documents.
//
// It skips the DESKTOP shell on purpose. Builds up to 1.2.0 list only the workers.dev origin in their
// Tauri remote capability, so moving them to another origin silently kills the entire event bridge —
// media keys, downloads, the updates card, auto-duck — with no error anywhere. 1.2.1+ opens the
// canonical host directly and trusts both, so it never reaches this code.
const CANON_JS = `<script>(function(){try{var c=${JSON.stringify(CANON_HOST)},h=location.hostname;`
  + `if(h===c||h==="localhost"||h==="127.0.0.1"||h==="::1"||h.slice(-10)===".localhost")return;`
  + `if(window.__TAURI__||window.__TAURI_INTERNALS__)return;`
  + `location.replace("https://"+c+location.pathname+location.search+location.hash);}catch(e){}})();</script>`;

// ── file helpers ──────────────────────────────────────────────────────────────
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

// Recursive file count under a dir — used to keep the build under Cloudflare's 20,000-asset limit.
const countFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);

const ensureWrite = (p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return data.length;
};

const emitJSON = (name, obj) => {
  const s = JSON.stringify(obj);
  console.log(`  data/${name}  ${(s.length / 1024).toFixed(0)} KB`);
  return ensureWrite(path.join(DATA, name), s);
};

const emitGz = (name, obj) => {
  const gz = zlib.gzipSync(JSON.stringify(obj), { level: 9 });
  console.log(`  data/${name}  ${(gz.length / 1024 / 1024).toFixed(2)} MB gzipped`);
  return ensureWrite(path.join(DATA, name), gz);
};

// Fisher-Yates shuffle returning a random sample of up to n elements.
const sample = (arr, n) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

console.log(CODE_ONLY
  ? "building dist/ (code only — reusing existing data) …"
  : "building dist/ …");

if (!CODE_ONLY) { // ===== full build: corpus → dataset + per-entity detail + feeds + sitemaps + taggers =====
  rmrf(DIST);
  const db = openCorpus();

  // Catalog API base — curated playlists list + acapella detection both call it.
  const CATALOG_BASE = (process.env.CATALOG_API || "https://search.zemer.io").replace(/\/$/, "");

  // Public anon key — the same one that ships in the client. Declared here rather than further down
  // because the artist-merge read below has to happen BEFORE the artist index is built.
  const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4dHRxY291YWJkcHRmdGx2Zm5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMTc2OTAsImV4cCI6MjA5ODc5MzY5MH0.DiTcbcKTqXZTJfOqEXfvckiObinN0g15BDbLmAmmdsY";
  const supabaseBase = "https://jxttqcouabdptftlvfnd.supabase.co/rest/v1/";

  // ── corpus rows ────────────────────────────────────────────────────────────
  const tracks    = allTracks(db);
  const artists   = allArtists(db);
  const albums    = allAlbums(db);
  const playlists = allPlaylists(db);

  // ── duplicate artists (supabase/v1.2.8-artist-merge.sql) ──────────────────
  // One person can hold several YouTube channels, and the catalog is keyed on channel id, so they
  // show up as separate artists. An admin marks the duplicate; here we re-point its CONTENT and drop
  // the artist row. Re-pointing rather than deleting matters: a track whose artistId no longer
  // resolves would vanish from the catalog, which is a far worse bug than the duplicate we set out
  // to fix. Best-effort — a Supabase outage bakes the catalog exactly as it is today.
  const mergeAlias = new Map(); // alias channel id → canonical channel id
  try {
    // Timed: a build that hangs forever because a third party stopped answering is worse than a
    // build that ships today's catalogue without a merge that was added an hour ago.
    const res = await fetch(`${supabaseBase}zemer_artist_merge?select=alias_id,canonical_id&limit=5000`,
      { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const known = new Set(artists.map((a) => a.id));
      for (const r of await res.json()) {
        // Both ends must exist in THIS corpus. A merge naming a channel we no longer carry would
        // otherwise strand content on an id nothing emits.
        if (r && r.alias_id && r.canonical_id && r.alias_id !== r.canonical_id
            && known.has(r.alias_id) && known.has(r.canonical_id)) mergeAlias.set(r.alias_id, r.canonical_id);
      }
    }
  } catch (e) {
    console.warn("  artist merges: skipped —", e.message);
  }
  if (mergeAlias.size) {
    const canon = (id) => mergeAlias.get(id) || id;
    for (const t of tracks)    t.artistId = canon(t.artistId);
    for (const x of albums)    x.artistId = canon(x.artistId);
    for (const p of playlists) p.artistId = canon(p.artistId);
    for (let i = artists.length - 1; i >= 0; i--) if (mergeAlias.has(artists[i].id)) artists.splice(i, 1);
    console.log(`  artist merges: ${mergeAlias.size} duplicate${mergeAlias.size === 1 ? "" : "s"} folded in → ${artists.length} artists`);
  }

  // Positional index: artist channel ID → row index in the artists array.
  // The interned dataset stores this integer instead of the full string ID
  // so tracks/albums/playlists stay compact.
  const artistIndex = new Map(artists.map((a, i) => [a.id, i]));

  // Artist flag bitmask packed into a single integer per entity:
  //   bit 0 (1) = female   bit 1 (2) = chasid   bit 2 (4) = kidzone
  const encodeArtistFlags = (a) =>
    (a.isFemale ? 1 : 0) | (a.isChasid ? 2 : 0) | (a.isKidZone ? 4 : 0);

  // Track flag bitmask:  bit 0 (1) = video   bit 1 (2) = explicit
  const encodeTrackFlags = (t) => (t.isVideo ? 1 : 0) | (t.explicit ? 2 : 0);

  // ── external metadata: whitelist + Israeli/Chasidish tag tables ────────────
  // These augment artist records with flags not stored in the corpus
  // (isDJ, isAmerican, isFamous, isIsraeli, isChasidish from Supabase).
  // All fetches are best-effort: a network failure means flags default false
  // and the tagger falls back to its committed bake.
  let whitelistArtists = [];
  const whitelistMeta  = new Map(); // channel_id → { isDJ, isAmerican, isFamous, isChasid }

  try {
    const res = await fetch("https://content.zemer.io/whitelist");
    if (res.ok) {
      const payload = await res.json();
      whitelistArtists = Array.isArray(payload)
        ? payload
        : (payload.artists || payload.channels || []);
      for (const a of whitelistArtists) {
        if (a && a.id) {
          whitelistMeta.set(a.id, {
            isDJ: !!a.isDJ,
            isAmerican: !!a.isAmerican,
            isFamous: !!a.isFamous,
            isChasid: !!a.isChasid,
          });
        }
      }
      console.log(`  whitelist: ${whitelistArtists.length} artists (isChasid=${whitelistArtists.filter(a => a && a.isChasid).length})`);
    }
  } catch (e) {
    console.warn("  whitelist: skipped —", e.message);
  }

  // Per-id content overrides (Zemer's blockedContentIds mirror): { global: [ids hidden for everyone],
  // female: [ids hidden only when female is blocked] }. Each id is a videoId, playlistId, or channelId.
  // This is how a MIXED item — a male-primary track featuring a woman — is caught, which the artist-level
  // isFemale flag misses. Best-effort; empty on failure. Baked to /data/blocked-ids.json for the client.
  let blockedIds = { global: [], female: [] };
  try {
    const res = await fetch("https://content.zemer.io/blockedContentIds");
    if (res.ok) {
      const b = await res.json();
      blockedIds = { global: b.global || [], female: b.female || [] };
      console.log(`  blocked ids: ${blockedIds.global.length} global + ${blockedIds.female.length} female`);
    }
  } catch (e) {
    console.warn("  blocked ids: skipped —", e.message);
  }

  // Paginated Supabase tag reader — streams all rows into a Map<channel_id, boolean>.
  const israeliFlags = new Map();
  const chasidFlags  = new Map();

  const readTagTable = async (table, col, into) => {
    try {
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const res = await fetch(
          `${supabaseBase}${table}?select=channel_id,${col}&order=channel_id&limit=${PAGE}&offset=${from}`,
          { headers: { apikey: SB_ANON, Authorization: "Bearer " + SB_ANON } },
        );
        if (!res.ok) return;
        const rows = await res.json();
        for (const row of rows) into.set(row.channel_id, row[col] === true);
        if (rows.length < PAGE) break;
      }
      console.log(`  ${table}: ${into.size}`);
    } catch (e) {
      console.warn(`  ${table}: skipped —`, e.message);
    }
  };

  await readTagTable("israeli_artist_tag",   "is_israeli",   israeliFlags);
  await readTagTable("chasidish_artist_tag",  "is_chasidish", chasidFlags);

  const getWhitelistMeta = (id) => whitelistMeta.get(id) || {};

  // Last-known-good Acapella playlist, committed to the repo. The upstream index REMOVES the
  // acapella auto-playlist outside Sefira / the Three Weeks (404), but the app's Acapella filter
  // (only/hide) needs its id list year-round — so every consumer below prefers the live playlist
  // and falls back to this copy when the live one is missing or empty. Refresh it by copying a
  // fresh dist/data/zemer-playlist/acapella.json over data/acapella-fallback.json while upstream
  // has the playlist up.
  const acapellaFallback = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data/acapella-fallback.json"), "utf8")); }
    catch { return null; }
  })();

  // ── acapella-only artist detection ────────────────────────────────────────
  // Artists whose entire corpus catalog falls inside the acapella playlist get
  // tagged so the client's "Hide Acapella" filter can suppress the whole artist
  // rather than just individual tracks. Best-effort; skipped on any fetch error.
  const acapellaOnlySet = new Set();
  let acapellaTrackSet = null;   // upstream Acapella playlist videoIds — the same set the client filters against
  try {
    let body = null;
    try {
      const res = await fetch(`${CATALOG_BASE}/zemer-playlists?id=acapella`);
      if (res.ok) body = await res.json();
    } catch { /* fall through to the committed copy */ }
    if (!body || !(body.tracks || []).length) body = acapellaFallback;
    if (body) {
      const acSet = new Set(((body && body.tracks) || []).map((t) => t.videoId));
      acapellaTrackSet = acSet;
      const perArtist = new Map();
      for (const t of tracks) {
        const e = perArtist.get(t.artistId) || { total: 0, ac: 0 };
        e.total++;
        if (acSet.has(t.videoId)) e.ac++;
        perArtist.set(t.artistId, e);
      }
      for (const [id, e] of perArtist) {
        if (e.total > 0 && e.ac === e.total) acapellaOnlySet.add(id);
      }
      console.log(`  acapella-only artists: ${acapellaOnlySet.size} (playlist ${acSet.size} tracks)`);
    }
  } catch (e) {
    console.warn("  acapella-only: skipped —", e.message);
  }

  // ── album → ordered track list (from DB pos column) ───────────────────────
  const albumTrackRows = db.prepare("SELECT albumId, videoId FROM album_track ORDER BY albumId, pos").all();
  const albumTracksMap = {};
  for (const row of albumTrackRows) (albumTracksMap[row.albumId] ||= []).push(row.videoId);
  const trackById = new Map(tracks.map((t) => [t.videoId, t]));

  // ── per-playlist emptiness signals ─────────────────────────────────────────
  // Per playlist: the AUTHORITATIVE whitelisted-track count from the corpus (community_playlist.whitelisted)
  // plus the Acapella count from harvested track membership. The client uses these to drop playlists that
  // resolve to zero hearable songs — chiefly during Sefira / the Three Weeks, when only Acapella is allowed
  // and many playlists contain none. Corpus data only, no live fetch: the ~372 playlists the corpus has data
  // for get counts; the rest stay wl=-1 ("unknown") and render as before (contents load live on open).
  // Acapella set = the upstream Acapella playlist the client filters against, unioned with the corpus
  // snapshot; a playlist is only treated as Acapella-empty when NEITHER source has an Acapella track for it.
  const acapellaVideoIds = new Set(
    db.prepare("SELECT refId FROM zemer_playlist_item WHERE playlistId = 'acapella' AND kind = 'track'").all().map((r) => r.refId),
  );
  if (acapellaTrackSet) for (const v of acapellaTrackSet) acapellaVideoIds.add(v);
  const playlistCounts = new Map();   // playlistId → { wl, aca }; absent → wl=-1 ("unknown", shown as before)
  {
    // wl: authoritative count (never undercounts, so it won't false-hide a playlist that actually has songs).
    const wlCount = new Map(
      db.prepare("SELECT id, whitelisted FROM community_playlist").all().map((r) => [r.id, r.whitelisted]),
    );
    // aca: how many of the playlist's harvested tracks are Acapella (de-duped).
    const acaCount = new Map(), seen = new Map();
    for (const r of db.prepare("SELECT playlistId, videoId FROM community_playlist_track").all()) {
      if (!acapellaVideoIds.has(r.videoId)) continue;
      let s = seen.get(r.playlistId);
      if (!s) { s = new Set(); seen.set(r.playlistId, s); acaCount.set(r.playlistId, 0); }
      if (s.has(r.videoId)) continue;
      s.add(r.videoId);
      acaCount.set(r.playlistId, acaCount.get(r.playlistId) + 1);
    }
    for (const p of playlists) {
      const wl = wlCount.get(p.id);
      if (wl != null) playlistCounts.set(p.id, { wl, aca: acaCount.get(p.id) || 0 });
    }
    console.log(`  playlist counts: ${playlistCounts.size}/${playlists.length} from corpus (authoritative whitelisted + Acapella); rest unknown → shown`);
  }

  // ── interned dataset ───────────────────────────────────────────────────────
  // Compact array-of-arrays format minimises wire size for the ~4 MB full catalog.
  // The client unpacks into proper objects at startup.
  //
  //   artists[i]    = [id, name, thumb, flags]                  flags: 1=female 2=chasid 4=kidzone
  //   tracks[i]     = [videoId, title, artistIdx, flags, dur, plays]  flags: 1=video 2=explicit
  //   albums[i]     = [id, playlistId, title, artistIdx, isSingle, year, thumb]
  //   playlists[i]  = [id, title, artistIdx, thumb, wl, aca]  wl: whitelisted-track count (-1 = unknown), aca: of those, Acapella
  //   albumTracks   = { [albumId]: [videoId, …] }
  const internedDataset = {
    v: 1,
    artists:     artists.map((a) => [a.id, a.name, a.thumbnail || "", encodeArtistFlags(a)]),
    tracks:      tracks.map((t) => [t.videoId, t.title, artistIndex.get(t.artistId) ?? -1, encodeTrackFlags(t), t.durationSec || 0, t.playCount || 0]),
    albums:      albums.map((a) => [a.id, a.playlistId || "", a.title, artistIndex.get(a.artistId) ?? -1, a.type === "single" ? 1 : 0, a.year || 0, a.thumbnail || ""]),
    albumTracks: albumTracksMap,
    playlists:   playlists.map((p) => { const c = playlistCounts.get(p.id); return [p.id, p.title, artistIndex.get(p.artistId) ?? -1, p.thumbnail || "", c ? c.wl : -1, c ? c.aca : 0]; }),
  };
  emitGz("dataset.json.gz", internedDataset);

  // OG lookup for the Worker's server-rendered link previews: videoId → [title, artistName].
  // Keeps the Worker's ogShell lean — it doesn't need the full 4 MB dataset.
  const ogLookup = {};
  for (const t of tracks) {
    ogLookup[t.videoId] = [t.title, artists[artistIndex.get(t.artistId)]?.name || ""];
  }
  emitJSON("og.json", ogLookup);

  // ── per-entity static detail files ────────────────────────────────────────
  // Each artist and album gets a small JSON identical to the live /artist and /album
  // API responses — so entity pages open instantly without fetching the full dataset.
  {
    let artistCount = 0, albumCount = 0, aliasCount = 0;
    // artistDetail() reads the corpus, which still holds the PRE-merge artistIds — the re-point above
    // only touched the in-memory rows. So a merged artist's page has to be assembled from every id
    // that folds into it, or the merge would silently drop the duplicate's whole catalogue.
    const aliasesOf = new Map();
    for (const [alias, canonical] of mergeAlias) {
      if (!aliasesOf.has(canonical)) aliasesOf.set(canonical, []);
      aliasesOf.get(canonical).push(alias);
    }
    const absorb = (into, from, key) => {
      if (!from || !from.length) return;
      const seen = new Set(into.map((x) => x[key]));
      for (const x of from) if (x && !seen.has(x[key])) { into.push(x); seen.add(x[key]); }
    };
    for (const a of artists) {
      const detail = artistDetail(db, a.id);
      if (detail) {
        const aliases = aliasesOf.get(a.id) || [];
        for (const alias of aliases) {
          const extra = artistDetail(db, alias);
          if (!extra) continue;
          absorb(detail.songs, extra.songs, "videoId");
          absorb(detail.videos, extra.videos, "videoId");
          absorb(detail.albums, extra.albums, "id");
          absorb(detail.singles, extra.singles, "id");
          absorb(detail.playlists, extra.playlists, "id");
        }
        if (aliases.length) {
          // The union broke the play-count ordering, and the absorbed releases still carry the
          // DUPLICATE's name — which is the very thing the merge exists to stop showing.
          detail.songs.sort((x, y) => (y.playCount || 0) - (x.playCount || 0));
          for (const r of detail.albums) r.artist = detail.artist.name;
          for (const r of detail.singles) r.artist = detail.artist.name;
          for (const r of detail.playlists) r.artist = detail.artist.name;
        }
        ensureWrite(path.join(DATA, "artist", a.id + ".json"), JSON.stringify(detail));
        artistCount++;
        // Links to the duplicate are already out there — shared, bookmarked, indexed. Serve the
        // merged page at the old id too, tagged so the client can quietly correct the URL, rather
        // than 404ing someone who followed a link that worked yesterday.
        for (const alias of aliases) {
          ensureWrite(path.join(DATA, "artist", alias + ".json"), JSON.stringify({ ...detail, mergedInto: a.id }));
          aliasCount++;
        }
      }
    }
    if (aliasCount) console.log(`  merged-artist aliases: ${aliasCount} old id${aliasCount === 1 ? "" : "s"} still resolve`);
    for (const al of albums) {
      const detail = albumDetail(db, al.id);
      if (detail) {
        ensureWrite(path.join(DATA, "album", al.id + ".json"), JSON.stringify(detail));
        albumCount++;
      }
    }
    console.log(`  per-entity detail: ${artistCount} artists + ${albumCount} albums`);
  }

  // ── home feed builder ──────────────────────────────────────────────────────
  // Produces the /home response: several curated shelves drawn from the corpus.
  // kidZone=true restricts every shelf to isKidZone entities only.
  function buildHomeFeed({ kidZone = false } = {}) {
    const passes = (x) => !kidZone || x.isKidZone;

    const visibleArtists   = artists.filter(passes);
    const visibleAlbums    = albums.filter(passes);
    const visiblePlaylists = playlists.filter(passes);
    const audioTracks      = tracks.filter((t) => !t.isVideo && passes(t));
    const videoTracks      = tracks.filter((t) =>  t.isVideo && passes(t));

    // Wire format for a track entry on any home shelf.
    const trackShape = (t) => ({
      videoId: t.videoId, title: t.title, artist: t.artistName,
      explicit: t.explicit, isVideo: t.isVideo, isFemale: t.isFemale,
      isChasid: t.isChasid, durationSec: t.durationSec,
    });

    // Wire format for an album card (latestReleases + featuredAlbums shelves).
    const albumShape = (a) => ({
      id: a.id, playlistId: a.playlistId, title: a.title, artist: a.artistName,
      year: a.year, thumbnail: a.thumbnail, isFemale: a.isFemale, isChasid: a.isChasid,
    });

    // New-songs shelf: one representative audio track per recent release, ordered by
    // album year (not harvest date), capped at 20. Keeps the shelf diverse —
    // a single album's tracklist never dominates.
    const recentAlbumList = recentAlbums(db, 200).filter(passes);
    const newSongs = [];
    const seenVideoIds = new Set();
    for (const a of recentAlbumList) {
      for (const vid of (albumTracksMap[a.id] || [])) {
        const t = trackById.get(vid);
        if (!t || t.isVideo || seenVideoIds.has(vid) || !passes(t)) continue;
        seenVideoIds.add(vid);
        newSongs.push(trackShape(t));
        break;
      }
      if (newSongs.length >= 20) break;
    }

    return {
      quickPicks:        sample(audioTracks, 24).map(trackShape),
      latestReleases:    recentAlbumList.slice(0, 24).map((a) => ({
        id: a.id, playlistId: a.playlistId, title: a.title, artist: a.artist,
        year: a.year, thumbnail: a.thumbnail, isFemale: a.isFemale, isChasid: a.isChasid,
      })),
      newSongs,
      featuredPlaylists: sample(visiblePlaylists, 12).map((p) => ({
        id: p.id, title: p.title, artist: p.artistName,
        thumbnail: p.thumbnail, isFemale: p.isFemale, isChasid: p.isChasid,
      })),
      trending:          sample(audioTracks, 20).map(trackShape),
      featuredArtists:   sample(visibleArtists, 16).map((a) => ({
        id: a.id, name: a.name, thumbnail: a.thumbnail, isFemale: a.isFemale, isChasid: a.isChasid,
      })),
      featuredAlbums:    sample(visibleAlbums.filter((a) => a.type !== "single"), 16).map(albumShape),
      featuredVideos:    sample(videoTracks, 16).map(trackShape),
    };
  }
  emitJSON("blocked-ids.json",  blockedIds);
  emitJSON("home.json",         buildHomeFeed());
  emitJSON("home.kidzone.json", buildHomeFeed({ kidZone: true }));

  // Artists index: alphabetically sorted, full flag set for client-side filtering.
  const sortedArtists = artists.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  emitJSON("artists.json", {
    count: artists.length,
    artists: sortedArtists.map((a) => ({
      id: a.id,
      name: a.name,
      thumbnail: a.thumbnail,
      isFemale: a.isFemale,
      isChasid: chasidFlags.get(a.id) === true || !!getWhitelistMeta(a.id).isChasid || !!a.isChasid,
      isKidZone: a.isKidZone,
      isDJ: !!getWhitelistMeta(a.id).isDJ,
      isAmerican: !!getWhitelistMeta(a.id).isAmerican,
      isFamous: !!getWhitelistMeta(a.id).isFamous,
      isIsraeli: israeliFlags.get(a.id) === true,
      isAcapellaOnly: acapellaOnlySet.has(a.id),
    })),
  });

  // Corpus health stats for the Worker's /meta endpoint.
  const corpusStats = stats(db);
  const wlFileCount = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, "data/whitelist.json"), "utf8"))
        .filter((a) => /^UC/.test(a.id || "")).length;
    } catch { return 0; }
  })();
  emitJSON("meta.json", { ...corpusStats, whitelistTotal: wlFileCount, builtAt: BUILD });

  // Synonym table — the browser matcher needs this but can't read the filesystem.
  const synonymList = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, "data/synonyms.json"), "utf8")); }
    catch { return []; }
  })();
  emitJSON("synonyms.json", synonymList);

  // ── curated playlists (fetched from upstream catalog at build time) ────────
  // Baked into dist/data so the deployed client reads them same-origin — works
  // behind content filters, no live cross-origin call at runtime.
  // Per-playlist fetches are independent so a single transient failure can't
  // collapse the whole section (the old all-or-nothing approach did exactly that).
  // Base URL shape: GET /zemer-playlists (list), /zemer-playlists?id= (detail),
  // /zemer-playlists/cover?id= (SVG cover).
  await (async () => {
    // Retry wrapper: up to 3 attempts with 1.5 s / 3 s backoff.
    const fetchWithRetry = async (urlPath, attempts = 3) => {
      let lastError;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const res = await fetch(CATALOG_BASE + urlPath, { signal: AbortSignal.timeout(25000) });
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res;
        } catch (e) {
          lastError = e;
          if (attempt < attempts - 1) {
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
      }
      throw lastError;
    };
    const fetchJSON = async (urlPath) => (await fetchWithRetry(urlPath)).json();

    // SVG covers are rewritten to same-origin paths so they serve without CORS.
    const coverPath = (id) => "/data/zemer-playlist/" + id + ".svg";

    let catalogList;
    try {
      const listBody = await fetchJSON("/zemer-playlists");
      catalogList = listBody.playlists || [];
    } catch (e) {
      console.warn(`  !! curated playlists: LIST FETCH FAILED from ${CATALOG_BASE} — ${e.message}. Section renders empty (plus the acapella fallback below). !!`);
      catalogList = []; // never throw — continue so the acapella fallback still bakes
    }
    console.log(`  curated playlists: fetched ${catalogList.length} from ${CATALOG_BASE}, baking details + covers…`);

    const successfulPlaylists = [];
    for (const entry of catalogList) {
      try {
        const detail = await fetchJSON("/zemer-playlists?id=" + encodeURIComponent(entry.id));
        if (detail.playlist) detail.playlist.thumbnail = coverPath(entry.id);
        ensureWrite(path.join(DATA, "zemer-playlist", entry.id + ".json"), JSON.stringify(detail));

        try {
          const coverRes = await fetchWithRetry("/zemer-playlists/cover?id=" + encodeURIComponent(entry.id));
          ensureWrite(path.join(DATA, "zemer-playlist", entry.id + ".svg"), await coverRes.text());
        } catch (ce) {
          console.warn(`  !! curated playlists: cover failed for "${entry.id}" — ${ce.message} (card falls back to placeholder)`);
        }

        successfulPlaylists.push({ ...entry, thumbnail: coverPath(entry.id) });
      } catch (de) {
        console.warn(`  !! curated playlists: detail failed for "${entry.id}" — ${de.message} (dropping this playlist)`);
      }
    }

    // The Acapella detail MUST exist in every build — the client's Acapella filter reads it. When
    // upstream dropped the playlist (seasonal 404) bake the committed last-known-good copy instead,
    // and give it a list entry so it stays reachable from the Curated Playlists rail.
    if (!successfulPlaylists.some((p) => p.id === "acapella") && acapellaFallback) {
      ensureWrite(path.join(DATA, "zemer-playlist", "acapella.json"), JSON.stringify(acapellaFallback));
      try { fs.copyFileSync(path.join(ROOT, "data/acapella-fallback.svg"), path.join(DATA, "zemer-playlist", "acapella.svg")); } catch { /* card falls back to placeholder */ }
      const meta = acapellaFallback.playlist || {};
      successfulPlaylists.push({ id: "acapella", title: meta.title || "Acapella", trackCount: (acapellaFallback.tracks || []).length, thumbnail: coverPath("acapella") });
      console.log(`  curated playlists: acapella restored from data/acapella-fallback.json (${(acapellaFallback.tracks || []).length} tracks — upstream has it removed off-season)`);
    }

    emitJSON("zemer-playlists.json", { count: successfulPlaylists.length, playlists: successfulPlaylists });
    if (successfulPlaylists.length && successfulPlaylists.length >= catalogList.length) {
      console.log(`  curated playlists: baked ${successfulPlaylists.length}/${catalogList.length} (from ${CATALOG_BASE})`);
    } else {
      console.warn(`  !! curated playlists: baked ${successfulPlaylists.length}/${catalogList.length} — ${successfulPlaylists.length ? "some playlists missing" : "SECTION WILL BE EMPTY"} !!`);
    }
  })();

  // ── podcast show index (baked from upstream at build time) ─────────────────
  // The podcast whitelist moves on the order of weeks, so this is a SNAPSHOT rather than a live
  // proxy: a static asset is served without invoking the Worker at all, where a proxy route would
  // cost one Worker request per page view. The client derives the Podcasters rail from this file,
  // so neither the rail nor the show lookup spends a request.
  //
  // Two upstreams, because neither alone is sufficient:
  //   search.zemer.io/podcasts        — id, name, author (the HOST CHANNEL name), channelId, thumbnail
  //   content.zemer.io/podcastsWhitelist — isFemale / isKidZone / isVerified, which live only here
  // Upstream does NOT apply allowFemale to the podcast endpoints (verified: ?allowFemale=0 returns
  // the full list, kol-isha shows included), so those flags are what the client gates on — if the
  // whitelist half fails we bake NOTHING rather than a list we can't filter. Fail closed.
  await (async () => {
    const grab = async (url) => {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(25000) }); return r.ok ? await r.json() : null; }
      catch { return null; }
    };
    const [index, whitelist] = await Promise.all([
      grab(CATALOG_BASE + "/podcasts"),
      grab("https://content.zemer.io/podcastsWhitelist"),
    ]);
    const shows = (index && index.podcasts) || [];
    if (!shows.length || !Array.isArray(whitelist) || !whitelist.length) {
      console.warn("  !! podcasts: index or whitelist fetch failed — Podcasters rail will not render this build !!");
      return;
    }
    const flags = new Map(whitelist.map((d) => [d.docId || d.id, d]));
    emitJSON("podcasts.json", {
      version: index.version || 0,
      shows: shows.map((p) => {
        const f = flags.get(p.id) || {};
        return {
          id: p.id, name: p.name || "", author: p.author || "",
          channelId: p.channelId || "", thumbnail: p.thumbnail || "",
          ...(f.isFemale ? { isFemale: 1 } : {}),
          ...(f.isKidZone ? { isKidZone: 1 } : {}),
          ...(f.isVerified ? { isVerified: 1 } : {}),
        };
      }),
    });
    const hosts = new Set(shows.map((p) => p.channelId).filter(Boolean));
    console.log(`  podcasts: baked ${shows.length} shows across ${hosts.size} host channels (from ${CATALOG_BASE})`);
  })();

  // ── TorahAnytime catalog snapshot (Shiurim tab) ────────────────────────────
  // The Shiurim tab talks to api.torahanytime.com DIRECTLY from the browser (that API echoes any
  // request Origin back in Access-Control-Allow-Origin), so no part of the feature costs a Worker
  // request. The three SLOW-MOVING lists — the topic tree, the speaker directory, the series index —
  // are snapshotted here instead: a static asset is served without invoking the Worker at all, and
  // /speakers alone is a measured ~8 s / 1.07 MB cold call that would otherwise sit in front of the
  // tab's first paint. Lectures themselves stay live (they change hourly and carry the media URLs).
  //
  // Every field the client never reads is dropped — the raw three total ~1.3 MB, mostly speaker bios
  // and phone-extension bookkeeping. Fails SOFT, unlike the podcast bake: there is no flag half here
  // that the client depends on for gating (kol isha is decided per-lecture from flags on the live
  // record), so a missing file just means the browse rails don't render.
  await (async () => {
    const grab = async (url) => {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(45000) }); return r.ok ? await r.json() : null; }
      catch { return null; }
    };
    // TWO speaker sources, merged. /speakers is the "house" directory — 573 non-guests, and the only
    // place `lecture_languages` exists. /search/speakers/alphabet?include-guest=true is what
    // TorahAnytime's own frontend paginates and is the COMPLETE one (1336 unique, 763 of them guests),
    // so it is the base and /speakers only enriches it with languages.
    // Paged at 500 (measured ~1.3 s a page) rather than in one 2 s call — this is someone else's API
    // and we are a guest on it. `totalSpeakers` reports 1352 but only ~1336 are ever emitted (the
    // response buckets by first letter of the LAST name, and a handful sort outside A–Z with no
    // bucket to land in), so the loop terminates on offset, never on a count it can't reach.
    const alphaPages = [];
    for (let off = 0; off < 2000; off += 500) {
      const p = await grab(`https://api.torahanytime.com/search/speakers/alphabet?include-guest=true&limit=500&offset=${off}`);
      if (!p) break;
      alphaPages.push(p);
      if (off + 500 >= (p.totalSpeakers || 0)) break;
    }
    const [topicsRaw, speakersRaw, seriesRaw] = await Promise.all([
      grab("https://api.torahanytime.com/topics"),
      grab("https://api.torahanytime.com/speakers"),
      grab("https://api.torahanytime.com/series/basic?limit=5000"),
    ]);
    // Only categories that actually have lectures — the tree carries a number of empty scaffolding
    // nodes (ja-categories placeholders with lectures: 0) that would render as dead cards.
    const topic = (t) => ({
      id: t.id, name: t.english_name || t.name || "", n: t.lectures || 0,
      ...(Array.isArray(t.subCategory) && t.subCategory.length
        ? { sub: t.subCategory.filter((s) => s.display_active !== false).map((s) => ({ id: s.id, name: s.english_name || s.name || "", n: s.lectures || 0 })) }
        : {}),
    });
    const topics = ((topicsRaw && topicsRaw.topics) || [])
      .filter((t) => t.display_active !== false && (t.lectures || 0) > 0).map(topic)
      .sort((a, b) => b.n - a.n);
    // `female` rides along so the kol-isha filter can drop a speaker CARD without first fetching her
    // lectures; `no_download` is carried for the same reason a lecture's own flag is (the app must
    // never offer a save for a speaker who forbids it).
    // `langs` are the language IDS this speaker actually teaches in (upstream `lecture_languages` is
    // [{id,name}]). Same id the live lecture endpoints take as `?language=`, so the tab's language
    // filter can narrow the BAKED speaker directory client-side and the live feeds server-side with
    // one value. A speaker with no languages listed keeps no `langs` key and fails OPEN (shown under
    // every language) — an absent list upstream means "unknown", not "none".
    const langName = new Map(), langById = new Map();
    for (const s of (speakersRaw && speakersRaw.speakers) || []) {
      const raw = s.lecture_languages;
      const langs = [...new Set((Array.isArray(raw) ? raw : raw && raw.id ? [raw] : [])
        .filter((l) => l && l.id).map((l) => { langName.set(+l.id, (l.name || "").trim()); return +l.id; }))];
      if (langs.length) langById.set(s.id, langs);
    }
    // The alphabet endpoint answers { speakers: { A: [...], Z: [] } } per page; /speakers answers a
    // flat array. Prefer the alphabet pages and fall back to the flat list so one dead endpoint still
    // leaves a usable directory. It already returns ONLY live speakers with >= 1 lecture (measured:
    // zero deleted, zero inactive, zero with no lectures across all 1336), so there is nothing to
    // re-filter here. Dedupe by ID, never by name — there are two distinct "Shlomo Bineth".
    const alphaList = alphaPages.flatMap((p) => (p.speakers && typeof p.speakers === "object")
      ? Object.keys(p.speakers).flatMap((k) => p.speakers[k] || []) : []);
    const rawSpeakers = alphaList.length ? alphaList : ((speakersRaw && speakersRaw.speakers) || []);
    const seenSpk = new Set();
    // `name` is assembled once, here — several rows carry leading/trailing spaces in name_first, and
    // not every row is even a person (id 1399 is "Audio Book", with a numeric title and no honorific).
    const allSpeakers = rawSpeakers
      .filter((s) => s && s.id && !seenSpk.has(s.id) && seenSpk.add(s.id))
      .map((s) => {
        const langs = langById.get(s.id) || [];
        return {
          id: s.id, name: [s.title_short, s.name_first, s.name_last].map((x) => String(x || "").trim()).filter(Boolean).join(" "),
          photo: s.photo || "", n: s.lecture_count || 0,
          ...(s.female ? { female: 1 } : {}), ...(s.no_download ? { noDl: 1 } : {}), ...(s.is_guest ? { g: 1 } : {}),
          ...(langs.length ? { langs } : {}),
        };
      })
      .sort((a, b) => b.n - a.n);
    // GUEST FLOOR. Guests are 57% of the directory but 6% of the catalog: 763 people, median 6
    // lectures, 192 of them with exactly one. Padding a browse grid with 192 one-shot entries makes
    // the directory worse, but 59 guests have 100+ lectures (the top one has 1427 — more than most
    // house speakers), so excluding them wholesale loses real content. The floor keeps anyone who has
    // actually built a body of work. Everyone else still resolves by search and by direct link,
    // because the FULL list ships too — just in its own lazily-fetched file.
    const GUEST_FLOOR = 10;
    const speakers = allSpeakers.filter((s) => !s.g || s.n >= GUEST_FLOOR);
    // The language chip row, ordered by how many speakers teach in each — so English leads and the
    // long tail (Arabic, Sign Language) sorts to the end instead of needing a hardcoded order.
    const langN = new Map();
    for (const s of allSpeakers) for (const id of s.langs || []) langN.set(id, (langN.get(id) || 0) + 1);
    const languages = [...langName].map(([id, name]) => ({ id, name, n: langN.get(id) || 0 }))
      .filter((l) => l.name && l.n).sort((a, b) => b.n - a.n);
    // Daily / recurring series. TorahAnytime exposes NO cadence field anywhere (confirmed against
    // /series/basic and /series/{id}: the only related flag is `completed`), so this is a title
    // heuristic and nothing more — "Daf Yomi", "Amud HaYomi", "Daily Mussar", "Two Minute Daily
    // Halacha". It is deliberately conservative: a false negative just means a series doesn't appear
    // in one extra rail, and it is computed HERE so the client spends nothing deciding it.
    const DAILY_RX = /\b(daily|yomi|yomit|a day|per day|dose|minute|minutes)\b|\bdaf\b|\bamud\b/i;
    // Speaker gender resolved at BAKE time, against the full directory: the client's kol-isha check on
    // a series used to need the speaker map at runtime, which stops being safe the moment the full
    // speaker list is a separate lazily-fetched file.
    const femaleSpk = new Set(allSpeakers.filter((s) => s.female).map((s) => s.id));
    const series = ((seriesRaw && seriesRaw.series) || [])
      .filter((s) => (s.count || 0) > 0)
      .map((s) => ({
        id: s.id, title: s.title || "", n: s.count || 0,
        speaker: [(s.speaker_title_short || "").trim(), (s.speaker_name_first || "").trim(), (s.speaker_name_last || "").trim()].filter(Boolean).join(" "),
        speakerId: s.speaker_id || 0,
        ...(s.female || s.female_only || femaleSpk.has(s.speaker_id) ? { female: 1 } : {}),
        ...(DAILY_RX.test(s.title || "") ? { d: 1 } : {}),
      }))
      .sort((a, b) => b.n - a.n);
    // Shorts — TorahAnytime "clips": a couple of minutes cut out of a full shiur, which the Shiurim
    // tab shows as story circles. /clips is ordered OLDEST first, so the newest ones live at the far
    // end of the range and the offset is computed from the reported total (6136 at time of writing).
    // Only what the row actually renders is kept — the raw page is ~3.7 KB a record, almost all of it
    // vimeo bookkeeping and download-size strings. The kol-isha flags collapse to one `female`, which
    // is exactly what shFemaleRec() reads.
    const SHORT_MAX_SEC = 300;   // above ~5 min it stops being a clip and belongs in a list, not a story
    const SHORT_KEEP = 150;      // the row shows 24 speakers × up to 8 clips; 150 fills it with room to spare
    const clipHead = await grab("https://api.torahanytime.com/clips?limit=1&offset=0");
    const clipTotal = (clipHead && clipHead.clipAmount) || 0;
    const clipsRaw = clipTotal ? await grab(`https://api.torahanytime.com/clips?limit=400&offset=${Math.max(0, clipTotal - 400)}`) : null;
    const shorts = ((clipsRaw && clipsRaw.clips) || [])
      .filter((c) => c && c.id && c.mp4_url && c.display_active !== false && !c.is_not_discoverable && !c.private
        && (c.duration || 0) > 0 && c.duration <= SHORT_MAX_SEC && c.speaker)
      .sort((a, b) => b.id - a.id)
      .slice(0, SHORT_KEEP)
      .map((c) => ({
        id: c.id, title: c.clip_title || c.title || "", duration: c.duration || 0, date_recorded: c.date_recorded || "",
        speaker: c.speaker || 0,
        speaker_name_first: (c.speaker_name_first || "").trim(), speaker_name_last: (c.speaker_name_last || "").trim(),
        speaker_title_short: (c.speaker_title_short || "").trim(),
        language: c.language || 0, language_name: c.language_name || "",
        mp4_url: c.mp4_url, thumbnail_url: c.thumbnail_url || "",
        ...(c.female || c.is_only_listenable_by_female || c.is_only_watchable_by_female || c.is_only_discoverable_by_female ? { female: 1 } : {}),
      }));
    if (!topics.length && !speakers.length && !series.length) {
      console.warn("  !! shiurim: TorahAnytime catalog fetch failed — browse rails will not render this build !!");
      return;
    }
    // TWO files on purpose. shiurim.json is fetched the moment the Shiurim tab opens, so it carries
    // only what that page renders — the browse directory, the topic tree, the series index. The FULL
    // speaker list (including every one-lecture guest) is its own asset, fetched only by the
    // see-all-speakers route and by a deep link to a speaker the browse list doesn't hold.
    emitJSON("speakers.json", { speakers: allSpeakers });
    emitJSON("shiurim.json", { topics, speakers, series, languages, shorts });
    const daily = series.filter((s) => s.d).length;
    console.log(`  shiurim: baked ${topics.length} topics · ${speakers.length}/${allSpeakers.length} speakers (guest floor ${GUEST_FLOOR}) · ${series.length} series (${daily} daily/recurring) · ${shorts.length} shorts · ${languages.length} languages (from api.torahanytime.com)`);
  })();

  // ── sitemaps ───────────────────────────────────────────────────────────────
  // Sitemap index → per-type sitemaps covering every URL in the app (~90k entries).
  // Chunked at 45k URLs per file (the spec caps at 50k).
  const escXml = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

  const sitemapDoc = (locs) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    locs.map((l) => `<url><loc>${SITE}${escXml(l)}</loc></url>`).join("\n") +
    `\n</urlset>\n`;

  const SITEMAP_CHUNK = 25000;   // cap URLs per sitemap so each file stays small + quick for crawlers to fetch
  const registeredSitemaps = [];

  const writeSitemapGroup = (groupName, urls) => {
    if (!urls.length) return;
    if (urls.length <= SITEMAP_CHUNK) {
      const fname = `sitemap-${groupName}.xml`;
      ensureWrite(path.join(DIST, fname), sitemapDoc(urls));
      registeredSitemaps.push(fname);
      return;
    }
    for (let offset = 0, part = 1; offset < urls.length; offset += SITEMAP_CHUNK, part++) {
      const fname = `sitemap-${groupName}-${part}.xml`;
      ensureWrite(path.join(DIST, fname), sitemapDoc(urls.slice(offset, offset + SITEMAP_CHUNK)));
      registeredSitemaps.push(fname);
    }
  };

  writeSitemapGroup("static",    ["/", "/foryou", "/search", "/artists", "/playlists", "/kidzone", "/library", "/about"]);
  writeSitemapGroup("artists",   artists.map((a) => "/artists/" + a.id));
  writeSitemapGroup("albums",    albums.map((a) => "/albums/" + a.id));
  writeSitemapGroup("playlists", playlists.map((p) => "/playlists/" + p.id));
  writeSitemapGroup("songs",     tracks.map((t) => "/song/" + t.videoId));
  writeSitemapGroup("kidzone",   ["/kidzone", ...artists.filter((a) => a.isKidZone).map((a) => "/artists/" + a.id)]);

  ensureWrite(
    path.join(DIST, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    registeredSitemaps.map((f) => `<sitemap><loc>${SITE}/${f}</loc></sitemap>`).join("\n") +
    `\n</sitemapindex>\n`,
  );
  ensureWrite(path.join(DIST, "robots.txt"),
    `User-agent: *\nAllow: /\nDisallow: /analytics\nDisallow: /admin\n\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log(`  sitemaps: ${registeredSitemaps.length} files + index (${tracks.length + artists.length + albums.length + playlists.length} entity URLs) → ${SITE}/sitemap.xml`);

  // IndexNow (Bing/Edge instant indexing) — the key file must sit at the site root and
  // contain only the key as its body.
  const INDEXNOW_KEY = "652ada1f90c5acb347dbd074445c5918";
  ensureWrite(path.join(DIST, INDEXNOW_KEY + ".txt"), INDEXNOW_KEY);
  console.log(`  indexnow key: ${SITE}/${INDEXNOW_KEY}.txt`);

  // ── deep-link OG shells ────────────────────────────────────────────────────
  // Pre-render a tiny static HTML shell for every artist + playlist deep link. A crawler or shared-link
  // hit is then served straight from the asset layer (no Worker — these were ~28% of all Worker requests)
  // with correct Open Graph tags. The shell shows the logo + title, then fetches "/" and document.writes
  // the full SPA in place — which routes by pathname, so a real visitor lands on the same artist/playlist,
  // URL unchanged. The Worker's renderDeepLinkShell stays as the fallback for any id not pre-baked (e.g. a
  // new entity created between builds).
  (() => {
    const esc = (v) => String(v == null ? "" : v).replace(/[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const ogTags = ({ title, description, image, type }) => {
      const t = [`<meta property="og:type" content="${esc(type)}">`,
        `<meta property="og:title" content="${esc(title)}"><meta name="twitter:title" content="${esc(title)}">`,
        `<meta property="og:description" content="${esc(description)}"><meta name="twitter:description" content="${esc(description)}">`];
      if (image) t.push(`<meta property="og:image" content="${esc(image)}"><meta name="twitter:image" content="${esc(image)}">`);
      return t.join("");
    };
    // schema.org JSON-LD for Google rich results — MusicGroup for artists, MusicPlaylist for playlists.
    // `<` is escaped so the JSON can't break out of the <script>.
    const ldTag = ({ title, image, type, urlPath }) => {
      const T = type === "profile" ? "MusicGroup" : type === "music.playlist" ? "MusicPlaylist" : null;
      if (!T || !title) return "";
      const o = { "@context": "https://schema.org", "@type": T, name: title, url: SITE + urlPath };
      if (image) o.image = image;
      return `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
    };
    const shell = ({ title, description, image, type, urlPath }) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0e0a0b">` +
      `<title>${esc(title)} | SK Music</title><meta name="description" content="${esc(description)}">` +
      `<link rel="canonical" href="${SITE}${urlPath}"><link rel="icon" type="image/svg+xml" href="/assets/skmusic_logo.svg">` +
      `<meta property="og:site_name" content="SK Music"><meta property="og:url" content="${SITE}${urlPath}"><meta name="twitter:card" content="summary_large_image">` +
      ogTags({ title, description, image, type }) +
      ldTag({ title, image, type, urlPath }) +
      CANON_JS +
      `<style>html,body{margin:0;height:100%;background:#0e0a0b;color:#f5f5f5;font-family:system-ui,-apple-system,sans-serif}` +
      `#s{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;box-sizing:border-box}` +
      `#s img{width:84px;height:84px}#s h1{margin:0;font-size:17px;font-weight:600;opacity:.8;text-align:center}</style></head>` +
      `<body><div id="s"><img src="/assets/skmusic_logo.svg" alt="SK Music"><h1>${esc(title)}</h1></div>` +
      `<script>fetch("/").then(function(r){return r.text()}).then(function(h){document.open();document.write(h);document.close()}).catch(function(){});</script>` +
      `<noscript><a href="/" style="color:#f5f5f5">Open SK Music</a></noscript></body></html>`;

    const safeId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
    // Cloudflare caps a deployment at 20,000 assets. Pre-baking is an OPTIMIZATION, not a requirement —
    // only bake as many shells as fit under FILE_CAP (RESERVE leaves room for the always-run assets written
    // after this block). Any deep-link WITHOUT a pre-baked file just falls to the Worker's
    // renderDeepLinkShell — same correct OG, served dynamically ("non-file") instead of from the asset
    // layer. So the site never breaks as the catalog grows; it degrades to more Worker requests.
    // See docs/asset-file-limit.md.
    const FILE_CAP = 19800, RESERVE = 40;
    let budget = FILE_CAP - RESERVE - countFiles(DIST);
    let nA = 0, nP = 0, viaWorker = 0;
    for (const a of artists) {
      if (!safeId(a.id)) continue;
      if (budget <= 0) { viaWorker++; continue; }
      ensureWrite(path.join(DIST, "artists", a.id + ".html"), shell({
        title: a.name || "Artist", description: "Artist · SK Music",
        image: a.thumbnail || null, type: "profile", urlPath: "/artists/" + a.id }));
      nA++; budget--;
    }
    for (const p of playlists) {
      if (!safeId(p.id)) continue;
      if (budget <= 0) { viaWorker++; continue; }
      ensureWrite(path.join(DIST, "playlists", p.id + ".html"), shell({
        title: p.title || "Playlist", description: "Playlist · SK Music",
        image: p.thumbnail || null, type: "music.playlist", urlPath: "/playlists/" + p.id }));
      nP++; budget--;
    }
    if (viaWorker)
      console.log(`  deep-link OG shells: ${nA} artists + ${nP} playlists pre-baked; ${viaWorker} over the ${FILE_CAP}-file cap → served dynamically by the Worker`);
    else
      console.log(`  deep-link OG shells: ${nA} artists + ${nP} playlists → asset-served (no Worker)`);
  })();

  // ── admin taggers ──────────────────────────────────────────────────────────
  // Israeli and Chasidish taggers are both generated from one shared HTML template
  // by swapping the CFG constant and, when the whitelist is available, the ARTISTS array.
  // Falls back to the committed bake when the whitelist fetch failed earlier.
  try {
    const taggerTemplate = fs.readFileSync(path.join(ROOT, "assets/israeli-artist-tagger.html"), "utf8");
    const ucArtists = whitelistArtists.filter((a) => a && a.id && /^UC/.test(a.id));

    let artistsReplacement = null;
    if (ucArtists.length) {
      const thumbIndex = new Map(artists.map((a) => [a.id, a.thumbnail || ""]));
      const taggerList = ucArtists
        .map((a) => ({
          id: a.id, name: a.name || "",
          thumbnail: thumbIndex.get(a.id) || "",
          isFemale: !!a.isFemale, isChasid: !!a.isChasid, isKidZone: !!a.isKidZone,
          isDJ: !!a.isDJ, isAmerican: !!a.isAmerican, isFamous: !!a.isFamous,
        }))
        .sort((x, y) => (x.name || "").localeCompare(y.name || ""));
      artistsReplacement = "const ARTISTS = " + JSON.stringify(taggerList).replace(/</g, "\\u003c") + ";";
      console.log(`  taggers: ${taggerList.length} artists (live whitelist)`);
    } else {
      console.log("  taggers: whitelist unavailable — using committed bake");
    }

    const taggerVariants = [
      { file: "israeli-tagger.html",   cfg: { table: "israeli_artist_tag",   col: "is_israeli",   label: "Israeli",   emoji: "🇮🇱", lsKey: "sk_israeli_tags_v1",   title: "Israeli Artist Tagger"   } },
      { file: "chasidish-tagger.html", cfg: { table: "chasidish_artist_tag", col: "is_chasidish", label: "Chasidish", emoji: "🎩",  lsKey: "sk_chasidish_tags_v1", title: "Chasidish Artist Tagger" } },
    ];

    for (const { file, cfg } of taggerVariants) {
      let html = artistsReplacement
        ? taggerTemplate.replace(/const ARTISTS = \[[\s\S]*?\];/, artistsReplacement)
        : taggerTemplate;
      html = html.replace(/const CFG = \{[^;]*\};/, "const CFG = " + JSON.stringify(cfg) + ";");
      ensureWrite(path.join(DIST, file), html);
    }
  } catch (e) {
    console.warn("  taggers: skipped —", e.message);
  }

  db.close();
} // ===== end full build =====

// ── browser-compatible engine modules ─────────────────────────────────────────
// synonyms.mjs has Node-only imports at the top; strip them so the module loads in browsers.
const synBrowser = fs.readFileSync(path.join(ROOT, "engine/synonyms.mjs"), "utf8")
  .replace(/^import fs from "node:fs";\n/m, "")
  .replace(/^import path from "node:path";\n/m, "")
  .replace(/^import \{ fileURLToPath \} from "node:url";\n/m, "")
  .replace(/^export const SYNONYMS_PATH .*$/m, "")
  .replace(/^export const loadDefaultSynonyms .*$/m, "")
  .replace(/^export function loadSynonyms[\s\S]*?\n}\n/m, "");

// Stamp ?v=BUILD on every relative .mjs import so the browser always resolves to a
// versioned, immutable URL. _headers marks /lib/* immutable; a new build changes
// BUILD → new URLs → the browser refetches rather than serving stale modules.
const verLib = (src) => src.replace(/(from\s+["'])(\.\/[\w.-]+\.mjs)(["'])/g, `$1$2?v=${BUILD}$3`);

for (const modName of ["normalize.mjs", "search.mjs", "categories.mjs"]) {
  ensureWrite(path.join(LIB, modName), verLib(fs.readFileSync(path.join(ROOT, "engine", modName), "utf8")));
}
ensureWrite(path.join(LIB, "synonyms.mjs"),     verLib(synBrowser));
ensureWrite(path.join(LIB, "engine.mjs"),        verLib(fs.readFileSync(path.join(ROOT, "engine/engine.mjs"), "utf8")));
ensureWrite(path.join(LIB, "engine-worker.mjs"), verLib(fs.readFileSync(path.join(ROOT, "engine/engine-worker.mjs"), "utf8")));

// hls.js — used ONLY when a filmed shiur is watched, and loaded lazily by ui.html at that moment, so
// it never costs a byte on a normal visit. It is here rather than in a CDN tag because script-src is
// 'self'. The LIGHT build drops alt-audio/subtitle handling, which TorahAnytime renditions don't use.
// If the dependency is ever missing, ship without it: hlsAttach() falls back to the progressive mp4,
// so the only consequence is the slower start this was added to avoid.
{
  const hlsSrc = path.join(ROOT, "node_modules/hls.js/dist/hls.light.min.js");
  if (fs.existsSync(hlsSrc)) {
    const b = fs.readFileSync(hlsSrc);
    ensureWrite(path.join(LIB, "hls.js"), b);
    console.log(`  lib/hls.js  ${Math.round(b.length / 1024)} KB (lazy — only on watch)`);
  } else {
    console.warn("  lib/hls.js  MISSING (npm i hls.js) — filmed shiurim fall back to progressive mp4");
  }
}

// ── index.html ─────────────────────────────────────────────────────────────────
// Start from assets/ui.html and inject: static-build marker, optional analytics
// beacon, default OG block, and versioned engine import paths.
const cfAnalyticsToken = process.env.CF_ANALYTICS_TOKEN || "";
const analyticsBeacon = cfAnalyticsToken
  ? `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "${cfAnalyticsToken}", "spa": true}'></script>`
  : "";
if (cfAnalyticsToken) console.log("  analytics: Cloudflare Web Analytics beacon injected");

// Default branded OG baked into the shell so "/" (served as a static asset,
// bypassing the Worker) previews SK Music when the link is shared.
// The Worker's ogShell overrides the <!--OG-->…<!--/OG--> block for song deep links.
const OG_DEF =
  `<meta property="og:title" content="SK Music"><meta name="twitter:title" content="SK Music">` +
  `<meta property="og:description" content="Kosher music, by construction — a whitelisted catalog of Jewish music.">` +
  `<meta name="twitter:description" content="Kosher music, by construction — a whitelisted catalog of Jewish music.">` +
  `<meta property="og:image" content="${SITE}/assets/og.png"><meta name="twitter:image" content="${SITE}/assets/og.png">`;

const indexHtml = fs.readFileSync(path.join(ROOT, "assets/ui.html"), "utf8")
  // NOTE: <!--STATIC_BUILD--> is not present in assets/ui.html, so this replace has always been a
  // no-op and `sk-static` appears zero times in the built output. Left as-is rather than silently
  // dropped — but nothing may be hung off it, which is why the canonical redirect goes on the
  // CF_ANALYTICS marker below, which does exist.
  .replace("<!--STATIC_BUILD-->",   '<meta name="sk-static" content="1">')
  // CANON_JS first: it must run before anything else on the page, and it fires whether or not an
  // analytics token is configured (the beacon collapses to "" without one).
  .replace("<!--CF_ANALYTICS-->",   CANON_JS + analyticsBeacon)
  .replace("<!--OGTAGS-->",         `<!--OG-->${OG_DEF}<!--/OG-->`)
  .replace('"/lib/engine.mjs"',        `"/lib/engine.mjs?v=${BUILD}"`)
  .replace('"/lib/engine-worker.mjs"', `"/lib/engine-worker.mjs?v=${BUILD}"`);
ensureWrite(path.join(DIST, "index.html"), indexHtml);

// Static assets: logo, favicon, PWA icons, manifest — everything except .html files.
fs.cpSync(path.join(ROOT, "assets"), path.join(DIST, "assets"), {
  recursive: true,
  filter: (s) => !s.endsWith(".html"),
});

// favicon.ico at the ROOT: browsers auto-request /favicon.ico, so serving it as a static file keeps that
// request on the asset layer instead of falling through to the Worker (it was ~15% of all Worker hits).
// The .ico is a real multi-size icon built from the logo — regenerate with `npm run favicon`.
fs.copyFileSync(path.join(ROOT, "assets/favicon.ico"), path.join(DIST, "favicon.ico"));

// Redirector add-on: the install page is an in-app SPA route (/redirector), so here we only ship the
// userscript at /redirector.user.js (its @downloadURL — same origin, so it works behind filters) and its
// two setup screenshots into /assets for that page to show.
fs.copyFileSync(path.join(ROOT, "redirector/youtube-to-skmusic.user.js"), path.join(DIST, "redirector.user.js"));
for (const png of ["chrome.png", "edge.png"]) fs.copyFileSync(path.join(ROOT, "redirector", png), path.join(DIST, "assets", "rd-" + png));

// Admin analytics dashboard — Supabase auth + zemer_admin role required; noindex.
ensureWrite(path.join(DIST, "analytics.html"), fs.readFileSync(path.join(ROOT, "assets/analytics.html"), "utf8"));
// Admin console — same zemer_admin gate; every read/write goes through the admin_* SECURITY DEFINER
// RPCs, which re-check membership server-side (the anon key is public, so the UI gates nothing).
ensureWrite(path.join(DIST, "admin.html"), fs.readFileSync(path.join(ROOT, "assets/admin.html"), "utf8"));

// Network connectivity test page — diagnoses filter/whitelist blocks and a real playback test.
ensureWrite(path.join(DIST, "test.html"), fs.readFileSync(path.join(ROOT, "assets/connectivity.html"), "utf8"));

// Public trending charts page — served at /charts by the asset layer, and at /trending for browser
// navigations (the Worker content-negotiates; fetch() clients keep getting the JSON API). Deliberately
// NOT named trending.html: an asset at that path would shadow the /trending route entirely.
ensureWrite(path.join(DIST, "charts.html"), fs.readFileSync(path.join(ROOT, "assets/charts.html"), "utf8"));

// Deep playback diagnostic — served at /playback-block-test (asset layer, via html_handling; no Worker).
// Isolates each layer of the YouTube stack (domain → iframe_api → embed → media) to pinpoint a block.
ensureWrite(path.join(DIST, "playback-block-test.html"), fs.readFileSync(path.join(ROOT, "assets/playback-block-test.html"), "utf8"));

// ── service worker ─────────────────────────────────────────────────────────────
// Cache versioned per build: V changes → old caches evicted on activate.
// Strategy: "/" = stale-while-revalidate, other navigations = network-first, /lib = network-first,
// /data = cache-first.
const SW = `const V = "skmusic-${BUILD}";
const SHELL = ["/","/lib/engine.mjs?v=${BUILD}","/lib/engine-worker.mjs?v=${BUILD}","/lib/categories.mjs?v=${BUILD}","/lib/search.mjs?v=${BUILD}","/lib/normalize.mjs?v=${BUILD}","/lib/synonyms.mjs?v=${BUILD}","/data/meta.json","/data/home.json","/data/home.kidzone.json","/data/artists.json","/data/synonyms.json","/data/zemer-playlists.json","/data/blocked-ids.json"];
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL))); }); // no .catch: a mid-install failure must REJECT so the browser keeps the previous SW+cache and retries, instead of activating an empty cache
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
const OFFLINE = () => new Response("<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>Offline - SK Music</title><body style='margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;text-align:center'><div style='padding:24px'><h1 style='font-size:20px;margin:0 0 8px'>You are offline</h1><p style='margin:0;color:#94a3b8'>SK Music cannot reach the network right now. Reconnect and try again.</p></div></body>", { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname === "/playlist") return;
  if (e.request.mode === "navigate") {
    // "/" is the shell EVERY launch loads (the desktop app navigates straight to the origin root), and
    // it is a build-stamped static asset with nothing per-user in it — so serve the precached copy and
    // revalidate behind it. That takes the ~490 KB HTML off the critical path: a Cache API read instead
    // of a round trip to the edge. A new deploy still lands inside the same session — the page's
    // reg.update() installs the new SW, whose install precaches the new "/" under the new V, and
    // controllerchange reloads the page onto it — so the cache can never pin anyone to an old build.
    if (u.pathname === "/") {
      e.respondWith(caches.open(V).then(async (c) => {
        const hit = await c.match("/");
        const net = fetch(e.request).then((r) => { if (r.ok) c.put("/", r.clone()); return r; });
        if (!hit) return net.catch(() => OFFLINE());
        e.waitUntil(net.catch(() => {})); // keep the SW alive for the background refresh
        return hit;
      }));
      return;
    }
    // Deep links (/song/:id, /artists/:id …): network-first; offline fall back to the cached "/" shell,
    // which routes client-side, or a minimal inline page (never respondWith(undefined) — a network error).
    e.respondWith(fetch(e.request).catch(() => caches.open(V).then((c) => c.match("/")).then((m) => m || OFFLINE())));
    return;
  }
  if (u.pathname.startsWith("/lib/")) { // engine code: network-first so a freshly-served shell never runs against a stale engine (falls back to cache offline)
    e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put(e.request, cp)); } return r; }).catch(() => caches.open(V).then((c) => c.match(e.request))));
  } else if (u.pathname.startsWith("/data/")) { // data: cache-first (large + stable; the versioned cache + post-deploy reload refresh it)
    e.respondWith(caches.open(V).then(async (c) => { const hit = await c.match(e.request); if (hit) return hit; return fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }); }));
  }
});
`;
ensureWrite(path.join(DIST, "sw.js"), SW);

// _headers: mark /lib/* immutable — browsers skip revalidation on versioned URLs,
// and a new build changes BUILD → new paths → the browser refetches.
// _headers: versioned /lib is immutable; sitemaps + robots get a real cache lifetime so crawlers (and
// Cloudflare's edge) cache them instead of re-fetching the full multi-MB file on every request.
// Content-Security-Policy — now ENFORCING. It ran report-only first for a full day of real web +
// desktop-webview traffic; that surfaced and fixed every real violation (Tauri IPC http://ipc.localhost,
// WebView2's script-src-elem non-fallback, the diagnostic pages' techloq/youtube probes, gstatic
// thumbnails). report-uri stays on so any straggler still reports even though it's blocked.
// 'unsafe-inline' is unavoidable — the app is one file of inline JS + inline
// on* handlers — so the hardening value is in locking down connect/frame/object/base-uri: injected code
// can't exfiltrate to a foreign host or load a hostile frame. Every origin below is audited from actual
// runtime use: YouTube IFrame API + player frame, Google Fonts, i.ytimg thumbnails, Supabase RPC,
// search/content.zemer.io, api.github.com (desktop download page), Cloudflare Insights beacon; the
// html5 fallback (/stream) + engine worker (/lib) + analytics beacon (/a) are all same-origin.
const CSP = [
  "default-src 'self'",
  // script-src-elem stated explicitly: the desktop WebView2 doesn't fall back script-src-elem→script-src,
  // so without this the YouTube IFrame API (loaded as a <script> element) is flagged in the desktop app.
  "script-src 'self' 'unsafe-inline' https://www.youtube.com https://static.cloudflareinsights.com",
  "script-src-elem 'self' 'unsafe-inline' https://www.youtube.com https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Thumbnails are data-driven across many Google hosts (ytimg, ggpht, googleusercontent, gstatic, …),
  // so pin the inert image channel to any-https rather than whack-a-mole a host list. The exfil-relevant
  // directives (connect/script/frame/object/base) stay tight.
  "img-src 'self' data: blob: https:",
  // skdl: is the SK Music DESKTOP app's offline-download scheme (Tauri custom URI scheme served from
  // Rust; src/download.rs). It serves a downloaded song's local audio file to the html5 <audio> element
  // so a saved track plays from disk (and offline). Inert in a browser — no such origin exists there.
  // Windows/WebView2 serves custom schemes as http://<scheme>.localhost, macOS/Linux as <scheme>://localhost.
  // TorahAnytime shiurim stream STRAIGHT from source to the <audio>/<video> elements — no Worker
  // proxy, which is what makes that feature cost zero Worker requests. That only works if the storage
  // hosts are allowed here: dl. and proxier. are TA-branded, the S3/Spaces hosts carry the modern
  // lectures (both mp3 AND mp4 — video shiurim need no host this list didn't already have), and
  // www.torahanytime.com serves the legacy /dl/mobileaudio/ URLs that a few older records still use
  // as their only `audio_url`.
  "media-src 'self' blob: skdl: http://skdl.localhost https://skdl.localhost https://dl.torahanytime.com https://proxier.torahanytime.com https://www.torahanytime.com https://ta-lectures.s3.us-east-005.backblazeb2.com https://ta-tusd.nyc3.digitaloceanspaces.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  // ipc: + ipc.localhost are the Tauri desktop app's IPC transport (invoke → now_playing/set_playback_state);
  // harmless for browsers, required so the desktop media bridge isn't blocked.
  // filter.techloq.com + www.youtube.com fetches: the /test, /connectivity and /playback-block-test
  // diagnostic pages probe them to tell the user WHAT their filter is blocking — those probes must not
  // themselves be CSP-blocked (that would be a false diagnosis). Only used by those pages.
  // api.torahanytime.com is called BROWSER-DIRECT (it echoes any Origin), which is the whole reason
  // Shiurim adds no Worker routes — but "CORS allows it" is only half the gate: without this entry the
  // page's own CSP blocks the fetch before it leaves. That gap shipped once; the browse rails and the
  // media resolver were both dead in production while every local test passed, because a plain static
  // server doesn't apply _headers.
  // ta-lectures.s3… appears in BOTH media-src and connect-src on purpose, and the two are not
  // interchangeable: <video src=mp4> is media-src, but hls.js reads playlists and segments with XHR,
  // which is connect-src. Allowing only media-src would break watching with no console clue beyond a
  // CSP report. The CDN reflects our Origin, so CORS itself is satisfied.
  "connect-src 'self' https://search.zemer.io https://content.zemer.io https://api.torahanytime.com https://ta-lectures.s3.us-east-005.backblazeb2.com https://*.supabase.co https://api.github.com https://cloudflareinsights.com https://filter.techloq.com https://www.youtube.com ipc: http://ipc.localhost https://ipc.localhost",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "report-uri /csp-report",
].join("; ");
ensureWrite(path.join(DIST, "_headers"),
  "/*\n" +
  "  Content-Security-Policy: " + CSP + "\n" +
  "  X-Content-Type-Options: nosniff\n" +
  "  Referrer-Policy: strict-origin-when-cross-origin\n" +
  "/lib/*\n  Cache-Control: public, max-age=31536000, immutable\n" +
  "/favicon.ico\n  Cache-Control: public, max-age=604800\n" +
  "/sitemap.xml\n  Cache-Control: public, max-age=3600, s-maxage=21600\n" +
  "/sitemap-*\n  Cache-Control: public, max-age=3600, s-maxage=21600\n" +
  "/robots.txt\n  Cache-Control: public, max-age=3600, s-maxage=21600\n" +
  "/artists/*\n  Cache-Control: public, max-age=3600, s-maxage=21600\n" +
  "/playlists/*\n  Cache-Control: public, max-age=3600, s-maxage=21600\n");

// Backstop for Cloudflare's 20,000-asset limit. The shell pre-bake above already caps itself at 19,800
// (overflow falls to the Worker), so this only fires if the non-shell files alone — mainly the ~13.8k
// per-album detail files — approach the limit. That's unfixable by skipping shells, so fail loudly with
// the real remedy. See docs/asset-file-limit.md.
const totalFiles = countFiles(DIST);
if (totalFiles > 19950)
  throw new Error(`dist has ${totalFiles} files — at Cloudflare's 20,000-asset limit even after deep-link shells fell back to the Worker. Fold album detail into the shipped dataset (see docs/asset-file-limit.md).`);

console.log(`\ndist/ ready → ${fs.readdirSync(DATA).length} data files, ${fs.readdirSync(LIB).length} lib modules, ${totalFiles} total assets (limit 20000)`);
