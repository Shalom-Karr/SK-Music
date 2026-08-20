# SK Music — Rust Desktop App: Technical Plan

Status: proposal / design doc. Nothing here is built yet.
Scope: a native desktop client (Windows-first, Mac/Linux second) for **SK Music**, the kosher,
whitelist-scoped Jewish music client that today ships as a static Cloudflare Worker + a single-file
vanilla-JS SPA (`assets/ui.html`) with a client-side search engine (`engine/*.mjs`) over a ~4.3 MB
gzipped dataset, and plays audio through YouTube's embedded IFrame player.

Cross-refs: [`architecture.md`](architecture.md) · [`filters-and-parental-controls.md`](filters-and-parental-controls.md) ·
[`backend.md`](backend.md).

TL;DR recommendation is in [§7](#7-recommendation--mvp-scope). Read [§2](#2-playback-the-crux) first if you
only read one section — playback is the crux and it constrains everything else.

---

## 1. Goal — why a desktop app at all

The web app is already excellent and works behind content filters. A desktop app is justified **only** if
it buys things the browser can't. It does:

| Want | Web app today | Desktop app buys |
|---|---|---|
| **Background play** | Dies/suspends when the tab is backgrounded or the browser is closed; mobile browsers aggressively throttle background audio | App keeps playing with the window hidden to the system tray; no tab to lose |
| **Hardware media keys** | `mediaSession` works *only while the tab is focused-ish* and competes with every other tab | True OS media integration (Windows SMTC / macOS Now Playing / Linux MPRIS) — play/pause/next on the keyboard and lock screen, always |
| **System tray + launch-on-login** | N/A | Minimize-to-tray, "close = keep playing", start with Windows |
| **No browser / filter friction** | User must open a browser, which on filtered machines (Techloq etc.) is often the *most*-scrutinized app; YouTube links land on filter block pages | A single signed `.exe` the family already trusts; deep links (`skmusic://song/…`) open the app directly instead of bouncing through a browser + the existing redirector userscript |
| **Offline browse/search** | Service worker caches the shell + dataset, but it's still "a website" and a cache purge/incognito loses it | Dataset + engine live on disk; search & browse work with **zero** network. (Playback still needs network — see §2.) |
| **Native performance / instant boot** | Cold boot fetches shell + 4.3 MB dataset; SW helps on repeat | Shell + engine are local from install; only the dataset refresh and live routes touch the network |
| **A "real app" for the audience** | — | The audience skews Windows, frum, behind filters. A desktop app on the taskbar is a materially better fit than "a bookmark" |

What a desktop app does **not** change: the catalog is still a whitelist, filtering is still central and
non-negotiable, and the backend (Supabase) and live routes stay exactly as they are. This is a **shell**
project, not a rebuild.

Non-goals for v1: no re-hosting audio, no offline *audio* downloads (see §2 on why), no change to the
parental-controls trust model, no mobile (that's a separate PWA/Capacitor/Tauri-mobile conversation).

---

## 2. Playback — the crux

Everything downstream (framework, architecture, legal posture) is decided by how audio plays. There are
two families, and the web app already made this decision deliberately. **Read the existing rationale in
`assets/ui.html` around the `PB` player object (~line 1787):**

> *"Primary engine: YouTube's own hidden IFrame player (audio-only). It loads youtube.com/embed and lets
> YouTube handle cipher / n-transform / poToken internally — so there is NO InnerTube API call for a
> network content filter to intercept, and playback works wherever the embed is allowed."*

That comment is the whole ballgame. The IFrame approach was chosen precisely because it (a) avoids the
fragile stream-resolution pipeline and (b) is *filter-friendly* — there is no `googlevideo.com`
signed-URL fetch or InnerTube `player` call for a content filter or YouTube's own anti-bot to sit on;
YouTube's first-party player does all of that inside the iframe. Note also that the `/stream` fallback
referenced in `ui.html` (`PB.mode === "html5"` → `<audio src="/stream?v=…">`) is **dormant**: the Worker
(`engine/index.mjs`) has no `/stream` route. So today playback is **100% IFrame**.

### Option A — Embed the YouTube IFrame player in the app's webview (RECOMMENDED)

Run the exact same `youtube.com/embed` + IFrame Player API inside the desktop app's embedded browser
engine (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux). This is what the SPA already does;
we're just relocating the webview from "a browser tab" to "our app window."

- **Pros:** byte-for-byte reuse of the shipped player logic; YouTube handles cipher/nsig/poToken forever;
  no extraction to break; **same filter-friendliness the web app relies on**; unambiguously within the
  intended use of the IFrame Player API (it *is* the sanctioned embed path); `mediaSession` already wired.
- **Cons:** requires a browser engine in the app (fine — every desktop-webview framework has one);
  YouTube can still refuse individual videos (embedding-disabled → error 101/150, already handled by
  `onPlaybackError`); background-throttling of a hidden webview needs care (see §2.4); the IFrame API is
  origin-sensitive, so the app's page origin matters (see risk in §2.3).
- **Kosher-filtering implication:** *none, positive.* The app only ever holds whitelisted `videoId`s;
  the IFrame plays exactly what it's told; no discovery surface, no related-video leakage
  (`rel:0`, `controls:0`, off-screen iframe — same `playerVars` as today). Content policy is unchanged.

### Option B — Native stream extraction + a Rust audio stack (NOT recommended for v1)

Resolve the audio stream yourself and play it natively:

- **Extraction:** `yt-dlp` as a bundled sidecar (most robust, ~35 MB, Python-free static build, but a
  separate updater to babysit), or a pure-Rust InnerTube client (`rusty_ytdl` ~0.7, or the unmaintained
  `rustube`) that speaks the `player` endpoint, runs the JS `n`/`sig` transforms, and now must also mint a
  **poToken** (BotGuard) — the exact machinery YouTube keeps changing.
- **Playback:** `symphonia` 0.5 (pure-Rust demux/decode: AAC/Opus/WebM) → `rodio` 0.20 → `cpal` 0.15 for
  output. Solid, boring, works.
- **Pros:** full control — real seek/gapless, a proper progress bar, per-track normalization, and the one
  thing Option A *cannot* do: **true offline audio caching/downloads.**
- **Cons — be honest:**
  - **Fragility.** nsig/cipher/poToken break on YouTube's schedule (historically every few weeks to
    months). A music app that stops playing until you ship an extractor update is a support nightmare for
    a non-technical frum audience. `yt-dlp` absorbs this but only if it auto-updates — and auto-updating a
    binary *on a filtered network* is itself unreliable.
  - **Filter-hostility.** This reintroduces exactly what the web app designed away: a visible InnerTube
    call + a `googlevideo.com` media fetch, both of which filters and YouTube anti-abuse inspect. On a
    Techloq-style network this is *more* likely to be blocked than the first-party embed, not less.
  - **ToS / legal.** The IFrame Player API is the *sanctioned* embed. Extracting streams and playing them
    outside YouTube's player is against YouTube ToS and removes the "we're just embedding" cover. For a
    community-facing kosher product tied to real names, that posture matters. Offline *downloads* are a
    further step and squarely a ToS violation.
  - **Kosher-filtering implication:** neutral-to-worse. You still only resolve whitelisted ids (fine), but
    you now own an extractor that could, if mis-pointed, resolve anything — a larger trust surface than "an
    iframe that can only load the id we give it."

### Verdict

**Ship Option A.** It matches the web app, preserves filter-friendliness, and eliminates the single
largest maintenance risk (extraction). Keep Option B on the roadmap as an **opt-in, clearly-labeled**
"experimental offline mode" only if genuine offline audio becomes a top user request — and even then, via
`yt-dlp` sidecar, gated behind an explicit user acknowledgement, never the default. Do not let it into v1.

---

## 3. Framework choice

The realistic candidates split into "webview shell" (reuse the SPA) vs "native Rust GUI" (rebuild the UI).

| Framework | Language of UI | Reuse of `ui.html`/engine | Ships a webview | Verdict |
|---|---|---|---|---|
| **Tauri 2** | the existing HTML/JS | **~100%** — the SPA and `engine/*.mjs` run as-is | Yes (system WebView2/WKWebView/WebKitGTK) | ✅ **Recommended** |
| Wry/Tao (raw) | HTML/JS | 100%, but you hand-build tray/updater/IPC | Yes | Only if you want no framework; Tauri *is* Wry+batteries |
| Dioxus (desktop) | Rust (RSX) or its own webview | Webview mode ≈ Tauri; native mode = rewrite | Yes (uses Wry) | No advantage over Tauri here |
| egui / eframe | Rust (immediate-mode) | **0%** — rewrite the entire UI; no HTML engine → **can't host the YouTube IFrame** | No | ❌ kills Option A |
| iced | Rust (Elm-style) | 0% — full rewrite; no webview → no IFrame | No | ❌ kills Option A |
| slint | `.slint` DSL | 0% — full rewrite; no webview | No | ❌ kills Option A |

The decision is essentially forced by §2: **if playback is the YouTube IFrame, the app must contain a
browser engine, and a native-GUI toolkit (egui/iced/slint) cannot host it.** You'd end up embedding a
webview *anyway* just for the player — at which point you've reinvented a worse Tauri. Native GUI only
makes sense paired with Option B (native audio), which we rejected for v1.

### Why Tauri 2 specifically

- **Reuses the crown jewels.** `assets/ui.html` (2,416 lines, single file, vanilla JS, no build step) and
  the `engine/*.mjs` Web-Worker search engine are *already* a self-contained web app that talks to its
  "backend" via `getJSON("/…")`. Point Tauri's webview at it and it runs. The `DecompressionStream("gzip")`
  the engine uses to inflate `dataset.json.gz`, the Web Worker, `mediaSession`, `localStorage` — all
  standard web APIs present in WebView2/WKWebView/WebKitGTK.
- **Tiny footprint.** Tauri uses the *system* webview (no bundled Chromium à la Electron). Rust core binary
  is ~3–8 MB; installer with the bundled shell + dataset lands around **15–25 MB** (vs Electron's 120 MB+).
  On Windows 11 the WebView2 runtime is preinstalled; on Win10 it's near-ubiquitous and can be bundled.
- **Batteries for exactly our list:** tray, global shortcuts (media keys), single-instance, deep-link
  protocol registration, auto-updater, window-state — all first-party plugins (§5, §4).
- **Rust backend where it earns its keep:** the native-only glue — OS media controls, tray, deep-link
  handler, dataset fetch/cache to disk, updater — is Rust; the UI stays the proven SPA. Best of both.

Concrete crate set (Tauri 2.x line — pin to latest 2.x patch at implementation time):

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "protocol-asset"] }
tauri-plugin-single-instance   = "2"   # focus the running window instead of a 2nd copy
tauri-plugin-deep-link         = "2"   # register skmusic:// and handle /song/:id etc.
tauri-plugin-global-shortcut   = "2"   # capture media keys as a fallback
tauri-plugin-updater           = "2"   # signed auto-update
tauri-plugin-window-state      = "2"   # remember size/pos; restore hidden-to-tray
tauri-plugin-autostart         = "2"   # optional launch-on-login
tauri-plugin-store             = "2"   # small native KV (last-played, settings mirror)
souvlaki                       = "0.7" # OS media controls: SMTC (Win) / MPRIS (Linux) / MPNowPlaying (mac)
reqwest = { version = "0.12", features = ["gzip", "stream"] } # dataset fetch/refresh
tokio   = { version = "1", features = ["full"] }
serde   = { version = "1", features = ["derive"] }
serde_json = "1"

