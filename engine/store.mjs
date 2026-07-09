/**
 * Catalog read layer — opens the prebuilt SQLite corpus snapshot and returns the rows the
 * static-site builder needs: full track/artist/album/playlist lists, per-entity detail pages,
 * recent-release feeds, and corpus counts. Read-only — SK Music ships against a prebuilt
 * snapshot, so there is no write/harvest path here.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Anchor all relative paths to this module's directory so the file works from any cwd.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// The corpus database path — override via env for server deployments.
export const DB_PATH = process.env.CORPUS_DB ?? path.resolve(MODULE_DIR, "../data/corpus.db");

// ── Schema ──────────────────────────────────────────────────────────────────────────────────────

// Full DDL for the corpus schema; run idempotently on every open so a fresh/empty file still works.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS artist (
    id               TEXT PRIMARY KEY,
    name             TEXT,
    thumbnail        TEXT,
    regularChannelId TEXT,
    isFemale         INTEGER NOT NULL DEFAULT 0,
    isChasid         INTEGER NOT NULL DEFAULT 0,
    isKidZone        INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS track (
    videoId     TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    artistId    TEXT NOT NULL REFERENCES artist(id),
    isVideo     INTEGER NOT NULL DEFAULT 0,
    explicit    INTEGER NOT NULL DEFAULT 0,
    durationSec INTEGER,
    playCount   INTEGER,
    harvestedAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS album (
    id         TEXT PRIMARY KEY,
    playlistId TEXT,
    title      TEXT NOT NULL,
    artistId   TEXT NOT NULL REFERENCES artist(id),
    type       TEXT NOT NULL DEFAULT 'album',
    year       INTEGER,
    thumbnail  TEXT
  );
  CREATE TABLE IF NOT EXISTS playlist (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    artistId  TEXT NOT NULL REFERENCES artist(id),
    thumbnail TEXT
  );
  CREATE TABLE IF NOT EXISTS album_track (
    albumId TEXT NOT NULL,
    videoId TEXT NOT NULL,
    pos     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (albumId, videoId)
  );
  CREATE INDEX IF NOT EXISTS idx_track_artist     ON track(artistId);
  CREATE INDEX IF NOT EXISTS idx_albumtrack_album  ON album_track(albumId);
  CREATE INDEX IF NOT EXISTS idx_album_artist     ON album(artistId);
  CREATE INDEX IF NOT EXISTS idx_playlist_artist  ON playlist(artistId);
`;

// Bring an older snapshot up to the current column set — CREATE TABLE IF NOT EXISTS never adds
// columns introduced after a table first existed, so probe and ALTER where a column is missing.
function applyMigrations(db) {
  const artistCols = db.prepare("PRAGMA table_info(artist)").all().map((c) => c.name);
  if (!artistCols.includes("regularChannelId")) db.exec("ALTER TABLE artist ADD COLUMN regularChannelId TEXT");
  const trackCols = db.prepare("PRAGMA table_info(track)").all().map((c) => c.name);
  for (const col of ["durationSec", "playCount"]) {
    if (!trackCols.includes(col)) db.exec(`ALTER TABLE track ADD COLUMN ${col} INTEGER`);
  }
}

export function openCorpus(file = DB_PATH) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");     // concurrent readers
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return db;
}

// ── Bulk reads (feed the build pipeline) ─────────────────────────────────────────────────────────

// Full denormalized track list — every field the index builder and feed generators consume.
// SQLite integer booleans are coerced to JS booleans here.
export function allTracks(db) {
  const rows = db.prepare(`
    SELECT
      t.videoId,   t.title,      t.artistId,
      a.name       AS artistName,
      t.isVideo,   t.explicit,   t.durationSec, t.playCount,
      a.isFemale,  a.isChasid,   a.isKidZone
    FROM track t
    JOIN artist a ON a.id = t.artistId
  `).all();

  return rows.map((row) => ({
    videoId:     row.videoId,
    title:       row.title,
    artistId:    row.artistId,
    artistName:  row.artistName,
    isVideo:     !!row.isVideo,
    explicit:    !!row.explicit,
    durationSec: row.durationSec,
    playCount:   row.playCount,
    isFemale:    !!row.isFemale,
    isChasid:    !!row.isChasid,
    isKidZone:   !!row.isKidZone,
  }));
}

// All artists that have a known name (unfilled stubs are excluded).
export const allArtists = (db) => {
  const rows = db.prepare(
    "SELECT id, name, thumbnail, isFemale, isChasid, isKidZone FROM artist WHERE name IS NOT NULL"
  ).all();
  return rows.map((row) => ({
    id:        row.id,
    name:      row.name,
    thumbnail: row.thumbnail,
    isFemale:  !!row.isFemale,
    isChasid:  !!row.isChasid,
    isKidZone: !!row.isKidZone,
  }));
};

// All albums with their artist's content-filtering flags joined in.
export const allAlbums = (db) => {
  const rows = db.prepare(`
    SELECT
      al.id,       al.playlistId, al.title,    al.artistId,
      al.type,     al.year,       al.thumbnail,
      a.name       AS artistName,
      a.isFemale,  a.isChasid,    a.isKidZone
    FROM album al
    JOIN artist a ON a.id = al.artistId
  `).all();

  return rows.map((row) => ({
    id:         row.id,
    playlistId: row.playlistId,
    title:      row.title,
    artistId:   row.artistId,
    artistName: row.artistName,
    type:       row.type,
    year:       row.year,
    thumbnail:  row.thumbnail,
    isFemale:   !!row.isFemale,
    isChasid:   !!row.isChasid,
    isKidZone:  !!row.isKidZone,
  }));
};

// All playlists with their artist's content-filtering flags joined in.
export const allPlaylists = (db) => {
  const rows = db.prepare(`
    SELECT
      pl.id,      pl.title,    pl.artistId, pl.thumbnail,
      a.name      AS artistName,
      a.isFemale, a.isChasid,  a.isKidZone
    FROM playlist pl
    JOIN artist a ON a.id = pl.artistId
  `).all();

  return rows.map((row) => ({
    id:         row.id,
    title:      row.title,
    artistId:   row.artistId,
    artistName: row.artistName,
    thumbnail:  row.thumbnail,
    isFemale:   !!row.isFemale,
    isChasid:   !!row.isChasid,
    isKidZone:  !!row.isKidZone,
  }));
};

// ── Detail pages ────────────────────────────────────────────────────────────────────────────────

// Complete artist detail: songs (play-count ranked), music videos, albums, singles, playlists.
export function artistDetail(db, artistId) {
  const artistRow = db.prepare(
    "SELECT id, name, thumbnail, isFemale, isChasid FROM artist WHERE id = ?"
  ).get(artistId);
  if (!artistRow) return null;

  const trackRows = db.prepare(
    "SELECT videoId, title, isVideo, explicit, durationSec, playCount FROM track WHERE artistId = ? ORDER BY harvestedAt"
  ).all(artistId);

  const albumRows = db.prepare(
    "SELECT id, playlistId, title, type, year, thumbnail FROM album WHERE artistId = ? ORDER BY (year IS NULL), year DESC"
  ).all(artistId);

  const playlistRows = db.prepare(
    "SELECT id, title, thumbnail FROM playlist WHERE artistId = ?"
  ).all(artistId);

  const toSong = (t) => ({
    videoId:     t.videoId,
    title:       t.title,
    explicit:    !!t.explicit,
    durationSec: t.durationSec,
    playCount:   t.playCount,
  });

  const toRelease = (x) => ({
    id:         x.id,
    playlistId: x.playlistId,
    title:      x.title,
    artist:     artistRow.name,
    year:       x.year,
    thumbnail:  x.thumbnail,
  });

  return {
    artist: {
      id:        artistRow.id,
      name:      artistRow.name,
      thumbnail: artistRow.thumbnail,
      isFemale:  !!artistRow.isFemale,
      isChasid:  !!artistRow.isChasid,
    },
    songs:     trackRows.filter((t) => !t.isVideo).map(toSong).sort((a, b) => (b.playCount || 0) - (a.playCount || 0)),
    videos:    trackRows.filter((t) =>  t.isVideo).map(toSong),
    albums:    albumRows.filter((x) => x.type !== "single").map(toRelease),
    singles:   albumRows.filter((x) => x.type === "single").map(toRelease),
    playlists: playlistRows.map((p) => ({ id: p.id, title: p.title, artist: artistRow.name, thumbnail: p.thumbnail })),
  };
}

// Album detail with ordered track listing and total runtime.
export function albumDetail(db, albumId) {
  const albumRow = db.prepare(`
    SELECT al.id, al.title, al.year, al.thumbnail, a.name artistName
    FROM album al
    JOIN artist a ON a.id = al.artistId
    WHERE al.id = ?
  `).get(albumId);
  if (!albumRow) return null;

  const trackRows = db.prepare(`
    SELECT t.videoId, t.title, t.explicit, t.durationSec, a.name artistName
    FROM album_track at
    JOIN track  t ON t.videoId = at.videoId
    JOIN artist a ON a.id      = t.artistId
    WHERE at.albumId = ?
    ORDER BY at.pos
  `).all(albumId);

  const trackList = trackRows.map((t) => ({
    videoId:     t.videoId,
    title:       t.title,
    artist:      t.artistName,
    explicit:    !!t.explicit,
    durationSec: t.durationSec,
  }));

  const totalDurationSec = trackList.reduce((sum, t) => sum + (t.durationSec || 0), 0);

  return {
    album: {
      id:               albumRow.id,
      title:            albumRow.title,
      year:             albumRow.year,
      thumbnail:        albumRow.thumbnail,
      artist:           albumRow.artistName,
      trackCount:       trackList.length,
      totalDurationSec,
    },
    tracks: trackList,
  };
}

// ── Recent-releases feeds ───────────────────────────────────────────────────────────────────────

// Newest tracks, most-recent first. harvestedAt stands in for release recency.
export function recentTracks(db, limit = 100) {
  const cap  = Math.max(1, limit | 0);
  const rows = db.prepare(`
    SELECT
      t.videoId,    t.title,       t.isVideo,   t.explicit,
      t.durationSec, t.harvestedAt,
      a.name        AS artistName,
      a.isFemale,   a.isChasid,    a.isKidZone
    FROM track t
    JOIN artist a ON a.id = t.artistId
    WHERE t.harvestedAt IS NOT NULL
    ORDER BY t.harvestedAt DESC, t.videoId
    LIMIT ?
  `).all(cap);

  return rows.map((row) => ({
    videoId:     row.videoId,
    title:       row.title,
    artist:      row.artistName,
    isVideo:     !!row.isVideo,
    explicit:    !!row.explicit,
    durationSec: row.durationSec,
    addedAt:     row.harvestedAt,
    isFemale:    !!row.isFemale,
    isChasid:    !!row.isChasid,
    isKidZone:   !!row.isKidZone,
  }));
}

// Most-recent albums/singles/EPs — recency is the newest track harvestedAt within the album, so
// re-confirming an existing album doesn't bubble it back to the top.
export function recentAlbums(db, limit = 100) {
  const cap  = Math.max(1, limit | 0);
  const rows = db.prepare(`
    SELECT
      al.id,       al.playlistId, al.title,    al.type,
      al.year,     al.thumbnail,
      a.name       AS artistName,
      a.isFemale,  a.isChasid,    a.isKidZone,
      MAX(t.harvestedAt) AS addedAt
    FROM album al
    JOIN album_track at ON at.albumId = al.id
    JOIN track       t  ON t.videoId  = at.videoId
    JOIN artist      a  ON a.id       = al.artistId
    WHERE t.harvestedAt IS NOT NULL
    GROUP BY al.id
    ORDER BY (al.year IS NULL), al.year DESC, addedAt DESC, al.id
    LIMIT ?
  `).all(cap);

  return rows.map((row) => ({
    id:         row.id,
    playlistId: row.playlistId,
    title:      row.title,
    artist:     row.artistName,
    type:       row.type,
    year:       row.year,
    thumbnail:  row.thumbnail,
    addedAt:    row.addedAt,
    isFemale:   !!row.isFemale,
    isChasid:   !!row.isChasid,
    isKidZone:  !!row.isKidZone,
  }));
}

// ── Aggregate counts ────────────────────────────────────────────────────────────────────────────

// Corpus-wide totals for the health/meta endpoint. One tiny COUNT per bucket; .pluck() returns the
// scalar directly.
export function stats(db) {
  const count = (where = "") => db.prepare(`SELECT COUNT(*) FROM ${where}`).pluck().get();
  return {
    tracks:    count("track"),
    artists:   count("artist"),
    videos:    count("track WHERE isVideo = 1"),
    albums:    count("album WHERE type != 'single'"),
    singles:   count("album WHERE type = 'single'"),
    playlists: count("playlist"),
  };
}
