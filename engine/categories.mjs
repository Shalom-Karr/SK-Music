// Grouped search — Artists / Songs / Albums / Singles / Videos / Playlists, each its own ranked list, the
// way a music app presents results. One search index per group is built from the catalog entities (each doc
// shaped {title, artistName, ...} so the core index treats them uniformly), and each group returns its own
// top-k with the active content filters applied. (Original SK Music implementation.)

import { buildIndex, search } from "./search.mjs";
import { plainTokens, skeletonTokens } from "./normalize.mjs";
import { expandQuery } from "./synonyms.mjs";

export function buildCategories({ tracks = [], artists = [], albums = [], playlists = [] }, synonyms = []) {
  const isVid = (t) => !!t.isVideo;
  // Artist prominence (total plays + how many tracks) — used to break ties among similar name matches so a
  // bare first name lands on the well-known artist, not an obscure namesake.
  const plays = new Map(), count = new Map();
  for (const t of tracks) {
    plays.set(t.artistId, (plays.get(t.artistId) || 0) + (t.playCount || 0));
    count.set(t.artistId, (count.get(t.artistId) || 0) + 1);
  }
  const artistDocs = artists.map((a) => ({ ...a, title: a.name, artistName: "", pop: plays.get(a.id) || 0, nTrk: count.get(a.id) || 0 }));
  return {
    artists: buildIndex(artistDocs, synonyms),
    songs: buildIndex(tracks.filter((t) => !isVid(t)), synonyms),
    videos: buildIndex(tracks.filter(isVid), synonyms),
    albums: buildIndex(albums.filter((a) => a.type !== "single"), synonyms),
    singles: buildIndex(albums.filter((a) => a.type === "single"), synonyms),
    playlists: buildIndex(playlists, synonyms),
  };
}

// Content filters apply only when explicitly requested (an unset flag means "no filtering", so a caller who
// omits allowFemale gets everyone rather than silently zero results).
const passes = (t, o) =>
  (o.allowFemale === false ? !t.isFemale : true) &&
  (o.allowChasid === false ? !t.isChasid : true) &&
  (o.kidZoneOnly ? t.isKidZone : true) &&
  (o.blockVideos ? !t.isVideo : true);

export function searchCategories(cats, q, o = {}) {
  const k = o.k || 8;
  // over-fetch, drop filtered entities, then trim — so a filtered-out top hit doesn't shrink the list.
  const take = (idx, shape, n = k) =>
    search(idx, q, n * 4).map((r) => r.track).filter((t) => passes(t, o)).slice(0, n).map(shape);

  // Artists get two-tier ranking: (1) EXACTNESS — how many (synonym-expanded) query words appear as whole
  // words in the name ("ari" is a word in "Ari Goldwag" but not "Arik Dvir"); a real word beats a prefix.
  // (2) within the same exactness, PROMINENCE-blended relevance — a bounded nudge by plays/catalog size, so
  // it settles near-ties without ever overturning a genuine relevance gap.
  const takeArtists = (n = 6) => {
    const hits = search(cats.artists, q, Math.max(n * 8, 48)).filter((r) => passes(r.track, o));
    if (hits.length > 1) {
      const qWords = expandQuery(plainTokens(q), skeletonTokens(q), cats.artists.synonyms || []).plain.filter((t) => t.length >= 2);
      const exactness = (r) => { const names = new Set(plainTokens(r.track.name)); let c = 0; for (const w of qWords) if (names.has(w)) c++; return c; };
      const NUDGE = 0.22;
      const topPlays = Math.max(0, ...hits.map((r) => r.track.pop || 0));
      const topTrk = Math.max(1, ...hits.map((r) => r.track.nTrk || 0));
      const weighted = (r) => r.score * (1 + NUDGE * (topPlays > 0 ? (r.track.pop || 0) / topPlays : (r.track.nTrk || 0) / topTrk));
      hits.sort((a, b) => exactness(b) - exactness(a) || weighted(b) - weighted(a));
    }
    return hits.slice(0, n).map((r) => ({ id: r.track.id, name: r.track.name, thumbnail: r.track.thumbnail }));
  };

  const song = (t) => ({ videoId: t.videoId, title: t.title, artist: t.artistName, explicit: t.explicit, durationSec: t.durationSec });
  const album = (a) => ({ id: a.id, playlistId: a.playlistId, title: a.title, artist: a.artistName, year: a.year, thumbnail: a.thumbnail });
  return {
    artists: takeArtists(6),
    songs: take(cats.songs, song),
    albums: take(cats.albums, album, 6),
    singles: take(cats.singles, album, 6),
    videos: take(cats.videos, song, 6),
    playlists: take(cats.playlists, (p) => ({ id: p.id, title: p.title, artist: p.artistName, thumbnail: p.thumbnail }), 6),
  };
}
