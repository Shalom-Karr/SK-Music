# Changelog

## 1.4.0 — 2026-08-02 (web + desktop)

**Why the bump:** two new listening surfaces, a filter leak closed, and four bugs found in the podcasts
code that shipped earlier the same day.

**Fixed — Zemer Radio was leaking past a content filter**
- Upstream added genre-pooled stations (**Nigunim**, **Chill**) alongside the artist-flag ones. The gate
  treated any unrecognised station as making "no style claim" and **showed it** — so a user with **Hide
  Chasidish** was being offered Nigunim Radio, which is the chasidish pool by definition. Unrecognised
  stations are now **hidden**, matching the fail-closed rule used everywhere else. Chill is explicitly
  classified as making no style claim, which is a different thing from unknown. The Parental Controls
  picker now derives from the same map, so the two lists can't drift apart again.

**Fixed — podcasts (four real bugs)**
- **A shiur would roll into music.** A one-episode queue looked like "last track" to the radio prefetch,
  which fetched a station from the episode's id and appended songs.
- **The Podcasts tab went blank during Sefira and the Three Weeks** — the Acapella gate demanded playlist
  membership no spoken word has. Episodes now use their own filter.
- Every episode row read fields that don't exist, so subtitles, durations and resume bars never drew.
- Two colliding `shareSong` declarations meant the now-playing menu shared a bare `/song/` URL.

**Podcasts — podcasters, series, video policy**
- A **Podcasters** rail, **series** pages, and episode pages naming the podcaster with more from that
  show and host alongside. **Video shiurim** are a separate opt-in; audio-only episodes are unaffected.
- The show list is **baked at build time**, so the tab costs **one** Worker request. Upstream does not
  kol-isha-filter podcasts, so the client does it from the whitelist flags.

**Shiurim (new) — TorahAnytime**
- Browse by topic, speaker and series, search, newest and trending, with per-lecture resume. **Off by
  default**, enabled by a parent, then switchable per account.
- **Costs zero Worker requests** — the browser talks to TorahAnytime directly and streams from source;
  the catalog is baked into the build. Kol isha is enforced per record, and a lecture or speaker marked
  no-download is never offered a save.

**Statuses — it moves like a story now**
- Sliding transitions between posts, a cube turn between creators, continuous progress bars, and
  open/close anchored to the circle you tapped. All of it respects reduced-motion. Two rows past 20.

**Downloads (desktop)**
- A **progress dialog** that stays until the download finishes, then offers **Show in folder**. Failures
  show the reason with a Retry, and a stalled download becomes a retryable error rather than a hang.
- The web side never sends a file path to the app — it sends the song id and the app resolves the path.

**For You is gone.** Its personalised sections were a second home page; `/foryou` redirects to Home.

**Known gaps, stated rather than hidden**
- The podcast **video** setting has nothing to filter yet — upstream doesn't mark episodes as video.
- The Shiurim **build-time bake has not run end-to-end** (`build:code` skips the data step). It fails
  soft if TorahAnytime is unreachable.
- **Desktop-native paths are untested** for shiurim and for Show-in-folder.
- `playIndex` still evicts **podcast episodes** during Sefira; `regateQueue` exempts them and it does not.

## 1.3.0 — 2026-08-02 (web only — no desktop rebuild)

**Why the bump:** two new content surfaces, both **off by default and unlocked by a parent**. Neither
appears for anyone who doesn't deliberately turn it on.

**Podcasts & Shiurim (new)**
- The Podcasts tab is real. New episodes from whitelisted shows, filtered by the same rules as the
  music — kol isha, Chasidish, Israeli and DJ settings all still apply.
- **Off until enabled.** `filters.podcasts` is opt-*in*: a new account, a signed-out device, or any
  account a parent hasn't configured gets nothing, and the tab is **absent from the sidebar** rather
  than shown-and-disabled. A parent enables it in Parental Controls (PIN-gated); the account then gets
  its own Settings switch. Turning it off while someone is on the tab returns them Home.
