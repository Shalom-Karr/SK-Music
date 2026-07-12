# SK Music — Desktop (Tauri 2)

Native desktop shell for **SK Music**, the kosher, whitelist-scoped Jewish-music client.

This is a **thin wrapper**: the app window loads the already-deployed web app
(`https://skmusic.shalomkarr.workers.dev`) directly in the system webview, so the SPA,
the client-side search engine, the content filters/parental controls, and the YouTube
IFrame player all run **unchanged**. The Rust side adds only what a browser can't:

- **System tray** + close-to-tray so playback keeps going with the window hidden.
- **OS media controls** — Windows SMTC / macOS Now Playing / Linux MPRIS (via `souvlaki`):
  hardware media keys and the now-playing tile.
- **`skmusic://` deep links** that open the app instead of bouncing through a browser.
- **Single-instance** focus (a second launch / deep link focuses the running window).
- **Signed auto-update** from the same whitelisted `skmusic` origin.

The native modules live in `src-tauri/src/{tray,media,deeplink,updater}.rs`, wired into
`main.rs`'s builder (`.setup()` inits + the single-instance / deep-link / updater plugins).
See `../docs/rust-desktop-app-plan.md` (in the repo) for the full design.

## Architecture

```
                    ┌─────────────────────────── Tauri window (system webview) ───────┐
  media keys ─────▶ │  loads  https://skmusic.shalomkarr.workers.dev  (remote SPA)     │
  skmusic:// ────┐  │  · SPA + search engine + content filters + YouTube-IFrame player │
                 │  └──────────────────────────────────────────────────────────────────┘
                 │        ▲  invoke(now_playing/…)          ▲  eval(__skMediaControl)     ▲ listen(updater://…)
                 ▼        │                                 │                             │
        ┌──────────────── Rust (src-tauri) ─────────────────────────────────────────────┐
        │ tray.rs     system tray + close-to-tray (hide, keep webview + audio alive)     │
        │ media.rs    souvlaki → OS media session (SMTC/MPRIS/NowPlaying) ⇄ webview PB    │
        │ deeplink.rs skmusic:// → resolve to trusted worker path → WebviewWindow.navigate│
        │ updater.rs  signed manifest check → background download → apply on next launch  │
        └────────────────────────────────────────────────────────────────────────────────┘
```

The webview does **everything a browser would** (UI, playback, filtering). Rust only adds
the four OS-integration pieces above; no filtering or track-selection logic lives in Rust.

The webview↔Rust bridge needs two config grants (already set in `tauri.conf.json` /
`capabilities/`): `app.withGlobalTauri: true` (so the remote page can reach
`window.__TAURI__`) and `capabilities/default.json`'s `remote.urls` entry trusting the
worker origin. Per-module JS-bridge contracts are documented at the top of each `.rs` file.

Nothing about the backend, the Supabase-enforced parental hard lock, or the filtering
model changes — this is a new *client*, not a rebuild. The SPA is **not** bundled or
copied here; it is loaded remotely.

## Prerequisites

- **Rust** (stable, edition 2021) — install via [rustup](https://rustup.rs).
- **Tauri CLI** — `npm install` (installs `@tauri-apps/cli` v2 locally) or `cargo install tauri-cli --version "^2"`.
- **Platform webview / build deps:**
  - **Windows:** WebView2 runtime (preinstalled on Win11; the bundler embeds a
    bootstrapper for Win10) + MSVC Build Tools.
  - **macOS:** Xcode Command Line Tools (WKWebView is system-provided).
  - **Linux:** `webkit2gtk-4.1` and its dev packages (e.g. `libwebkit2gtk-4.1-dev`,
    `build-essential`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).

## Run

```bash
cd Desktop
npm install          # once, for the Tauri CLI
npm run tauri dev    # or: cargo tauri dev
```

`cargo tauri dev` launches the window against the live `skmusic` origin. Because the app
loads a remote https URL, no local frontend dev server is needed.

## Build

```bash
npm run tauri build  # or: cargo tauri build
```

Produces per-OS bundles (`nsis` on Windows; `.app`/`.dmg` on macOS; `.deb`/AppImage on
Linux). Icons in `src-tauri/icons/` are **placeholders** — replace before release
(see `src-tauri/icons/README.md`). The updater `pubkey` and `endpoints` in
`src-tauri/tauri.conf.json` are placeholders until the release signing keypair exists.

## Layout

```
Desktop/
├── package.json            # "tauri" script + @tauri-apps/cli v2
├── .gitignore
├── README.md
└── src-tauri/
    ├── Cargo.toml          # sk-music-desktop; tauri 2 + plugins + souvlaki
    ├── tauri.conf.json     # window → remote URL; updater/deep-link config; bundle targets
    ├── build.rs            # tauri_build::build()
    ├── capabilities/
    │   └── default.json    # core IPC + app commands, scoped to the remote worker origin
    ├── icons/              # placeholder app/tray icons (replace before release)
    └── src/
        ├── main.rs         # Builder: single-instance + deep-link + updater plugins; setup() inits
        ├── tray.rs         # system tray + close-to-tray; hosts the updater menu item
        ├── media.rs        # souvlaki OS media controls ⇄ webview
        ├── deeplink.rs     # skmusic:// scheme + route into the SPA (unit-tested)
        └── updater.rs      # signed auto-update (check on launch, apply on next launch)
```

## Native module notes

- **Tray is built in Rust** (`TrayIconBuilder`), not via `tauri.conf.json`, because tray
  click/menu handlers can only be attached at build time. The window label stays `"main"`.
- **Commands** exposed to the SPA: `now_playing`, `set_playback_state` (media) and
  `updater_check`, `updater_restart` (updater), via `invoke_handler`.
- **Deep-link** registration is runtime on Linux / Windows-debug; release Windows + macOS
  get the scheme from `plugins.deep-link.desktop.schemes`. Every link is re-resolved
  against the worker origin, so it can never point off the whitelisted host.
- **Updater** downloads in the background and stages the update; it applies on the next
  quit (`RunEvent::Exit`) or when the user picks "Restart to update" — never mid-playback.
  Set `plugins.updater.pubkey` + the release keypair before shipping (see `updater.rs`).
