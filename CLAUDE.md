# SK Music — project instructions

## Changelog discipline (required)

Update `CHANGELOG.md` on **every** push that either:

- **changes the web app** — anything that redeploys the Cloudflare Worker (edits under `assets/`,
  `engine/`, or the worker/build config), **or**
- **releases a new desktop version** — a version bump in `Desktop/src-tauri/tauri.conf.json` and
  `Desktop/src-tauri/Cargo.toml`, which makes CI publish a `desktop-v*` GitHub release.

Add a dated entry at the **top** of `CHANGELOG.md`: the version, a one-line "why the bump," and the
user-facing changes grouped by area. Match the format of the existing entries. A web-only change that
doesn't bump the desktop version still gets its own entry describing what shipped. Never push a
web/desktop-releasing change without a corresponding changelog entry in the same push.

> Note: `Desktop/src-tauri/tauri.conf.json` and `Cargo.toml` are parsed by CI — write them with a
> BOM-free editor (a UTF-8 BOM breaks the TOML/JSON parse). See the version-bump history for context.
