# Asset file limit & deep-link OG shells

SK Music deploys as a **Cloudflare Worker with Static Assets**: `engine/index.mjs` is the Worker, and
everything under `dist/` is uploaded as static assets. The asset layer serves any file that exists
**directly, without invoking the Worker** — the Worker only runs for paths that don't match a file. Turning
a route into a real file therefore takes it off the Worker entirely (this is how `/favicon.ico`, the
sitemaps, and the deep-link OG shells avoid the Worker).

## The 20,000-file hard limit

Cloudflare caps a single Workers deployment at **20,000 asset files** (and 25 MiB per file). Exceeding it
makes `wrangler deploy` reject the whole upload. The build counts files and guards against this.

### What consumes the budget (typical)

| Files | Source |
|------:|--------|
| ~13,800 | `dist/data/album/<id>.json` — per-album detail (the bulk) |
| 1,621 | `dist/data/artist/<id>.json` — per-artist detail |
| 1,621 | `dist/artists/<id>.html` — artist OG shells |
| 1,837 | `dist/playlists/<id>.html` — playlist OG shells |
| ~30 | dataset, home feeds, sitemaps, taggers, icons, `index.html`, `sw.js`, `_headers`, etc. |
| **~18,950** | **total (as of this writing)** |

## Deep-link OG shells

`/artists/:id` and `/playlists/:id` are hit mostly by crawlers and social/link-preview bots, which need
server-rendered Open Graph tags. Rendering those in the Worker was ~28% of all Worker requests.

Instead, `engine/build-static.mjs` **pre-bakes a ~2 KB static shell** for each artist and playlist
(`dist/artists/<id>.html`, `dist/playlists/<id>.html`). Each shell carries the entity's OG tags for
crawlers, then — for real visitors — `fetch("/")` and `document.write`s the full SPA in place. Because the
SPA routes by `location.pathname`, the visitor lands on the same artist/playlist with the URL unchanged.
These shells are served by the asset layer, so they cost **zero Worker requests**.

## Graceful degradation past the cap ("non-files")

Pre-baking is an **optimization, not a requirement**. The Worker's `renderDeepLinkShell` still produces the
exact same OG shell on demand for any deep link that has no pre-baked file. So the build only bakes as many
shells as fit under a safety cap and lets the rest fall back to the Worker:

- **`FILE_CAP = 19800`** (with a small `RESERVE` for the always-run assets written after the shell step).
- The build bakes artist shells, then playlist shells, decrementing the remaining budget per file.
- Once the budget is exhausted, the remaining deep links are **not written as files** — they are served
  **dynamically by the Worker** instead. Same correct OG for crawlers; just a Worker request per hit rather
  than an asset hit.
- The build log says exactly what happened, e.g.
  `deep-link OG shells: 1621 artists + 1837 playlists → asset-served (no Worker)`, or when over the cap,
  `… pre-baked; N over the 19800-file cap → served dynamically by the Worker`.

So as the catalog grows, the site never breaks at the file limit — it simply degrades to more Worker
requests for the deep links that couldn't be pre-baked.

### Backstop

A final check throws if the total exceeds **19,950** files. Because shell pre-baking already caps itself,
this only fires when the **non-shell** files alone (mainly the ~13.8k per-album detail files) approach the
limit — which skipping shells can't fix. The error points at the real remedy below.

## Reclaiming headroom

The per-album detail files (`dist/data/album/<id>.json`, ~13.8k) are the dominant consumer. The durable fix
is to **fold album detail into the shipped dataset** (`dist/data/dataset.json.gz`, already loaded
client-side) and have the app read album detail from there instead of per-album fetches. That removes
~13,800 files in one move, dropping the deployment to ~5,000 files and leaving plenty of room to pre-bake
every deep-link shell (and more) with margin to spare.
