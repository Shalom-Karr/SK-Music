# SK Music

A fast, kosher, **filtered YouTube music web client** — search and stream a whitelisted catalog of Jewish
music, filtered by construction. It ships as a **static site on Cloudflare Workers**: the browser does the
searching over a prebuilt index, and playback runs through the official YouTube IFrame player.

Live: **https://skmusic.shalomkarr.workers.dev**

---

## What it is

- **Whitelisted catalog** — every song comes from a pre-approved artist, so the app is "accurate by
  construction." The catalog is fetched at build time and baked into the deploy; it is not committed here.
- **Client-side search** — the whole index is interned into one compressed dataset and searched in the
  browser (Hebrew-aware, fuzzy), off the main thread via a Web Worker. No search backend to run.
- **Static-first** — `dist/` (the SPA + the search engine + the baked catalog + assets) is served by a thin
  Cloudflare Worker that adds only what can't be static: live playlist contents, trending, server-rendered
  link previews, and anonymous play analytics.
- **PWA** — installable, with a service worker that caches the shell for fast repeat loads.

## Layout

```
engine/    the Cloudflare Worker (index.mjs) + the client-side search engine (ES modules → dist/lib) +
           the build: fetch-corpus.mjs (pull the catalog snapshot) → build-static.mjs (bake dist/),
           and store.mjs (reads the SQLite catalog, build-time only)
assets/    the SPA (ui.html) + analytics.html (admin) + connectivity.html + taggers, plus logo, PWA
           icons, web manifest, OG image
supabase/  schema.sql + tag/pin SQL (the backend: analytics, parental controls, artist tags)
docs/      architecture, filters + parental controls, backend, credentials
```

## Run & build

```bash
npm install          # one native dep: better-sqlite3 (prebuilt for your platform)
npm run build        # fetch the catalog snapshot, then bake dist/
npm run dev          # wrangler dev — serves dist/ + the Worker locally
```

`npm run build` downloads the latest public catalog snapshot (`CORPUS_REPO`) and generates `dist/`. See
`.env.example` for the (optional) configuration — everything has a working default.

## Deploy

Deploys to **Cloudflare Workers Static Assets** via GitHub Actions on every push to `main` (and daily, to
pick up catalog updates). Add a `CLOUDFLARE_API_TOKEN` repository secret to enable auto-deploy. To deploy
from your machine instead:

```bash
npm run deploy       # build + wrangler deploy
```

Worker name and account live in `wrangler.jsonc`.

## Credits

The whitelisted music **catalog** and **artist whitelist** that SK Music streams come from **Zemer** by
[alltechdev](https://github.com/alltechdev) — the [`zemer-app`](https://github.com/ZemerTeam/zemer-app) and
[`zemer-search`](https://github.com/ZemerTeam/zemer-search) projects. SK Music is an independent web client
with its own search engine; full credit and thanks to alltechdev for the catalog that makes this possible.

## Acknowledgments

A big thank you to [alltechdev](https://github.com/alltechdev)
([ars18](https://forums.jtechforums.org/u/ars18) on jtechforums) for a lot of advice and tips throughout the build.

Thanks also to the community at [jtechforums.org](https://forums.jtechforums.org) —
[pleasesmiletoday](https://forums.jtechforums.org/u/pleasesmiletoday) for ideas on what to build out and for
tagging singers, and [jask](https://forums.jtechforums.org/u/jask),
[ys770](https://forums.jtechforums.org/u/ys770), [flippy](https://forums.jtechforums.org/u/flippy), and
[the-curious](https://forums.jtechforums.org/u/the-curious) for help tagging singers.

## Disclaimer

SK Music is an independent, non-commercial project for **personal and educational use**. It is **not
affiliated with, endorsed by, or sponsored by YouTube or Google**. Playback uses the official YouTube
IFrame Player API; the app does not host, download, or re-encode any audio or video. Respect
[YouTube's Terms of Service](https://www.youtube.com/t/terms). Use at your own risk.

## License

SK Music is free software under the **GNU General Public License v3.0** — see [LICENSE](LICENSE).

Copyright © 2026 Shalom Karr. Portions derive from
[`zemer-search`](https://github.com/ZemerTeam/zemer-search) by
[alltechdev](https://github.com/alltechdev), also licensed GPL-3.0.

The GPL permits commercial use. As a personal request — **not** a condition of the license — please contact
the author before using SK Music, or substantial parts of it, in a paid or commercial product.
