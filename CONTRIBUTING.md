# Contributing

SK Music is free software under the **GNU GPL v3.0** (see [LICENSE](LICENSE)). Bug reports, ideas, and
patches are all welcome.

## Reporting bugs or suggesting features

Open an issue with, for a bug, clear steps to reproduce, what you expected, and what happened (a screenshot
or the browser console output helps a lot); for an idea, a short description of the problem it solves.

## Local setup

```bash
npm install          # one native dep: better-sqlite3 (prebuilt for your platform)
npm run build        # fetch the catalog snapshot, then bake dist/
npm run dev          # wrangler dev — serves dist/ + the Worker locally at http://127.0.0.1:8787
```

`npm run build` downloads the catalog snapshot and generates `dist/`. See [`.env.example`](.env.example) for
optional configuration.

## Layout

```
engine/     the client search engine (→ dist/lib) + the Cloudflare Worker (index.mjs) + build code
assets/     the SPA (ui.html) + admin/analytics + connectivity test + tagger, plus logo/icons/manifest/og
supabase/   schema.sql + tag/pin SQL (the backend)
docs/       architecture, filters + parental controls, backend, credentials
```

## Conventions

- **Vanilla JS, no framework or bundler.** `assets/ui.html` is one hand-written file — edit and rebuild.
- **Inline `onclick=` handlers must resolve to top-level `function` declarations** (those are global; `const`
  arrows are not reachable from inline handlers).
- **Build helpers** (`esc()`, `artHTML()`, `songRow()`, `*Card()`) keep escaping + placeholders consistent —
  build markup with them.
- **CSS variables for theme** (`:root`), never hardcoded colors/paths. The design is warm-luxe dark, Fraunces
  + Hanken Grotesk.
- **Always verify the static build** (`npm run build`) and eyeball it in `wrangler dev` before proposing a
  change — the deployed app runs the built `dist/`, not the source directly.
- Keep the docs in `docs/` current when behavior changes.

## License

By contributing, you agree your contributions are licensed under the project's **GNU GPL v3.0** (see
[LICENSE](LICENSE)).
