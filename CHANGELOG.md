# Changelog

## 1.2.0 — 2026-07-30 (web only — no desktop rebuild)

**Why the bump:** a new listening surface. Zemer Radio — live, synchronized broadcast stations —
lands on Home. The desktop app picks it up automatically (it loads the web UI), so no new installer.

**Zemer Radio (new)**
- **Three live stations on Home** — Chassidish, Israeli, and DJ / Remix, from the upstream
  `zemer-search` stations service. These are a **broadcast**, not a playlist: one shared wall-clock
  program per station, so everyone tuned in hears the same song at the same moment. Tuning in seeks
  to wherever the broadcast currently is rather than starting the track over.
- Clock skew is measured on every schedule read (round-trip midpoint) so the seek lands in the right
  place even if the device clock is off. The local schedule tops itself up as the queue drains.
- **Pausing leaves the broadcast; playing again rejoins it live** — a radio station doesn't wait for
  you. Short interruptions (a seek, a buffer stall) are not treated as a pause.
- A takedown can leave a gap in the shared program (the server reports a negative offset — the next
  track *starts in* N ms). We wait it out instead of starting early and drifting out of sync.
- Starting a normal radio station, or playing anything else, leaves the broadcast cleanly.

**Zemer Radio and your filters**
- **New setting: Zemer Radio (on by default)** — one switch in Settings turns the whole row off. It
  isn't a content filter, so it needs no account.
- When it's on, **your content filters still choose which stations appear.** Hide Chasidish and the
  Chassidish station is gone; Only Chasidish and it's the only one left; the same for Israeli, and
  Hide DJ sets removes DJ / Remix.
- **Hidden entirely in Kid Zone** — the upstream station pools are not Kid-Zone filtered.
- **Hidden entirely in Acapella-only mode** (Sefira / the Three Weeks) — a station carries no
  acapella at all, so showing one would pipe instrumental music into an acapella-only session.
- Individual tracks are still re-checked against your own blocklist when you tune in.

**Worker**
- New same-origin proxy routes `/stations`, `/station` and `/stations/cover`, so the stations work
  behind a content filter. Each rebuilds the upstream query from a validated allowlist rather than
  forwarding the query string, matching the existing `/radio` hardening. `/station` is never cached
  (it carries the live playback offset); the card list gets 15s and the generated cover art 24h.

## 1.1.3 — 2026-07-28 (desktop only — no web change)

**Why the bump:** "Check for updates" could open the dialog and never tell you the answer. Reported
from the field on 1.1.2.

**Desktop — the update dialog always gives you a verdict**
- The dialog used to be at the mercy of timing. `open_update_window` returns as soon as the window is
  *created*, and the check starts in the same breath — so a check that resolved before `update.html`
  attached its listeners broadcast to nobody, leaving the dialog spinning "Checking for updates…"
  forever. Every phase is now recorded, and the dialog asks for the last one on load
  (`updater_last_status`), so it paints a result regardless of who won the race. A live event always
  beats the snapshot, so a stale status can never overwrite fresher news.
- **Clicking during the startup check no longer does nothing.** The 8-seconds-after-launch check held
  a "already running" guard that made a user-initiated click return *silently* — dialog open, no
  events, no verdict. It now re-announces the checking phase, and the in-flight check's own result
  still lands on the dialog.
- **A failed background check now reports.** `updater://error` was only emitted for user-initiated
  checks, so a silent failure left the next dialog sitting on a stale phase. It's emitted either way
  now; the `userInitiated` flag in the payload still decides whether the SPA surfaces it.

## 1.1.2 — 2026-07-28 (web + desktop)

Playlist polish, clearer download status, and two desktop fixes: off-site links were dead in the app
window, and the update check was buried in the tray. The desktop build is bumped to **1.1.2** so the
installer, the About page and the announced version all read the same number — 1.1.2 was originally
cut as a web-only release, which is why no `desktop-v1.1.2` existed on GitHub.

**Desktop — links open in your browser**
- **Every off-site link now works.** GitHub, jtechforums, the GPL text, the Tampermonkey links on the
  add-on page — inside the app window these previously did nothing at all (a native window has no
  tabs for `target="_blank"`, and a same-window jump would have replaced SK Music itself). They now
  open in your default browser. SK Music's own pages still open in the app, and the Google sign-in
  redirect deliberately stays in the app window — it has to come back with your session.

**Desktop — updates on the About page**
- **"Check for updates" now lives on About**, with the installed version next to it, instead of only
  in the tray menu. It opens the same update dialog. (The tray item is still there.)