[build-dependencies]
tauri-build = "2"
```

(`souvlaki` is the load-bearing non-Tauri crate: it gives real Windows System Media Transport Controls —
the now-playing tile, artwork, and *hardware media-key events* — plus MPRIS/Now-Playing on Linux/macOS.
The webview's `mediaSession` alone is not reliably wired to Windows SMTC from a Tauri custom-protocol
origin, so we bridge it: webview posts now-playing state to Rust → `souvlaki` publishes to the OS →
OS media-key events come back to Rust → forwarded into the webview's `PB` player. See §4.4.)

---

## 4. Architecture

### 4.1 Overall shape

```
┌────────────────────────────── Desktop app (Tauri 2) ──────────────────────────────┐
│                                                                                    │
│  Rust core (src-tauri/)                     WebView (WebView2 / WKWebView / WebKitGTK) │
│  ────────────────────────                   ────────────────────────────────────────  │
│  • window + tray + menu                     • assets/ui.html  (the SPA, ~verbatim)     │
│  • deep-link (skmusic://…)  ───IPC──▶        • engine-worker + engine/*.mjs (unchanged) │
│  • souvlaki media controls  ◀──IPC──         • YouTube IFrame Player (youtube.com/embed)│
│  • dataset fetch/cache      ───serve──▶       • localStorage: filters, zw_policy, recents │
│  • updater / single-instance                • fetch("/…") → intercepted (see 4.3)       │
│  • settings store                           • Supabase JS (pc_* RPCs, analytics)        │
└────────────────────────────────────────────────────────────────────────────────────┘
                    │ network (only for live bits + playback)
                    ▼
   skmusic.shalomkarr.workers.dev  (/playlist, /zp-live, /trending, /a, dataset.json.gz refresh)
   www.youtube.com/embed           (audio playback via IFrame)
   *.supabase.co                   (accounts, parental pc_* RPCs, likes, analytics)
```

**Nothing about the backend or the filtering model changes.** The Worker, Supabase schema, `pc_*` RPCs,
and analytics pipeline are reused as-is over the network. The desktop app is a new *client*.

### 4.2 Reusing the catalog + JS search engine — run it as-is (do NOT port to Rust)

Three ways to get search/browse; the first is correct:

1. **Run the existing JS engine in the webview (RECOMMENDED).** Bundle `engine/*.mjs` and the built
   `dataset.json.gz` as app assets (or fetch+cache the dataset — §4.5). The engine already runs in a Web
   Worker, already inflates the interned dataset with `DecompressionStream`, and already answers the
   pseudo-REST routes (`/home`, `/search`, `/artist`, …) that `ui.html` calls via `getJSON`. **Zero
   porting.** The only routes that touch the network (`/playlist`, plus the live feeds) are handled in
   §4.3. This preserves the byte-for-byte-identical behavior the web app is validated on — including all
   the Hebrew-aware normalization, synonyms, fuzzy matching, and the content-filter post-gating in
   `categories.mjs`/`engine.mjs`.
2. **Port `engine/` to Rust** (only if going native-GUI). ~1,000 lines of subtle Hebrew normalization
   (niqqud stripping, consonant romanization, digraph folding), inverted index, Damerau-Levenshtein fuzzy,
   IDF ranking, synonyms. Re-implementing this correctly in Rust is weeks of work and a *permanent second
   copy to keep in sync* with every catalog/engine change — pure cost, zero user-visible benefit while the
   UI is a webview. **Reject.**
3. **Hybrid** (Rust does dataset I/O, JS does matching). Marginal; adds an IPC boundary in the hot search
   path for no real win. **Reject.** Keep the engine wholly in the webview.

> If a future native-GUI direction is ever taken (Option B world), *then* revisit — but that's a different
> product. For the recommended Tauri path, the engine stays JS.

### 4.3 Serving the SPA + intercepting its `fetch` calls

The SPA calls `getJSON("/search?q=…")`, `getJSON("/home")`, `getJSON("/playlist?id=…")`, etc. In the
webview those are same-origin relative fetches. We satisfy them one of three ways:

- **Static engine routes** (`/home`, `/artists`, `/search`, `/artist`, `/album`, `/track`,
  `/zemer-playlists`, `/health`): already answered *inside the webview* by `engine.mjs:handle()` over the
  local dataset — no Rust involvement, no network. (The engine's Web Worker intercepts these before they
  become HTTP.)
- **Local static files** (`/data/artist/<id>.json`, `/data/home.json`, `/lib/*.mjs`, `dataset.json.gz`,
  icons): served by Tauri from the bundled/cached asset dir via the app's custom protocol.
- **Live routes that must hit the Worker** (`/playlist?id=`, `/zp-live?id=`, `/trending?days=`, `POST /a`
  analytics): the engine currently does `fetch(url)` to same-origin for these. Two clean options:
  - **(a) Rewrite base URL:** inject a tiny shim so these specific paths fetch
    `https://skmusic.shalomkarr.workers.dev/…` directly (CORS is fine — GETs; the analytics `POST /a`
    already returns 204). Simplest.
  - **(b) Rust proxy:** register a Tauri URI-scheme/`asset` protocol handler or a `tauri_plugin_http`
    command that proxies these to the Worker. Slightly more control (timeouts, offline queueing of
    analytics), but more code. Prefer (a) for MVP, add (b)'s analytics-queue in phase 3.

**Origin note (critical):** Tauri serves the app from a custom origin (`http://tauri.localhost` on Windows
via WebView2, `tauri://localhost` elsewhere). The YouTube IFrame API validates the `origin` playerVar/
referrer. This *should* work under the http-scheme custom protocol, **but it is the #1 thing to prove on
day 1** (see §6 risks). Fallbacks if the embed refuses under the custom origin: (i) load the *shell* from
the real `https://skmusic.shalomkarr.workers.dev` in the webview (thin-wrapper mode — still gets tray/media
keys/updater, loses offline), or (ii) host just the player iframe in a minimal page served from the real
https origin inside the same webview. Decide by testing, not by guessing.

### 4.4 Where filtering / parental-controls state lives (unchanged trust model)

This is non-negotiable and must not regress. The web app's model (see
[`filters-and-parental-controls.md`](filters-and-parental-controls.md)) is:

- **Content filters** (Kol Isha default-on, Chasid/DJ/Israeli/Acapella, Kid Zone) live in `localStorage`
  (`zw_noFemale`, `zw_chasid`, …) and are applied client-side by the engine + `gate()` in `ui.html`.
- **Sefira / Three Weeks forced-Acapella** is computed client-side (`mourningPeriod()` Hebrew-calendar) —
  works offline, no change.
- **Parental HARD LOCK** is *server-enforced* in Supabase: protected columns are un-writable except via
  bcrypt-gated `pc_*` SECURITY DEFINER RPCs, with server-side lockout. The client never sees the hash.
- The device-cached policy (`zw_policy`) survives sign-out so a kid can't escape by logging out.

**In the desktop app all of this is reused verbatim** — the webview has `localStorage` and runs the same
Supabase JS. The hard lock stays exactly as strong because it's enforced in Postgres, not on the client.

New surface to account for (and it's manageable):

- **Devtools / local-file tampering.** A technical kid could open devtools or edit the on-disk
  `localStorage`/settings to flip a *content-filter toggle*. This is **no weaker than the web app** — the
  same person could do the same in a browser. The thing that actually matters — the parental lock — is not
  client-enforced in either case, so it's equally safe. Still, ship the release build with **devtools
  disabled** (Tauri: don't enable the `devtools` feature in release) and don't expose a raw settings file
  the UI reads unsigned. Treat `zw_policy` exactly as the web app does: a *soft cache*, never the source of
  truth for the lock.
- **Do NOT** add any native "bypass filters" affordance, dev flag, or hidden route. The desktop app must be
  at least as locked-down as the web app, never a side door.
- **Media keys respect gates:** the Rust→webview media-key bridge just calls the existing `PB`/`next`/
  `prev` functions, which already run through `songOK()`/`gate()`/`hiddenArtist()`. Skips a
  filter-blocked track exactly like the in-app next button. No filtering logic moves to Rust.

Media-controls bridge (souvlaki) concretely:
1. On track change, `ui.html` already sets `mediaSession.metadata`. Add a one-liner that also
   `invoke("now_playing", {title, artist, artUrl, videoId})` to Rust.
2. Rust `souvlaki::MediaControls` publishes it to Windows SMTC (title/artist/art + play/pause/next/prev).
3. OS media-key / lock-screen events arrive in Rust → `app.emit("media_key", "next")` → a webview listener
   calls the existing `next()`/`PB.play()`/`PB.pause()`. Filtering stays in the webview.

### 4.5 Fetching + updating the baked dataset (offline caching)

The dataset (`dataset.json.gz` ~4.3 MB, plus `home.json`, `artists.json`, per-entity `/data/artist/*.json`,
`/data/album/*.json`, `synonyms.json`) is regenerated on every deploy and cache-busted by `BUILD`.

Strategy:

- **Bundle a snapshot at build time** so a fresh install works fully offline immediately (browse/search).
  Bundle the shell (`index.html`+`lib/*.mjs`), `dataset.json.gz`, `home*.json`, `artists.json`, `meta.json`,
  `synonyms.json`, and the curated `zemer-playlists`. Skip the huge `og.json` (4.4 MB, server-only for link
  previews — the client never reads it). Per-entity `/data/artist|album/*.json` are thousands of small
  files; either bundle them (simplest, a few MB) or lazily fetch+cache on first open (smaller install). MVP:
  bundle everything the SW precaches today + lazily cache the per-entity JSON.
- **Refresh in the background.** On launch (and on a timer), Rust checks the deployed `meta.json`'s
  `builtAt`/`BUILD` against the local copy; if newer, download the new `dataset.json.gz` + feeds into the
  app-data cache dir (`%APPDATA%/SK Music/data/`) and atomically swap. The webview then loads the cached
  copy. This mirrors the SW's "network-first for data, cache fallback" behavior but persistently on disk.
- **Offline reality:** with the bundled/cached dataset, **search + browse are fully offline.** *Playback is
  not* — the IFrame needs YouTube (Option A). True offline audio requires Option B (rejected for v1). Be
  explicit about this in the UI ("You're offline — you can browse, but playback needs a connection").
- **Filtered-network reality:** the dataset and updates are fetched from `skmusic.shalomkarr.workers.dev`,
  the **same origin the family already whitelists** for the web app. Do not introduce a new CDN/host that
  a filter would have to separately approve — reuse the Worker origin for dataset, updates, and live routes.

### 4.6 Deep links

Register `skmusic://` (and optionally intercept `https://skmusic.shalomkarr.workers.dev/song/*` via the OS)
so the existing `/song/:id`, `/artists/:id`, `/albums/:id`, `/zemer-playlists/:id` scheme opens the app and
routes in the SPA (which already does `pushURL("/song/"+videoId)`). This lets the **existing redirector
userscript** (`redirector/youtube-to-skmusic.user.js`, which today rewrites YouTube links to SK Music web)
optionally target the app instead of the browser — killing browser/filter friction end-to-end. `tauri-
plugin-deep-link` + `tauri-plugin-single-instance` (so a link focuses the running window, not a 2nd copy).

---

## 5. Distribution

### 5.1 Bundles per OS (Tauri bundler)

| OS | Format | Webview | Notes |
|---|---|---|---|
| **Windows** (primary) | NSIS `.exe` (preferred) or MSI (WiX) | WebView2 (Evergreen) | Win11 has WebView2 preinstalled; for Win10 use the bundler's `webviewInstallMode` (`embedBootstrapper` or `offlineInstaller`) so install never *needs* a live download on a filtered net |
| macOS | `.dmg` / `.app` (universal `aarch64`+`x86_64`) | WKWebView (system) | Requires notarization (below) |
| Linux | AppImage + `.deb` | WebKitGTK 4.1 | AppImage is the "just works" path; distro `.deb` for the tidy |

Install size target: **~15–25 MB** installer (Rust core + shell + bundled dataset), no Chromium.

### 5.2 Code signing (do not skip — this is the difference between "trusted" and "SmartScreen scared my
users off")

- **Windows:** sign with an **OV or, ideally, EV** Authenticode cert. Plain OV certs still trigger
  SmartScreen "unknown publisher" until reputation accrues; **EV certs bypass the SmartScreen warmup**,
  which for a non-technical, filter-wary audience is worth the extra cost. Sign both the installer and the
  `.exe`. (Azure Trusted Signing / a cloud HSM cert is the modern path; Tauri supports a signing hook.)
- **macOS:** Apple Developer ID ($99/yr) + `codesign` + **notarization** (`notarytool`) + staple, or the
  first launch is blocked by Gatekeeper.
- **Linux:** no signing infra; publish SHA256SUMS and (optionally) a GPG signature.

### 5.3 Auto-update

- `tauri-plugin-updater`: a static `latest.json` manifest + per-platform signed artifacts. Updates are
  **minisign-signed** (Tauri's updater keypair) independent of code signing, so a tampered update is
  rejected even if the transport is compromised.
- **Host the manifest + artifacts on the Worker/`skmusic` origin (or R2 behind it)** — same whitelisted
  host as everything else, so updates aren't separately blocked by a content filter.
- Update UX for this audience: check on launch, download in the background, apply on next start, and make it
  **silent/automatic by default** (with a visible version + "check now"). A family that won't manually
  update is a family stuck on a broken YouTube-embed build the day YouTube changes something.

### 5.4 Windows + filtered-network reality (call it out)

- Reuse the **already-whitelisted** `skmusic.shalomkarr.workers.dev` for dataset, updates, and live routes.
  Anything on a new host = a new thing the filter admin must approve = friction/failures.
- Ship an **offline-capable installer** (WebView2 offline bootstrapper embedded) so the very first install
  doesn't depend on a live Microsoft download that a filter might block.
- Because playback = YouTube embed, the machine must allow `www.youtube.com` embeds. Most filters that
  allow the web app already allow this (it's the same request). The existing `assets/connectivity.html`
  self-test and `playback-block-test.html` should be reused/ported as an in-app "Connection check" so a
  parent can diagnose "why won't it play?" without support.

---

## 6. Effort estimate & roadmap

Rough calendar estimates for one experienced dev; front-loaded risk in Phase 0.

| Phase | Scope | Effort | Output |
|---|---|---|---|
| **0 — De-risk (do first)** | Bare Tauri 2 app; load `ui.html` in the webview; **prove the YouTube IFrame plays under the Tauri custom origin** on Windows/WebView2. If it fails, prove the https-shell fallback (§4.3). | **2–4 days** | Go/No-go on the whole plan's happy path |
| **1 — MVP** | Bundle shell+engine+dataset; local static serving + `fetch` shim to the Worker for live routes; tray (minimize/close-to-tray, quit); window-state; single-instance; basic packaging (unsigned) | **1–1.5 wk** | An installable app that browses, searches, and plays exactly like the web app, and keeps playing in the tray |
| **2 — Native niceties** | `souvlaki` SMTC bridge (media keys + now-playing tile + artwork); `global-shortcut` fallback; deep-link `skmusic://` + single-instance focus; launch-on-login toggle; in-app connection check | **1–1.5 wk** | Feels like a real desktop music app |
| **3 — Dataset lifecycle + offline polish** | Background dataset refresh vs `meta.json`; app-data cache + atomic swap; lazy per-entity JSON caching; offline banner; optional analytics offline-queue (§4.3b) | **3–5 days** | Robust offline browse + always-fresh catalog |
| **4 — Distribution hardening** | Code signing (Win EV + Mac notarization); `tauri-plugin-updater` + signed manifest on the Worker origin; NSIS/DMG/AppImage polish; auto-update UX | **1–2 wk** (a lot is cert procurement + CI, not code) | Signed, auto-updating releases on 3 OSes |
| **5 (optional, later)** | Mac/Linux QA pass; optional experimental Option-B offline mode behind a flag (yt-dlp sidecar) — *only if demanded* | open-ended | — |

**MVP (Phases 0–1): ~2–3 weeks.** **Production-signed, auto-updating, media-key-integrated (Phases 0–4):
~6–8 weeks**, of which a big chunk is non-code (EV cert issuance, Apple notarization setup, CI signing).

### Hardest / riskiest parts (in priority order)

1. **YouTube IFrame under the Tauri custom origin.** The one thing that can invalidate Option A on desktop.
   Test in Phase 0, on real WebView2, before building anything else. Mitigation: https-shell or https
   player-iframe fallback (§4.3).
2. **Background playback survival.** WebView2/Chromium throttle hidden/occluded documents (background timers
   → the progress bar and `playFinalize()` listen-time accounting can stall; audio itself usually keeps
   playing). Keep the window "shown but hidden to tray" rather than truly minimized/occluded, or drive the
   progress tick from Rust. Verify listen-time analytics (`play` event on end) still fires when tray-hidden.
3. **Media-key / SMTC wiring** across the Rust↔webview boundary (souvlaki). Fiddly but well-trodden.
4. **Code signing & SmartScreen** (Windows) and **notarization** (Mac) — mostly procurement/CI friction, but
   real calendar time and the difference between adoption and abandonment for this audience.
5. **Auto-updating reliably on filtered networks** — same-origin hosting is the mitigation; test behind an
   actual Techloq-style filter if possible.
6. (If Option B is ever pursued) **extraction fragility** — deliberately deferred out of v1.

---

## 7. Recommendation & MVP scope

**Build a Tauri 2 desktop shell that reuses the existing `assets/ui.html` SPA and `engine/*.mjs` search
engine almost verbatim, and plays audio through the same YouTube IFrame player the web app uses.** Add a
thin Rust layer for the things a browser can't do: system tray + close-to-tray background play, OS media
keys / now-playing (via `souvlaki` → Windows SMTC), `skmusic://` deep links, on-disk dataset caching with
background refresh, and a signed auto-updater. **Do not** port the engine to Rust and **do not** do native
stream extraction for v1 — extraction is fragile, more filter-hostile, and ToS-fraught, and it throws away
the exact property the web app was designed around. The parental-controls trust model is untouched: the
hard lock stays server-enforced in Supabase, content filters stay in the webview's `localStorage`, and the
release build ships with devtools off and no bypass affordance.

**Crisp MVP (ship this first):**

1. Tauri 2 window hosting the bundled `ui.html` + engine + a bundled `dataset.json.gz` snapshot.
2. **Phase 0 gate:** YouTube IFrame confirmed playing under the app origin on WebView2 (or the https-shell
   fallback wired).
3. Live routes (`/playlist`, `/zp-live`, `/trending`, `POST /a`) and Supabase reused over the network via a
   base-URL `fetch` shim to `skmusic.shalomkarr.workers.dev`.
4. System tray: minimize/close-to-tray, keep playing, quit; single-instance; remembered window state.
5. Search, browse, home feeds, artist/album/playlist pages, filters, Kid Zone, Sefira forced-Acapella, and
   accounts/parental controls — **all working because they're the unchanged SPA.**

That MVP is ~2–3 weeks and delivers the core "native background-playing SK Music" experience. Media keys,
deep links, dataset auto-refresh, and signed auto-update follow in Phases 2–4 to make it a polished,
distributable product. The result reuses essentially all of the existing, filter-hardened, kosher-by-
construction codebase and adds only the native shell the audience actually benefits from.