- **Episodes remember where you were.** A shiur is an hour, not four minutes, so there's a per-episode
  resume point with a Continue Listening section and progress bars. The first 30 seconds are ignored —
  that isn't a resume point.
- Playback is the existing engine, so background play, media keys, tray controls and the desktop mini
  player all work with episodes unchanged.

**Statuses (new)**
- A row of story circles on Home under Quick Picks, with a full-screen viewer: auto-advance, tap or
  arrow navigation, press-and-hold to pause, resume at the first unseen, and seen-state that persists.
- Music pauses when the viewer opens and resumes on close — and only if something was actually playing.
- **Same gating as podcasts**: off until a parent enables it, then an account-level switch. Hidden
  entirely in Kid Zone.

**Worker**
- New same-origin proxies: `/podcasts/new-episodes`, `/podcast`, `/podcast-channel`,
  `/podcasts-whitelist` (+ `/version`), and `/statuses/creators`, `/statuses/posts`, `/statuses/media`.
  All rebuild the upstream query from a validated allowlist rather than forwarding the query string,
  matching the existing `/radio` hardening. Credentials stay server-side — nothing reaches the client.
- `content.zemer.io` is a new upstream host, used only for the podcast whitelist mirror.

**Known limits, stated rather than hidden**
- The `blockVideos()` gate is wired for statuses but currently unreachable — that filter is hardcoded
  off in the UI today, so it protects nothing until it's restored.
- Statuses hasn't been exercised on real touch hardware or iOS Safari; the tap zones and the muted
  autoplay fallback were verified with synthetic events only.

## 1.2.7 — 2026-07-30 (web only — no desktop rebuild)

**Playlist cover art**
- **Pick a cover for any playlist** — a Cover button on the playlist page opens a grid of that
  playlist's own songs; tap one to make its artwork the cover, or reset to the first song.
- Playlists in your Library and the playlist page itself now show real artwork instead of a generic
  glyph. **No one has to choose one** — with no explicit pick, the first track's art stands in.
- A cover is one of the playlist's own songs rather than an upload: no storage, no arbitrary URLs and
  nothing to moderate. The server re-checks membership, so a cover can't be set to a song that isn't
  in the playlist.

**Playlist rename**
- **Renaming works.** The rename always reached the database — but the Library list is cached and was
  never invalidated, so the old name kept rendering exactly where you'd look to check. Deleting
  already refreshed that list; renaming didn't.
- Underneath it, a broader fix: every `returns void` RPC (rename, delete, add, remove, reorder)
  replies `204` with an empty body, and the client's JSON parse threw on that — so **success was being
  reported as failure** for all of them. Nothing checked the result, which is the only reason it went
  unnoticed. Rename now surfaces a real error instead of silently doing nothing.

**Deploy note:** run `supabase/v1.2.7-playlist-cover.sql`. Covers stay hidden until it's applied —
`get_my_playlists()` gains two columns and the client tolerates their absence.

## 1.2.6 — 2026-07-30 (web only — no desktop rebuild)

**Why the bump:** Zemer Radio shipped with the ordinary transport attached, which quietly offered
controls a broadcast can't honour.

**Zemer Radio — it now looks and behaves like live radio**
- **Stations have their own page at `/radio/:id`.** Tuning in used to drop you on the song page for
  whatever happened to be playing — but the song isn't what you picked, the station is. The page shows
  the station, what's on air, and what's coming, and the link is shareable.
- **A LIVE pill in the player** whenever you're tuned in.
- **The controls that can't work are gone rather than inert.** Seeking a shared broadcast would have
  silently desynced you from everyone else; scrubbing, ±15s, shuffle, repeat and queue reordering are
  hidden while a station plays, and every seek path — buttons, arrow keys, media keys, the tray —
  routes through one check that refuses with an explanation.
