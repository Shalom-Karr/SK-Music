# SK Music — Architecture

How the whole thing fits together: a **static-first** music client that does its searching in the
browser and leans on a thin Cloudflare Worker only for the few things that genuinely can't be static.

See also: [`filters-and-parental-controls.md`](filters-and-parental-controls.md) ·
[`backend.md`](backend.md) · the repo [`README.md`](../README.md).

---

## 1. The big picture

```
                    build time (Node)                          serve time (edge + browser)
  ┌────────────────────────────────────┐        ┌──────────────────────────────────────────────┐
  │ upstream catalog (corpus-*.db.gz)  │        │  Cloudflare Worker (engine/index.mjs)          │
  │        │ fetch-corpus.mjs           │        │   • static assets from dist/ (SPA fallback)    │
  │        ▼                            │        │   • /playlist  live YouTube playlist contents  │
  │  data/corpus.db (SQLite)           │        │   • /zp-live   curated trending (KV + cron)    │
  │        │ build-static.mjs           │        │   • /trending  top songs/artists (Supabase RPC)│
  │        ▼                            │  push  │   • /a         analytics beacon → Supabase     │
  │  dist/  = SPA + lib/ engine +      │ ─────▶ │   • OG link previews for shared deep links     │
  │          data/ interned dataset +  │        │   • /analytics admin dashboard                 │
  │          per-entity JSON + sitemaps│        └───────────────────────┬────────────────────────┘
  │          + sw.js                   │                                │ dist/ assets
  └────────────────────────────────────┘                               ▼
                                                 ┌──────────────────────────────────────────────┐
                                                 │  Browser SPA (assets/ui.html)                     │
                                                 │   • engine Web Worker searches the interned    │
                                                 │     dataset off the main thread                │
                                                 │   • YouTube IFrame Player for playback          │
                                                 │   • Service Worker caches the shell (PWA)       │
                                                 └──────────────────────────────────────────────┘
```

There is **no application server** and **no search backend**. The catalog is a build-time input; the
running product is static files plus a small Worker.

The catalog itself — the "upstream catalog" — is a whitelisted snapshot of Jewish/Hebrew music
(every track is from a pre-approved artist, so the app is "accurate by construction"). It is a public
`corpus-YYYYMMDD.db.gz` SQLite release; it is fetched at build time, never committed.

---

## 2. The build (`engine/`)

`npm run build` = `fetch-corpus.mjs` then `build-static.mjs`.

### 2a. `fetch-corpus.mjs` — pull the catalog snapshot

Idempotent bootstrap of `data/corpus.db`:

1. If `data/corpus.db` already exists and is > 1 MB, stop (unless `FORCE=1`).
2. `GET https://api.github.com/repos/${CORPUS_REPO}/releases/latest` (default repo
   `ZemerTeam/zemer-search`; public, no auth — an optional `GITHUB_TOKEN`/`GH_TOKEN` only raises the
   API rate limit).