**Playlists**
- **Share a playlist** — a Share button on your playlist page toggles it **public/private** and, when
  public, gives you **Copy link** / **Send link**. Public playlists open read-only at `/p/<id>` for
  anyone with the link (no account needed), still filtered by the viewer's own content settings.
- **No accidental duplicates** — adding a song that's already in a playlist is a no-op, and the
  Add-to-playlist menu now **greys out** the playlists it's already in (shows "✓ Added").
- **In-app modal** — creating, renaming, and deleting a playlist (and reporting a song) now use a
  styled in-app dialog instead of the browser's `prompt()`/`confirm()`.

**Downloads (desktop)**
- The Now Playing download button now clearly shows **downloading / done / failed** state (failed turns
  red — click to retry), and a failed download surfaces the actual reason in the toast.

**Deploy note:** run `supabase/v1.1.2-playlists.sql` (after `v1.1.0-features.sql`) — it adds the
`is_public` column and the sharing / "already added" RPCs. Sharing and grey-out stay inert until then.

## 1.1.1 — 2026-07-28 (desktop + web)

Follow-up fixes on top of 1.1.0.

**Desktop — mini player**
- The mini player is now **display-aware**. On a **single monitor** it still pops up when the main
  window loses focus (you switched to another app that covers it) — the classic behavior. On a
  **multi-monitor** setup it no longer pops on focus loss (the main window is usually still visible on
  another screen); there it surfaces only when you **minimize**. This fixes two multi-monitor annoyances:
  **dragging** the window briefly flickered the mini, and **clicking another screen** popped it even
  though the main window was fully visible. Minimize/restore is detected authoritatively (via the resize
  event, since minimizing can report focus-loss before the minimized flag flips), and close-to-tray
  still surfaces the mini explicitly. Monitor count is checked live, so plugging/unplugging a display
  is picked up immediately.

**Desktop / web — tray radio**
- The tray's radio item now reads **"Start radio"** when nothing is playing (and **"Start radio from
  this song"** once a track is active). Clicking it with nothing playing now starts a generic mix
  instead of doing nothing. (Label updates live from the now-playing state.)

## 1.1.0 — 2026-07-28 (web + desktop)

**Why the bump:** the first big *feature* release since 1.0 — playback UX, a real
library/sharing layer, discovery, and desktop offline downloads. Everything is additive and
gated so nothing changes for users who don't opt in.

**Playback UX**
- **Shuffle mode** — a persistent toggle in Now Playing. Shuffles the not-yet-played tail in
  place, so the gapless/next path keeps working unchanged.
- **Sleep timer** — pause after 15/30/45/60 min, or at the end of the current song. 🌙
- **Queue editor** — the Up Next list is now drag-to-reorder, with per-row *Play next* and
  *Remove*.
- **Crossfade** — optional 3/6/9/12-second fade between songs, extending the dual-player
  engine. Off by default; the tuned gapless handoff is untouched when it's off. Manual
  transport aborts a fade; pause finishes it and pauses the new track.
- **Time-synced lyrics** — a Lyrics tab in Now Playing (LRCLIB via the Worker's `/lyrics`),
  with the active line highlighted and tap-to-seek; falls back to plain lyrics or a tidy
  "no lyrics found."

**Library & sharing**
- **User playlists** — create/rename/delete, add songs, server-backed via Supabase so they
  sync across devices (RPCs in `supabase/v1.1.0-features.sql`).
- **Follow an artist** — a Follow button on artist pages; followed artists' newest releases
  surface in a "New from artists you follow" shelf on For You.
- **Share a song** — share sheet (native share or copy link) from the song menu and Now Playing.
- **Offline downloads (desktop app)** — save a song's audio for offline playback. A hidden
  youtube.com webview has YouTube's own player mint the signed audio-only stream URL (no
  yt-dlp, no signature forging), Rust downloads it in ranged chunks, and a `skdl://` scheme
  serves it to the html5 `<audio>` element. New Downloads library + a download button in Now
  Playing. Entirely `SK_NATIVE`-gated — invisible on the web.

**Content ops**
- **Report a problem** — flag any song from the song menu; reports land in a Supabase review queue.
- **Tagging progress** — a "Help improve the catalog" card in the Library shows Israeli/Chasidish
  tag coverage, with contributor links for signed-in users.

**Discovery**
- **Search history & saved searches** — recent searches and starrable saved searches on the
  search landing.
- **Per-song radio + "Fans also like"** — start a radio station from any song's menu; artist
  pages gain a similar-artists shelf.
- **Better For You** — "Artists you've been playing" (recently-played) and "New from artists
  you follow" shelves.

**Login merge**
- Likes and history now **merge** (union) with the account on sign-in instead of overwriting —
  DB entries are never clobbered (idempotent `set_like`).

