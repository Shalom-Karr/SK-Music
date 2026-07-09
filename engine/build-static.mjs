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
const SITE = (process.env.SITE_URL || "https://skmusic.shalomkarr.workers.dev").replace(/\/$/, "");

// ── file helpers ──────────────────────────────────────────────────────────────
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

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

  // ── corpus rows ────────────────────────────────────────────────────────────
  const tracks    = allTracks(db);
  const artists   = allArtists(db);
  const albums    = allAlbums(db);
  const playlists = allPlaylists(db);

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
  const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4dHRxY291YWJkcHRmdGx2Zm5kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMTc2OTAsImV4cCI6MjA5ODc5MzY5MH0.DiTcbcKTqXZTJfOqEXfvckiObinN0g15BDbLmAmmdsY";
  const supabaseBase = "https://jxttqcouabdptftlvfnd.supabase.co/rest/v1/";

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

  // ── acapella-only artist detection ────────────────────────────────────────
  // Artists whose entire corpus catalog falls inside the acapella playlist get
  // tagged so the client's "Hide Acapella" filter can suppress the whole artist
  // rather than just individual tracks. Best-effort; skipped on any fetch error.
  const acapellaOnlySet = new Set();
  try {
    const res = await fetch(`${CATALOG_BASE}/zemer-playlists?id=acapella`);
    if (res.ok) {
      const body = await res.json();
      const acSet = new Set(((body && body.tracks) || []).map((t) => t.videoId));
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

  // ── interned dataset ───────────────────────────────────────────────────────
  // Compact array-of-arrays format minimises wire size for the ~4 MB full catalog.
  // The client unpacks into proper objects at startup.
  //
  //   artists[i]    = [id, name, thumb, flags]                  flags: 1=female 2=chasid 4=kidzone
  //   tracks[i]     = [videoId, title, artistIdx, flags, dur, plays]  flags: 1=video 2=explicit
  //   albums[i]     = [id, playlistId, title, artistIdx, isSingle, year, thumb]
  //   playlists[i]  = [id, title, artistIdx, thumb]
  //   albumTracks   = { [albumId]: [videoId, …] }
  const internedDataset = {
    v: 1,
    artists:     artists.map((a) => [a.id, a.name, a.thumbnail || "", encodeArtistFlags(a)]),
    tracks:      tracks.map((t) => [t.videoId, t.title, artistIndex.get(t.artistId) ?? -1, encodeTrackFlags(t), t.durationSec || 0, t.playCount || 0]),
    albums:      albums.map((a) => [a.id, a.playlistId || "", a.title, artistIndex.get(a.artistId) ?? -1, a.type === "single" ? 1 : 0, a.year || 0, a.thumbnail || ""]),
    albumTracks: albumTracksMap,
    playlists:   playlists.map((p) => [p.id, p.title, artistIndex.get(p.artistId) ?? -1, p.thumbnail || ""]),
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
    let artistCount = 0, albumCount = 0;
    for (const a of artists) {
      const detail = artistDetail(db, a.id);
      if (detail) {
        ensureWrite(path.join(DATA, "artist", a.id + ".json"), JSON.stringify(detail));
        artistCount++;
      }
    }
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
      emitJSON("zemer-playlists.json", { count: 0, playlists: [] });
      console.warn(`  !! curated playlists: LIST FETCH FAILED from ${CATALOG_BASE} — ${e.message}. Section will render EMPTY. !!`);
      return; // never throw — the build must still succeed even if the upstream index is down
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

    emitJSON("zemer-playlists.json", { count: successfulPlaylists.length, playlists: successfulPlaylists });
    if (successfulPlaylists.length && successfulPlaylists.length === catalogList.length) {
      console.log(`  curated playlists: baked ${successfulPlaylists.length}/${catalogList.length} (from ${CATALOG_BASE})`);
    } else {
      console.warn(`  !! curated playlists: baked ${successfulPlaylists.length}/${catalogList.length} — ${successfulPlaylists.length ? "some playlists missing" : "SECTION WILL BE EMPTY"} !!`);
    }
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

  const SITEMAP_CHUNK = 45000;
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
    `User-agent: *\nAllow: /\nDisallow: /analytics\n\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log(`  sitemaps: ${registeredSitemaps.length} files + index (${tracks.length + artists.length + albums.length + playlists.length} entity URLs) → ${SITE}/sitemap.xml`);

  // IndexNow (Bing/Edge instant indexing) — the key file must sit at the site root and
  // contain only the key as its body.
  const INDEXNOW_KEY = "652ada1f90c5acb347dbd074445c5918";
  ensureWrite(path.join(DIST, INDEXNOW_KEY + ".txt"), INDEXNOW_KEY);
  console.log(`  indexnow key: ${SITE}/${INDEXNOW_KEY}.txt`);

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
  .replace("<!--STATIC_BUILD-->",   '<meta name="sk-static" content="1">')
  .replace("<!--CF_ANALYTICS-->",   analyticsBeacon)
  .replace("<!--OGTAGS-->",         `<!--OG-->${OG_DEF}<!--/OG-->`)
  .replace('"/lib/engine.mjs"',        `"/lib/engine.mjs?v=${BUILD}"`)
  .replace('"/lib/engine-worker.mjs"', `"/lib/engine-worker.mjs?v=${BUILD}"`);
ensureWrite(path.join(DIST, "index.html"), indexHtml);

// Static assets: logo, favicon, PWA icons, manifest — everything except .html files.
fs.cpSync(path.join(ROOT, "assets"), path.join(DIST, "assets"), {
  recursive: true,
  filter: (s) => !s.endsWith(".html"),
});

// Admin analytics dashboard — Supabase auth + zemer_admin role required; noindex.
ensureWrite(path.join(DIST, "analytics.html"), fs.readFileSync(path.join(ROOT, "assets/analytics.html"), "utf8"));

// Network connectivity test page — diagnoses filter/whitelist blocks and a real playback test.
ensureWrite(path.join(DIST, "test.html"), fs.readFileSync(path.join(ROOT, "assets/connectivity.html"), "utf8"));

// ── service worker ─────────────────────────────────────────────────────────────
// Cache versioned per build: V changes → old caches evicted on activate.
// Strategy: navigate = network-first, /lib = network-first, /data = cache-first.
const SW = `const V = "skmusic-${BUILD}";
const SHELL = ["/","/lib/engine.mjs?v=${BUILD}","/lib/engine-worker.mjs?v=${BUILD}","/lib/categories.mjs?v=${BUILD}","/lib/search.mjs?v=${BUILD}","/lib/normalize.mjs?v=${BUILD}","/lib/synonyms.mjs?v=${BUILD}","/data/meta.json","/data/home.json","/data/home.kidzone.json","/data/artists.json","/data/synonyms.json","/data/zemer-playlists.json"];
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname === "/playlist") return;
  if (e.request.mode === "navigate") { e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(V).then((c) => c.put("/", cp)); } return r; }).catch(() => caches.open(V).then((c) => c.match("/")))); return; }
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
ensureWrite(path.join(DIST, "_headers"), "/lib/*\n  Cache-Control: public, max-age=31536000, immutable\n");

console.log(`\ndist/ ready → ${fs.readdirSync(DATA).length} data files, ${fs.readdirSync(LIB).length} lib modules`);
