// In-browser data engine for the static build (original SK Music implementation). The whole catalog ships
// as one interned, gzipped dataset (data/dataset.json.gz); this module rehydrates it and answers the read
// API — search, artist/album/playlist detail, home feed — entirely client-side, so only genuinely live
// routes (playlist contents) still touch the network. It mirrors the build-time reader so the shapes it
// returns match the baked API responses byte-for-byte.
import { buildCategories, searchCategories } from "./categories.mjs";
import { compileSynonyms } from "./synonyms.mjs";

// ---- rehydrate the interned dataset into the object shapes the rest of the code expects ----
// Interned layout (see the builder): artists [id,name,thumb,flags], tracks [videoId,title,artistIdx,flags,
// dur,plays], albums [id,playlistId,title,artistIdx,isSingle,year,thumb], playlists [id,title,artistIdx,thumb].
export function inflate(d) {
  const A = d.artists;
  const fem = (i) => !!(A[i] && A[i][3] & 1), chas = (i) => !!(A[i] && A[i][3] & 2), kid = (i) => !!(A[i] && A[i][3] & 4);
  const aName = (i) => (A[i] ? A[i][1] : ""), aId = (i) => (A[i] ? A[i][0] : "");
  const artists = A.map((a) => ({ id: a[0], name: a[1], thumbnail: a[2] || null, isFemale: !!(a[3] & 1), isChasid: !!(a[3] & 2), isKidZone: !!(a[3] & 4) }));
  const tracks = d.tracks.map((t) => ({
    videoId: t[0], title: t[1], artistId: aId(t[2]), artistName: aName(t[2]),
    isVideo: !!(t[3] & 1), explicit: !!(t[3] & 2), durationSec: t[4] || null, playCount: t[5] || null,
    isFemale: fem(t[2]), isChasid: chas(t[2]), isKidZone: kid(t[2]),
  }));
  const albums = d.albums.map((x) => ({
    id: x[0], playlistId: x[1] || null, title: x[2], artistId: aId(x[3]), artistName: aName(x[3]),
    type: x[4] ? "single" : "album", year: x[5] || null, thumbnail: x[6] || null,
    isFemale: fem(x[3]), isChasid: chas(x[3]), isKidZone: kid(x[3]),
  }));
  const playlists = d.playlists.map((p) => ({ id: p[0], title: p[1], artistId: aId(p[2]), artistName: aName(p[2]), thumbnail: p[3] || null, isFemale: fem(p[2]), isChasid: chas(p[2]), isKidZone: kid(p[2]) }));
  return {
    tracks, artists, albums, playlists, albumTracks: d.albumTracks,
    trackById: new Map(tracks.map((t) => [t.videoId, t])),
    artistById: new Map(artists.map((a) => [a.id, a])),
    albumById: new Map(albums.map((a) => [a.id, a])),
  };
}

// ---- detail assembly (mirrors the build-time /artist and /album responses) ----
export function artistDetailFrom(DS, id) {
  const a = DS.artistById.get(id); if (!a) return null;
  const mine = DS.tracks.filter((t) => t.artistId === id);
  const asSong = (t) => ({ videoId: t.videoId, title: t.title, explicit: t.explicit, durationSec: t.durationSec, playCount: t.playCount });
  const rel = DS.albums.filter((x) => x.artistId === id).sort((x, y) => (x.year ? 0 : 1) - (y.year ? 0 : 1) || (y.year || 0) - (x.year || 0));
  const asAlbum = (x) => ({ id: x.id, playlistId: x.playlistId, title: x.title, artist: a.name, year: x.year, thumbnail: x.thumbnail });
  return {
    artist: { id: a.id, name: a.name, thumbnail: a.thumbnail, isFemale: !!a.isFemale, isChasid: !!a.isChasid },
    songs: mine.filter((t) => !t.isVideo).map(asSong).sort((x, y) => (y.playCount || 0) - (x.playCount || 0)),
    videos: mine.filter((t) => t.isVideo).map(asSong),
    albums: rel.filter((x) => x.type !== "single").map(asAlbum),
    singles: rel.filter((x) => x.type === "single").map(asAlbum),
    playlists: DS.playlists.filter((p) => p.artistId === id).map((p) => ({ id: p.id, title: p.title, artist: a.name, thumbnail: p.thumbnail })),
  };
}
export function albumDetailFrom(DS, id) {
  const al = DS.albumById.get(id); if (!al) return null;
  const tracks = (DS.albumTracks[id] || []).map((v) => DS.trackById.get(v)).filter(Boolean)
    .map((t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: t.explicit, durationSec: t.durationSec }));
  const totalDurationSec = tracks.reduce((s, t) => s + (t.durationSec || 0), 0);
  return { album: { id: al.id, title: al.title, year: al.year, thumbnail: al.thumbnail, artist: al.artistName, trackCount: tracks.length, totalDurationSec }, tracks };
}

// ---- lazy runtime: fetch + index the dataset once, then answer routes ----
let DS = null, CATS = null, warming = null;
const files = new Map();
const grab = async (u) => {
  if (files.has(u)) return files.get(u);
  const r = await fetch(u), j = r.ok ? await r.json() : null;
  files.set(u, j); return j;
};