- The Up Next list on a station page is deliberately **not** clickable: you can't jump to a track
  inside a shared program, so offering it would be a lie.
- A line under the player explains that pausing leaves the broadcast and playing rejoins it live.

**Offline downloads — a stall now ends**
- A download that never reported back sat on "Preparing…" forever, because that state was only ever
  cleared by an event arriving. The same shape as the update-dialog bug. A download with no progress
  for three minutes now becomes a normal, retryable failure.

**Admin console**
- **Paging and sorting.** The list fetched 200 rows and said "200 of N" with no way to reach the rest —
  a limit that degrades quietly. Now 100 per page with prev/next and sortable name, email, created,
  last sign-in and PIN-failure columns.
- **The user modal is tabbed** — Settings / Activity / Playlists / Library — behind an identity header
  with an avatar and status chips, instead of one long scroll. Save and Clear PIN appear only on the
  tab they apply to.

## 1.2.5 — 2026-07-30 (web only — no desktop rebuild)

**Why the bump:** the admin console could show settings but not what a user actually has or does.

**Admin console**
- **Playlists** — every playlist the user has made, public/private, song count, last updated, and the
  full tracklist. These are owner-only under RLS; the admin RPC is what makes them visible.
- **Visits** — one entry per session: when it started, how long it ran, event and play counts, device,
  browser and location. `last sign-in` only tells you when a token was minted, which isn't the same as
  when someone was actually in the app.
- Both load independently of the settings panel, so a heavy account doesn't stall the modal.

**Limits, stated in the UI rather than left to look like a bug**
- Visits and play history only exist from 1.2.3 onward, and only while the person was **signed in**.
  Anonymous browsing by the same person can't be linked to the account — that's structural, not a gap
  to be filled later.

**Deploy note:** run `supabase/v1.2.5-admin-detail.sql`.

## 1.2.4 — 2026-07-30 (web only — no desktop rebuild)

**Why the bump:** a security review of the admin console found three single points of failure. None
was exploitable as configured — each was one setting away from silent full compromise.

- **Admin is now keyed on `auth.uid()`, not the JWT's `email` claim.** Email is the one identity
  attribute a user can ask the auth service to change. It wasn't forgeable only because "Confirm
  email" happens to be on — an unversioned dashboard setting nothing in the repo enforces. Turn it
  off to reduce signup friction and two requests would have granted admin.
- **Residual default table grants stripped.** `zemer_admin` and `zemer_user` had RLS enabled but their
  default privileges never revoked, so RLS default-deny was the *only* barrier. `anon` also held
  SELECT on `zemer_user` including `pin_hash` — every bcrypt PIN hash one RLS toggle away from a key
  that ships in the page source.
- `zemer_analytics` keeps **anon INSERT** deliberately: the beacon posts with the anon key. Everything
  else on that table is revoked.
- The migration **refuses to apply** if any `zemer_admin` row has no matching auth user, so a
  half-applied run can't lock every admin out.

**Deploy note:** run `supabase/v1.2.4-admin-hardening.sql`, then re-run `v1.2.2` and `v1.2.3`
(idempotent) to pick up the `search_path` alignment.

## 1.2.3 — 2026-07-30 (web only — no desktop rebuild)

**Why the bump:** analytics could not tell you *who* was listening — only that a tab was. Play events
now carry the signed-in account, which turns the admin console's listening view into a real history
and makes signed-in vs anonymous measurable.

**Analytics**
- **Play events are attributed to an account** when the listener is signed in. Signed-out events stay
  anonymous, and that absence is exactly what the new split measures.
- **New card at the top of the dashboard: signed in vs anonymous** — the share of *people* with an
  account, with the account/anonymous headcount and the share of events underneath. People and events
  are shown separately on purpose: accounts play far more per head, so the event split flatters them.
- **Every row in Recent events is marked `account` or `anon`** (hover an account chip for the id).
- **Admin console shows a real play history** — per song, with timestamps, for the last 90 days.