3. Find the release asset ending in `.db.gz`, download it, stream it through `zlib.createGunzip()`.
4. Remove any stale `-wal`/`-shm` sidecars (they otherwise make SQLite report "database disk image is
   malformed"), then rename into place at `CORPUS_DB` (default `data/corpus.db`).

### 2b. `engine/store.mjs` — the catalog reader (build-time only)

Opens the SQLite catalog with `better-sqlite3` (WAL, `foreign_keys=on`) and exposes the read helpers the
baker uses. The catalog schema is five tables:

| Table | Key columns |
|---|---|
| `artist` | `id` (UC… channel id), `name`, `thumbnail`, `regularChannelId`, `isFemale`, `isChasid`, `isKidZone` |
| `track` | `videoId`, `title`, `artistId`, `isVideo`, `explicit`, `durationSec`, `playCount`, `harvestedAt` |
| `album` | `id` (MPRE…), `playlistId`, `title`, `artistId`, `type` (`album`/`single`/`ep`), `year`, `thumbnail` |
| `playlist` | `id`, `title`, `artistId`, `thumbnail` |
| `album_track` | `albumId`, `videoId`, `pos` (PK `albumId,videoId`) |

Key exports: `openCorpus()`, `allTracks/allArtists/allAlbums/allPlaylists`,
`artistDetail(db,id)` → `{artist,songs,videos,albums,singles,playlists}`,
`albumDetail(db,id)` → `{album,tracks}`, `recentAlbums`, `stats`.

> The `artist.isFemale / isChasid / isKidZone` flags are the raw material for the content filters
> (see [filters-and-parental-controls.md](filters-and-parental-controls.md)).

### 2c. `build-static.mjs` — bake `dist/`

`BUILD = Date.now()` is the single cache-buster: it stamps `?v=BUILD` onto every `/lib/*.mjs` URL and
names the service-worker cache `skmusic-${BUILD}`. The bake clears `dist/` and writes:

**The interned search dataset — `dist/data/dataset.json.gz`.** The heart of client-side search. Every
entity is packed into arrays, with tracks/albums/playlists storing an **integer index** into a single
shared `artists` array instead of repeating the artist object (booleans are packed into bit-flag fields).
gzip level 9. Shape (`v:1`):

```
artists:     [[id, name, thumbnail, flags]]                              // flags: 1=female 2=chasid 4=kidzone
tracks:      [[videoId, title, artistIdx, flags, durationSec, playCount]] // flags: 1=isVideo 2=explicit
albums:      [[id, playlistId, title, artistIdx, isSingle, year, thumbnail]]
albumTracks: { albumId: [videoId, …] }
playlists:   [[id, title, artistIdx, thumbnail]]
```

**Per-entity detail JSON** (so opening a page never needs the whole dataset):
`dist/data/artist/<id>.json`, `dist/data/album/<id>.json`. Plus `dist/data/og.json`
(`{videoId:[title,artist]}`) for the Worker's link previews.

**Prebuilt feeds:** `dist/data/home.json` + `dist/data/home.kidzone.json` (quick picks, latest releases,
new songs, featured playlists/artists/albums/videos, trending), `dist/data/artists.json` (full sorted
artist list, enriched with `isDJ/isAmerican/isFamous/isIsraeli/isAcapellaOnly` from the live tag
sources), `dist/data/meta.json` (corpus counts + `builtAt`), `dist/data/synonyms.json`.

**Curated playlists** (`dist/data/zemer-playlist/<id>.json` + `.svg` covers, and
`dist/data/zemer-playlists.json`): fetched from `CATALOG_API` (`https://search.zemer.io`) with retry;
thumbnails rewritten to local paths.

**The browser engine — `dist/lib/*.mjs`:** the `engine/` ES modules are copied with two transforms —
relative imports get `?v=${BUILD}` appended, and `synonyms.mjs` has its Node-only lines stripped so it
runs in the browser.

**SEO:** `sitemap-*.xml` (static, artists, albums, playlists, kidzone, and songs chunked at 45k/file)
+ a `sitemap.xml` index, `robots.txt` (disallows `/analytics`), and an IndexNow key file.

**The app shell — `dist/index.html`:** `assets/ui.html` with four markers replaced —
`<!--STATIC_BUILD-->`, `<!--CF_ANALYTICS-->` (optional CF Web Analytics beacon from
`CF_ANALYTICS_TOKEN`), `<!--OGTAGS-->` → `<!--OG-->…<!--/OG-->` (default Open Graph block the Worker can
later override for deep links), and versioned `/lib/engine*.mjs` URLs.

**Also written:** `dist/analytics.html` (from `assets/analytics.html`), `dist/test.html` (from
`assets/connectivity.html`), the two tagger tools baked with the current artist list
(`dist/israeli-tagger.html`, `dist/chasidish-tagger.html`), `dist/assets/*`, `dist/_headers`
(immutable caching for `/lib/*`), and the service worker `dist/sw.js` (see §6).

---

## 3. Client-side search engine (`engine/` → `dist/lib/`)

All searching happens **in the browser, off the main thread**. `assets/ui.html` talks to the engine the
same way it would to a REST API (`getJSON("/search?q=…")`), but the "server" is a Web Worker.

### Data flow

`corpus.db` → (build) `dist/data/dataset.json.gz` → (browser) `engine.mjs:ensureDataset()` fetches it,
decompresses via `DecompressionStream("gzip")`, and `inflate()` unpacks the interned arrays back into
object graphs plus `trackById / artistById / albumById` lookup Maps.

### The Web Worker (`engine-worker.mjs`)

`ui.html` posts `{id,url}` messages to the worker; the worker calls `handle(url)` from `engine.mjs` and
posts back `{id,r}`. It defers the heavy category-index build with a `setTimeout(preload, 2500)` so cheap
boot reads (`/home`, `/artists`, `/health`) don't wait on it. If the worker fails to load, `ui.html`
falls back to running the engine in-thread.

`handle(url)` routes by pathname, mirroring the old server API:
`/home`, `/artists`, `/playlists`, `/search`, `/artist?id=`, `/album?id=`, `/track?v=`,
`/zemer-playlists`, and `/playlist?id=` (the **only** route that hits the network — it proxies to the
Worker, then filters the returned tracks through `trackById` to keep only whitelisted songs). Every list
route honors the content-filter query params (`allowFemale`, `allowChasid`, `kidZone`, `blockVideos`).

### Matching (`search.mjs`, `normalize.mjs`, `categories.mjs`, `synonyms.mjs`)

- **Two normalizations** per string. `plainTokens()` NFD-normalizes, strips Hebrew niqqud + in-word
  apostrophes/geresh, lowercases, and tokenizes. `skeletonTokens()`/`skeletonKey()` additionally
  *romanize Hebrew consonants* and fold Latin digraphs (`sh→s`, `ch/kh→k`, `tz→c`, `v→b`, `f→p`…) and
  drop vowels — so `צ־` transliterations and spelling variants collide onto the same key. This is what
  makes search **Hebrew-aware**.
- **Inverted index** (`buildIndex`): a `plain` and a `skel` index, each `Map<token, Map<docId, fieldBits>>`
  (title=1, artist=2), plus a bigram candidate index and per-token IDF. Exact / prefix / **fuzzy**
  (Damerau-Levenshtein distance 1 via bigram candidates) matches are scored with descending weights.
- **Ranking** (`search`): coverage gate (must match ≥ half the query words), then boosts for exact/
  begins-with on artist and title, a multi-word artist-affinity bonus, and a relevance floor that drops
  results below 40 % of the top score.
- **Categories** (`buildCategories` / `searchCategories`): six separate indexes — artists, songs, albums,
  singles, videos, playlists — searched in parallel and post-filtered by the content flags.
- **Synonyms** (`synonyms.mjs`): `expandQuery` adds every form in a matched synonym group to the query
  (compiled from `data/synonyms.json`), so alternate spellings/names retrieve each other.

---

## 4. The Cloudflare Worker (`engine/index.mjs`)

A thin edge layer in front of `dist/`. `wrangler.jsonc` binds the static assets (`ASSETS`, SPA fallback),
a KV namespace (`PAGES`), a cron (`15 8,20 * * *`), and observability. Routes, in order:

| Route | What it does |
|---|---|
| KV page override | For page-like GETs (`.html/.js/.css/.json/.xml/.txt`, excluding `/data` & `/lib`), serve a KV-published override first — lets you replace a single page without a full deploy. |
| `GET /playlist?id=` | Live-fetches a YouTube community playlist via the `youtubei` `browse` endpoint, recursively collects every track row + continuation token (robust to layout changes), edge-caches non-empty results 30 min. The browser then filters to the whitelisted corpus. |
| `GET /zp-live?id=` | Serves a curated **trending** playlist from KV (`PAGES`), refreshed by the cron; falls back to a live edge-cached fetch from `https://search.zemer.io/zemer-playlists`. Same-origin so it works behind content filters. |
| `GET /trending?days=` | Blends two play populations into one id-resolved ranking: our web plays (Supabase RPCs `top_songs` + `top_artists`, anon key) and the Zemer Android app's listening stats (KV `ext-trending-v1`, written by the cron from `tracking.zemer.io/stats/public` — videoIds filtered to our catalog via `og.json`, artist names resolved to channel ids via `artists.json`). Score = web-play share + app unique-**device** share, each normalized to its own top item. Songs carry `videoId`+`artistId`, artists carry `id`; legacy keys (`title`/`artist`) are kept for cached clients. Edge-caches 30 min. Feeds the home "Trending" rails. |
| `POST /a` | **Analytics beacon.** Accepts a batched array of events, enriches each with server-derived IP/country/city/region + parsed browser/OS/device, and bulk-inserts one row per event into the Supabase analytics table in a single POST (`ctx.waitUntil`, never blocks the beacon). Returns 204. See [backend.md](backend.md). |
| `GET /analytics` | The admin dashboard (`analytics.html`), served `no-store` (KV override wins). |
| `GET /test` | The connectivity self-test page (`assets/connectivity.html`). |
| `GET /israeli-tagger`, `/chasidish-tagger` | The crowdsourced artist-tagging tools. |
| Deep-link OG | `GET /song/:id`, `/artists/:id`, `/albums/:id`, `/zemer-playlists/:id` — fetches the app shell and replaces the baked `<!--OG-->…<!--/OG-->` block with an entity-specific Open Graph/Twitter preview (title/artist/cover from `og.json` or the per-entity JSON), so a shared link unfurls correctly. Any lookup failure falls back to the generic block; the SPA still boots normally. |
| everything else | `env.ASSETS.fetch` → static file, or the SPA `index.html` fallback. |

`scheduled()` runs two jobs on the cron (08:15 / 20:15 UTC, ~15 min after the upstream regenerates):
`refreshTrending()` pulls the fresh curated trending playlists (`auto-trending`, `auto-top-50`,
`auto-acapella-top-50`) into KV, and `refreshExternalTrending()` pulls the Zemer app's public listening
stats (`tracking.zemer.io/stats/public?days=30`), resolves them to catalog song/artist ids (dropping
anything outside the whitelist by construction), and parks the result in KV (`ext-trending-v1`, 13 h TTL)
for `/trending` to blend at read time. Both are best-effort — a failed fetch just leaves the previous KV
copy (or web-only trending) in place.

---

## 5. Playback — YouTube IFrame Player

SK Music does **not** host, proxy, or re-encode audio. The SPA plays through the **official YouTube
IFrame Player API**: given a `videoId`, it drives the embedded player for play/pause/seek/next and wires
`mediaSession` for lock-screen controls. This is a deliberate simplification over the upstream project's
server-side stream-resolution pipeline — there is no `/stream` route here, which is part of why the whole
app can be static.

---

## 6. PWA / service worker

`build-static.mjs` emits `dist/sw.js` inline with cache version `V = "skmusic-${BUILD}"`.

- **install:** precache the shell — `/`, all `/lib/*.mjs?v=BUILD`, and the stable `/data/*.json` feeds
  (`meta`, `home`, `home.kidzone`, `artists`, `synonyms`, `zemer-playlists`). `skipWaiting()`.
- **activate:** delete every cache whose key ≠ `V`, then `clients.claim()`.
- **fetch:** three strategies —
  - **navigations:** network-first, refresh the cached `/` shell on success, serve `/` offline;
  - **`/lib/*`:** network-first (so a fresh shell never runs against a stale engine), cache fallback;
  - **`/data/*`:** cache-first (large + stable; the versioned cache handles refresh).
  - Non-GET, cross-origin, and `/playlist` are never intercepted.

A new deploy bumps `BUILD` → new cache name + new `/lib` URLs → everything is re-fetched and the old cache
is purged on activate. This is the SW-cache invariant to respect when editing engine modules: **the
version stamp is what busts the cache** — always go through the `?v=BUILD` build step, never hand-edit
`dist/lib`.