async function ready() {
  if (DS) return DS;
  if (!warming) warming = (async () => {
    const gz = await fetch("/data/dataset.json.gz");
    const text = await new Response(gz.body.pipeThrough(new DecompressionStream("gzip"))).text();
    DS = inflate(JSON.parse(text));
    CATS = buildCategories(DS, compileSynonyms((await grab("/data/synonyms.json")) || []));
    return DS;
  })();
  return warming;
}
export const preload = ready;   // warm in the background so the first interaction is instant

const artistOK = (x, allowFem, kid, allowChas) => (allowFem || !x.isFemale) && (allowChas || !x.isChasid) && (!kid || x.isKidZone);

async function homeFeed(kid, allowFem, blockVid, allowChas) {
  const raw = (await grab(kid ? "/data/home.kidzone.json" : "/data/home.json")) || {};
  const ok = (x) => (allowFem || !x.isFemale) && (allowChas || !x.isChasid);
  const feed = {};
  for (const key of ["quickPicks", "newSongs", "trending", "latestReleases", "featuredAlbums", "featuredPlaylists", "featuredArtists"]) feed[key] = (raw[key] || []).filter(ok);
  feed.featuredVideos = blockVid ? [] : (raw.featuredVideos || []).filter(ok);
  return feed;
}

const idOK = (id) => /^[A-Za-z0-9_-]+$/.test(id);

export async function handle(url) {
  const u = new URL(url, location.origin), path = u.pathname, q = u.searchParams;
  const allowFem = q.get("allowFemale") !== "0", allowChas = q.get("allowChasid") !== "0", kid = q.get("kidZone") === "1", blockVid = q.get("blockVideos") === "1";

  if (path === "/health") { const m = (await grab("/data/meta.json")) || {}; return { ok: true, ...m, indexed: m.tracks || 0, maintenance: null }; }
  if (path === "/home") return homeFeed(kid, allowFem, blockVid, allowChas);

  if (path === "/artists") {
    const d = (await grab("/data/artists.json")) || { artists: [] };
    const needle = (q.get("q") || "").trim().toLowerCase();
    const list = d.artists.filter((a) => artistOK(a, allowFem, kid, allowChas)).filter((a) => !needle || (a.name || "").toLowerCase().includes(needle));
    return { count: list.length, artists: list.map((a) => ({ id: a.id, name: a.name, thumbnail: a.thumbnail, isFemale: !!a.isFemale, isChasid: !!a.isChasid, isKidZone: !!a.isKidZone, isDJ: !!a.isDJ, isIsraeli: !!a.isIsraeli, isAmerican: !!a.isAmerican, isFamous: !!a.isFamous, isAcapellaOnly: !!a.isAcapellaOnly })) };
  }
  if (path === "/playlists") {
    await ready();
    const list = DS.playlists.filter((x) => artistOK(x, allowFem, kid, allowChas)).map((x) => ({ id: x.id, title: x.title, artist: x.artistName, thumbnail: x.thumbnail })).sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    return { count: list.length, playlists: list };
  }
  if (path === "/search") {
    await ready();
    const query = (q.get("q") || "").replace(/^\s+/, ""); if (!query.trim()) return { error: "missing q" };
    const k = Math.max(1, Math.min(200, parseInt(q.get("k") || "8", 10) || 8));
    const categories = searchCategories(CATS, query, { allowFemale: allowFem, allowChasid: allowChas, kidZoneOnly: kid, blockVideos: blockVid, k });
    return { q: query, count: Object.values(categories).reduce((n, a) => n + a.length, 0), categories };
  }
  if (path === "/artist") { const id = q.get("id") || ""; return idOK(id) ? ((await grab("/data/artist/" + id + ".json")) || { error: "artist not found" }) : { error: "artist not found" }; }
  if (path === "/album") { const id = q.get("id") || ""; return idOK(id) ? ((await grab("/data/album/" + id + ".json")) || { error: "album not found" }) : { error: "album not found" }; }
  if (path === "/track") { await ready(); const t = DS.trackById.get(q.get("v")); return t ? { videoId: t.videoId, title: t.title, artist: t.artistName, durationSec: t.durationSec, explicit: t.explicit, isVideo: t.isVideo, isFemale: t.isFemale, isChasid: t.isChasid } : { error: "not found" }; }
  if (path === "/playlist") {   // live route: keep only whitelisted-corpus tracks from the upstream list
    const id = q.get("id") || "";
    const r = await fetch(url), remote = r.ok ? await r.json() : null; await ready();
    const raw = (remote && remote.tracks) || [];
    const tracks = raw.map((s) => DS.trackById.get(s.videoId)).filter(Boolean).map((t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: t.explicit, durationSec: t.durationSec }));
    const meta = DS.playlists.find((pl) => pl.id === id);
    const playlist = meta ? { id: meta.id, title: meta.title, artist: meta.artistName, thumbnail: meta.thumbnail } : (remote && remote.playlist) || { id, title: "Playlist", artist: "", thumbnail: null };
    return { playlist, tracks, total: (remote && remote.total) || raw.length, whitelisted: tracks.length, status: raw.length === 0 ? "unavailable" : (tracks.length === 0 ? "empty" : "ok") };
  }
  if (path === "/zemer-playlists") {   // curated playlists baked at build time — read the local files
    const id = q.get("id");
    if (id) return idOK(id) ? ((await grab("/data/zemer-playlist/" + id + ".json")) || { error: "not found" }) : { error: "not found" };
    return (await grab("/data/zemer-playlists.json")) || { count: 0, playlists: [] };
  }
  const r = await fetch(url); return r.ok ? r.json() : null;
}