**Privacy / trust — worth being explicit about**
- The beacon is unauthenticated. The Worker takes the account id from the request body and does not
  verify it against a token (it holds only the anon key, and resolving a token per event would mean a
  round trip on every play). A hostile client can therefore post events tagged with someone else's id.
- That is acceptable **only** because this id is attribution and nothing else: it grants no access,
  gates no content, and is never read to make an authorization decision. It is exactly as trustworthy
  as the IP and user-agent already in the stream. It must not be extended into any access-control path.
- History only exists from this release forward. Older events were never attributed and can't be
  retroactively assigned; the console says so rather than showing a misleading empty list.

**Deploy note:** run `supabase/v1.2.3-analytics-identity.sql`. The Worker tolerates the gap — if the
column isn't there yet it retries the insert without it, so analytics keeps flowing either way.

## 1.2.2 — 2026-07-30 (web only — no desktop rebuild)

**Why the bump:** an admin console, so account problems can be fixed for a user instead of talked
through with them.

**Admin console (`/admin`)**
- A user table: name, email, filter summary, PIN state, Kid Zone, artist mode, PIN failures (with a
  lockout flag), created and last-sign-in dates. Search by name or email.
- Click a row for the full picture, with every content filter editable on the user's behalf —
  including the Zemer Radio policy, Kid Zone and artist mode. Edits stage and write on **Save**, so a
  mis-click isn't instantly live on someone's account.
- **Clear PIN** for a parent locked out of their own controls. An admin can clear a PIN but can never
  read or set one, so this can't be used to impersonate the parental gate.

**Sign-in**
- **Google sign-in on `/analytics` and `/admin`**, using the same Supabase project and provider as the
  app — admins use the account they already have. Password sign-in still works, and the session is
  shared between the two pages.
- Being in `zemer_admin` is what grants access. Signing in with Google grants nothing on its own.

**How it's actually secured** (the anon key is public, so the UI gates nothing)
- Every read and write goes through `admin_*` SECURITY DEFINER functions that re-check `zemer_admin`
  membership server-side on **every** call, with `execute` revoked from `anon` as a second layer.
- **`pin_hash` is never returned by any path** — admins see `has_pin` only.
- `admin_set_user` reads its patch key by key rather than merging, so a crafted key can't reach
  `pin_hash`, `id` or `email`.
- **Every admin write is logged** to a new `zemer_admin_audit` table with the acting admin and the
  before/after. One user editing another's parental controls without a trail shouldn't exist.

**Deploy note:** run `supabase/v1.2.2-admin.sql`, then add your email to `zemer_admin`.

## 1.2.1 — 2026-07-30 (web only — no desktop rebuild)

**Why the bump:** Zemer Radio shipped this morning with only an account-level on/off switch. A parent
needs to be able to make that decision for the account, and to make it stick.

**Parental Controls — Zemer Radio**
- A new **Zemer Radio** row in Parental Controls: **All**, a single named station (**Chassidish**,
  **Israeli**, **DJ**), or **Off**. Picking a station means that station is the *only* one the account
  ever sees; Off removes live radio entirely.
- **The policy outranks the account's own switch, and can only ever narrow.** Turning the personal
  switch on cannot re-enable radio a parent blocked; turning it off still works, because that's more
  restrictive, not less.
- With a PIN set, the Zemer Radio switch in Settings **locks and moves into "Locked by Parental
  Controls"**, like the other parent-set filters.
- **Changing the policy takes a station off air immediately** rather than at the end of the current
  track — if what's playing is no longer allowed, playback stops and the queue clears.
- The Parental Controls header shows the state at a glance (*Radio blocked* / *Radio · Chassidish*).
- Stored in the existing `filters` JSON alongside the Sefira rule, so it syncs across devices and
  survives sign-out with the rest of the cached policy. **No SQL migration.**

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