**Deploy notes (for the maintainer)**
- Run `supabase/v1.1.0-features.sql` in the Supabase dashboard (4 tables + 12 RPCs; idempotent).
- Redeploy the web app so the CSP `media-src` change (adds `skdl:`) ships — the desktop app
  needs it to play downloaded files.

## desktop-v1.0.2 — 2026-07-28

**Why the bump:** a security + reliability hardening pass — three parallel audit agents (web player,
desktop shell, Worker) plus a login-merge audit, with every actionable finding fixed. No new
features; the app gets safer and more robust.

**Content-filter correctness (kosher-critical):**
- The empty-queue resume path now re-gates the saved track before replaying (a filter could have
  changed since it was saved).
- Changing a filter now re-gates the **live** play queue — blocked tracks can't keep auto-advancing.
- Upstream-fed rails (trending / new releases / Zemer home-rows / cold-start) fail **closed** on an
  unresolved artist (`gateFeed`): `hiddenArtist` fails open on names that don't match our catalog, so
  an unmatched female/blocked artist could have slipped in. Verified it drops only truly-unknown
  artists — the real trending content is untouched.
- Radio continuation pages carry the current filter fingerprint (a mid-station filter change no
  longer serves under the old filter).

**Playback robustness:**
- Gapless handoff **watchdog** — a swap whose PLAYING confirmation never arrives no longer silently
  wedges playback at a track boundary.
