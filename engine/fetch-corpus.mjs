/**
 * Build-time bootstrap: ensures data/corpus.db exists before the server starts.
 * Pulls the latest .db.gz snapshot from a GitHub release and decompresses it in place.
 * Entirely idempotent — if a valid database is already on disk, this is a no-op.
 * Set FORCE=1 to bypass the presence check and re-download unconditionally.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

// Anchor all relative paths to the repo root (one level above this script).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SCRIPT_DIR, "..");

const dbPath    = process.env.CORPUS_DB   || path.join(ROOT, "data", "corpus.db");
const ghRepo    = process.env.CORPUS_REPO || "ZemerTeam/zemer-search";
const forcePull = process.env.FORCE === "1";

/** Format a byte count as a compact MB string for console output. */
function toMB(bytes) {
  return (bytes / 1e6).toFixed(0) + " MB";
}

/**
 * Return true when a usable database already exists on disk.
 * A file under 1 MB is treated as corrupt/partial and will be replaced.
 */
function corpusReady() {
  if (!fs.existsSync(dbPath)) return false;
  return fs.statSync(dbPath).size > 1_000_000;
}

/**
 * Build the headers for a GitHub API request.
 * When GITHUB_TOKEN or GH_TOKEN is set (typical in CI), attach it as a Bearer token.
 * Without auth, the GitHub API allows only 60 requests/hour per IP — shared CI runners
 * hit that ceiling quickly and start returning 403s.
 */
function buildApiHeaders() {
  const headers = {
    "User-Agent": "sk-music",
    Accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = "Bearer " + token;
  return headers;
}

/**
 * Ask the GitHub Releases API for the latest release of `ghRepo` and return
 * the first asset whose name ends in `.db.gz`. Throws if the API call fails
 * or no matching asset exists.
 */
async function resolveDownloadAsset() {
  const apiUrl = `https://api.github.com/repos/${ghRepo}/releases/latest`;
  const response = await fetch(apiUrl, { headers: buildApiHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} — check network connectivity and repo name`);
  }

  const release = await response.json();
  const asset = (release.assets || []).find((a) => a.name.endsWith(".db.gz"));
  if (!asset) {
    throw new Error(`No .db.gz asset found in release ${release.tag_name}`);
  }

  return { tag: release.tag_name, asset };
}

/**
 * Stream-download `url`, decompress it through gunzip, and write the result to `dest`.
 * Uses a `.download` staging file so a failed transfer never leaves a half-written database.
 */
async function streamDecompress(url, dest) {
  const response = await fetch(url, { headers: { "User-Agent": "sk-music" } });
  if (!response.ok || !response.body) {
    throw new Error(`Download request failed with status ${response.status}`);
  }

  const staging = dest + ".download";
  await pipeline(
    Readable.fromWeb(response.body),
    zlib.createGunzip(),
    fs.createWriteStream(staging),
  );
  return staging;
}

/**
 * Remove any SQLite WAL/SHM sidecar files left over from the previous database.
 * If these remain when a new corpus.db is swapped in, SQLite reads them as belonging
 * to the old file and reports "database disk image is malformed".
 */
function clearStaleSidecars(base) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.rmSync(base + suffix); } catch { /* file didn't exist — nothing to do */ }
  }
}

async function run() {
  if (!forcePull && corpusReady()) {
    console.log(
      `[fetch-corpus] corpus present (${toMB(fs.statSync(dbPath).size)}) — skipping. FORCE=1 to re-pull.`,
    );
    return;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  console.log(`[fetch-corpus] finding the latest corpus snapshot in ${ghRepo} …`);
  const { tag, asset } = await resolveDownloadAsset();

  console.log(`[fetch-corpus] ${tag}: downloading ${asset.name} (${toMB(asset.size)} gzipped) …`);
  const staging = await streamDecompress(asset.browser_download_url, dbPath);

  clearStaleSidecars(dbPath);
  fs.renameSync(staging, dbPath);

  console.log(`[fetch-corpus] ready → ${dbPath} (${toMB(fs.statSync(dbPath).size)})`);
}

run().catch((err) => {
  console.error(`[fetch-corpus] FAILED: ${err.message}`);
  console.error(
    `  → manual: download corpus-*.db.gz from https://github.com/${ghRepo}/releases and gunzip to data/corpus.db`,
  );
  process.exit(1);
});