- Pausing in the final half-second no longer lets the fire window un-pause the song.
- Seeks **verify-retry** (YouTube's iframe silently swallows `seekTo` while buffering); a skip that
  lands paused is nudged back into playback.
- Listen-time is banked (not destroyed) when the window is backgrounded — the always-open desktop
  app no longer under-counts plays.
- The queue registry is now LRU-capped (was an unbounded memory leak over a long session).

**Security hardening:**
- Every upstream id is validated (`safeId`) and thumbnail URL escaped before it reaches an inline
  handler — closes a stored-XSS surface from a poisoned upstream.
- Desktop: the tray-menu popup no longer holds its mutex across the blocking modal loop (a
  self-deadlock the tray left-click could trigger); `update.html` renders update fields via
  `textContent` with a CSP (a forged `updater://` event can't inject markup); the remote-origin
  capability grant is trimmed to event emit/listen only.
- Worker: `/radio` and `/playlist` are GET-only with validated/bounded params; the analytics beacon
  caps `meta` size; the service worker no longer activates an empty cache on a failed install.

**Desktop reliability:**
- Mini player recovers if a monitor change stranded it off-screen; taskbar jump-list actions work on
  a **cold** start (not just when the app is already running); the updater has a 30 s timeout and a
  drop-guard so a stalled check can't wedge "Check for updates" shut; a staged update isn't
  re-downloaded daily; tray lock poisoning self-heals instead of freezing the tray permanently.

**Account merge (idempotent):**
- Signed-out likes and listening history **merge** into the account on login as a true union — DB
  entries are never overwritten or deleted, local-only entries are added, and the local store becomes
  the union. Likes now use an idempotent `set_like(videoId, liked)` RPC (deploy
  `supabase/set-like-idempotent.sql`) instead of a non-idempotent flip, so re-logins and multiple
  devices can't double-flip or lose a like. A "Merged N liked songs" toast confirms the merge.
- Mini player: repeat-one button, keyboard control while focused, click-to-seek; the collapsed
  tiny-box mode was removed. Tray left-click surfaces the mini and pops the full menu.


Version numbers track the **desktop app** (`Desktop/src-tauri`); the web app deploys continuously
from `main`, so web changes are listed under the desktop release they shipped alongside. Desktop
releases live at `desktop-v<version>` tags with signed installers; installed apps self-update from
them via the `/updates` route.

## desktop-v1.0.1 — 2026-07-28

**Why the bump:** first post-1.0 patch — two playback reliability fixes reported within hours of
1.0.0, plus a tray interaction change.

- Tray **left-click** now surfaces the mini player *and* pops the full menu (double-click opens the
  main app). Menu popups anchor on a visible window so a tray-hidden main window can't auto-dismiss
  them.
- Web: seeks are **verify-retried** — the YouTube iframe occasionally swallows a `seekTo`
  (confirmed live: an identical seek landed once and was silently ignored seconds later), so the
  handler confirms the position moved and re-issues up to twice.
- Web: a skip that lands **paused** (YouTube's `loadVideoById` sometimes settles cued instead of
  autoplaying) is nudged back into playback ~2 s later; intentional pauses cancel the nudge.

## desktop-v1.0.0 — 2026-07-28

**Why the bump:** the mini player and the platform around it reached "deserves a version number"
quality — everything below (0.2.x) was the run-up. 1.0.0 itself simplified the mini player: the
collapsed tiny-box mode was **removed** (it bred its own bug class), the progress bar became
**click-to-seek** (slim visual, 14 px hit target), and the mini is fully **keyboard-drivable**
(Space/K play-pause, ←→ or N/P skip, L like, O/Enter open app, Esc close).

- Web (same push): the About page gained a real feature list.

## desktop-v0.2.3 — 2026-07-28

**Why the bump:** the release that made the desktop app actually *work* — the metadata bridge had
been silently dead in every release build since 0.1.x.

- **Release-mode bridge fix:** remote origins (the deployed SPA the window loads) cannot invoke
  Tauri app commands — the ACL denies them silently, and dev builds masked it because `devUrl` made
  the site the app's own origin. The webview now reports playback via **events**
  (`sk-np-report`/`sk-state-report`/`sk-menu`), which the remote grant does allow; Rust listens and
  routes into the same handlers. This is why the tray/mini said "Not playing" during playback.
- **Taskbar jump list** (Windows): Play/Pause, Next, Previous, Like, Start radio, Mini player,
  Check for updates — tasks relaunch the exe with `--control=<action>`, forwarded by
  single-instance to the running app.
- Close-to-tray explicitly auto-shows the mini (hiding a window emits no focus event).
- Tiny-box play/expand buttons fixed (an `::after` overlay swallowed their clicks).
- **Crisp icons**: the full icon set regenerated from the vector logo at 1024 px; the tray
  Lanczos-downscales its own 32 px icon instead of letting Windows crush the full-size one.
- Web (same day): empty-queue Play resumes the last listen (≤ 20 min) or starts the trending mix;
  right-click in the desktop app pops the tray menu.

## desktop-v0.2.2 — 2026-07-28

**Why the bump:** the mini player rework + the fix for it loading the wrong content entirely.

- **Mini player fixed and redesigned.** In 0.2.1 the mini window could load the *full web app*
  instead of `mini.html` (`devUrl` hijacked local-asset resolution; the asset protocol's
  `index.html` fallback then bootstrapped the remote site — also why it couldn't be dragged).
  `devUrl` removed; the bootstrap refuses to hand off any window that isn't `main`. New layout:
  art flush-left, one-line title + artist, like/transport/elapsed-of-total, drag anywhere,
  double-click opens the app.
- **Auto-show:** while music plays, unfocusing or minimizing the main window shows the mini
  (without stealing focus); focusing it again hides an auto-shown mini. Tray toggle, default on.
- Updater re-checks **daily**, not just at startup.
- Quit destroys all webviews before exiting so WebView2 releases its profile locks (the
  freeze-on-fast-relaunch fix).
- Web (same day): the desktop bridge contract (queue for Up Next, `like`/`radio`/`playindex`/
  `resumecheck` actions with post-sleep self-heal).

## desktop-v0.2.1 — 2026-07-28

**Why the bump:** "Check for updates" got a face — a status dialog showing the installed version
and narrating the check live (spinner, up-to-date, downloading with progress + release notes,
restart-to-update button) instead of a silent background check.

## desktop-v0.2.0 — 2026-07-28

**Why the bump:** the desktop app went from "shell" to "desktop citizen" — seven features in one
agent-built batch: the first mini player, Start with Windows (launches hidden to tray), tray
Like/Start-radio items, a tray icon that shows playback state, the Up Next tray submenu, optional
track-change toasts, and sleep/resume self-heal (wall-clock vs monotonic drift detection →
`resumecheck` into the webview).

- Web (same day, the run-up): **gapless playback** (double-buffer prime, ~200 ms handoffs),
  **Zemer Radio** everywhere (song/artist/album/playlist stations, Radio mode, queue-end Autoplay
  with prefetch), **real release dates** from the upstream feed, For You cold start from the
  telemetry top-50, artist-page A–Z strip + downsized thumbnails, kind back-button behavior,
  youtube-nocookie embeds (clean console).

## desktop-v0.1.2 — 2026-07-13

Analytics-era maintenance release of the original shell (pre-dates this changelog's detail level).

## desktop-v0.1.1 — 2026-07-13

Early shell fixes (pre-dates this changelog's detail level).

## desktop-v0.1.0 — 2026-07-12

First desktop release: the Tauri 2 shell around the deployed web app — system tray with
close-to-tray background play, OS media keys / SMTC, `skmusic://` deep links, signed auto-updater.

## v1.0.0 (web) — 2026-07-09

The original web release: whitelisted catalog, client-side Hebrew-aware search, YouTube-iframe
playback, content filters + parental controls, Kid Zone, charts, PWA.
