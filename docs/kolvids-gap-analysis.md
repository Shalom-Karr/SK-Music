# KolVids gap analysis

**Date:** 2026-08-02
**Scope:** What KolVids has that SK Music does not — features and catalog coverage, podcasts first.

## How this was produced, and what "verified" means

KolVids is a whitelisted YouTube front-end (`kolvids.com`) plus a music sibling (`music.kolvids.com`),
built on Supabase + TanStack Start. Its Supabase REST endpoint is anon-readable cross-origin with the
`sb_publishable_*` key shipped in its client bundle — that key class is designed to be public, so
nothing here involved breaking a credential.

Two evidence classes are used throughout, and they are labelled inline:

- **Verified** — read directly from their REST API (row counts, column values, per-channel episode
  counts) or from a literal in their published JS bundle. Reproducible.
- **Inferred** — a reading of minified code, or a conclusion drawn from absence of evidence.

Where a number is a PostgreSQL *estimate* rather than an exact count, it is marked `~`. Exact counts
on their two largest tables (`videos`, `music_tracks`) return `statement timeout`, so those are
estimates; every other count in this document is exact.

SK Music's side is read from `data/corpus.db`, `dist/data/*.json`, `CHANGELOG.md`, and `assets/ui.html`.

### Scale, side by side

| | KolVids | SK Music |
|---|---|---|
| Artists | 1,522 | **1,625** |
| Tracks | ~38,475 | **71,720** |
| Albums | 12,146 | **13,923** |
| Podcast shows | 21 channels | **169 shows** |
| Podcast episodes | 7,960 | not counted locally (live from Zemer) |

Provenance for the SK Music column: artists from `dist/data/artists.json` (`count` field, 1,625);
tracks from the `dist/data/og.json` entry count (71,720 keyed video ids) — that file is the
OpenGraph metadata cache, one entry per known track, so it is a proxy for catalog size rather than a
first-class track table. The KolVids column comes from their public bundle and API; the `~` on 38,475
is theirs, not a rounding of ours.
| Videos | ~110,160 | — (audio product) |
| Shorts | 27,467 | — |
| Channels | 159 | — |

The headline that shapes this whole document: **SK Music's music catalog is already larger than
KolVids' on every axis.** The gaps that exist are in podcasts, in a handful of ranking/UX mechanics,
and in metadata structure — not in music coverage.

---

## 1. Podcasts — the priority section

### 1.1 The structural difference

KolVids has no podcast *product*. It has a `channels.category` value of `'podcast'` covering 21
YouTube channels, surfaced through the same video-browsing UI as everything else. Their `videos`
table has an `is_podcast` boolean column and **it is populated on exactly 0 rows** (verified) — so
"podcast" at KolVids means "this channel is tagged podcast," never "this item is an episode."

SK Music has the opposite shape: 169 curated shows from the Zemer whitelist, baked into
`dist/data/podcasts.json`, with an episode-level surface (resume, Continue listening, Your shows,
Because you listened) that is genuinely audio-first.

So the comparison is asymmetric. **SK Music is ahead on podcasts by roughly 8× on show count and by a
wide margin on listening mechanics.** What KolVids has is a set of *specific shows* SK Music doesn't
carry, and a *taxonomy* SK Music's podcast index lacks.

### 1.2 Shows KolVids carries that SK Music does not — the actionable list

All 21 of their podcast channels were matched against SK Music's 169 shows by name and by author.
Seven are already covered. **Fourteen are genuine gaps**, listed here by episode depth (episode
counts are exact, from a per-channel `count=exact` query):

| Episodes | Show | YouTube handle | Language |
|---:|---|---|---|
| 1,000 | Podsitivity Podcast | `@podsitivity` | English |
| 522 | The Perlowitz Show | `@perlowitz` | English |
| 353 | R' Shloime Ehrlich \| Eitza podcast | `@shloimeehrlich` | English |
| 330 | Chaim Ekstein \| Git Gelt Podcast | `@chaimekstein` | English |
| 182 | Jewish History Soundbites | `@jewishhistorysoundbites4799` | English |
| 167 | Clappy and Frank Show | `@clappyfrank` | English |
| 113 | Jewish and Joyful | `@jewishnjoyful` | English |
| 67 | Teef Teef | `@teefteefpod` | **Yiddish** |
| 67 | The Middle Class | `@themiddleclasspodcastshow` | English |
| 25 | Businessman | `@thebusinessmanpodcast` | **Yiddish** |
| 18 | Tachlis Daily Podcast | `@tachlisdaily` | English |
| 13 | The Farbrengen Podcast | `@farbrengen` | English |
| 3 | The Twelve Podcasts | `@thetwelvepodcasts` | English |
| 2 | Airplane Therapy | `@airplanetherapypod` | — |

**2,862 episodes across 14 shows.** Each of the 14 was checked by keyword against
`dist/data/podcasts.json`, `dist/data/shiurim.json`, `dist/data/artists.json` and `dist/data/home.json`
and is absent from all four.

Two near-miss traps worth recording so nobody re-litigates them later:

- `Perlowitz` *does* appear in `artists.json` — but that is **Levi Perlowitz**, a music artist
  (`UCA-4eYRJ9RSGKyNa7_APtrA`). It is not *The Perlowitz Show*. Still a gap.
- SK Music carries "Let's Talk Tachlis Podcast" and "Tachlis, What's My Avoda?" — neither is
  *Tachlis Daily Podcast*. Still a gap.

The seven already covered, for completeness: Meaningful People, ShmueliCast, Pushet Pshat, Coach
Menachem Bernfeld, Living Lchaim (SK carries five separate shows under that host), Torahvation with
Chaim Reidel, History For The Curious.

**Priority read:** the top four (Podsitivity, Perlowitz, Eitza, Git Gelt) are 2,205 of the 2,862
episodes. If only four get added, those are the four. The two Yiddish shows are disproportionately
valuable for a different reason — see 1.3.

### 1.3 Structural things their surface has that SK Music's podcast index lacks

**(a) Language tagging — the biggest real gap.** Every KolVids channel carries a `language` column
(verified distribution across all 159: english 131, yiddish 17, hebrew 2, null 9). Their category bar
exposes Yiddish / Hebrew / English as first-class browse chips.

SK Music's `dist/data/podcasts.json` carries five fields on every show — `id, name, author,
channelId, thumbnail` — plus two that are emitted **only when true**: `isVerified` (108 of 169) and
`isFemale` (7 of 169). There is **no language field at all**, so there is no way for a user to say
"Hebrew only" or "English only."

The emitted-only-when-true convention matters if you add `language` the same way: a filter reading
`s.language === 'english'` would silently exclude every show whose field was omitted. Any new field
used for gating needs an explicit default at read time, the way `podShowOK` treats absent `isFemale`
as not-female.

How many of the 169 are non-English is **unmeasured, and cannot be measured from what we currently
bake**: all 169 show names and authors are Latin script (verified — zero shows contain a codepoint in
the Hebrew block U+0590–U+05FF), and many are transliterations whose language the title does not
reveal. "Bitachon Daily" and "Chassidim and their Niggunim" are English titles; nothing in the baked
record says what language the audio is in. Sizing this gap requires pulling language metadata for the
169 channels first — that probe is the prerequisite for the recommendation, not an optional follow-up.

**(b) Category tagging.** Their channels carry a `category` (podcast / torah / business / news /
kids / travel / entertainment / music). SK Music's podcast index has no category field, so 169 shows
are browsed as one flat list. Their taxonomy is coarse but real; SK Music has none.

**(c) A chip bar that can swap the ranking recipe, not just filter.** Their category bar
(`main_hooks-CmSsj2ji.js`, verified literal) is 13 chips that mix three different mechanisms:

- category filters (`channelCategory: 'torah' | 'podcast' | …`)
- language filters (`channelLanguage: 'yiddish' | 'hebrew' | 'english'`)
- **a recipe override** — the "Recently uploaded" chip carries
  `weights:{freshness:200, popularity:0, quality:0, channelQuality:0, random:0}`

That third one is the idea worth stealing. One UI affordance where some chips narrow the set and
others re-rank it is a clean pattern, and SK Music's podcast tab has no equivalent.

**(d) Channel subscriptions with a ranking consequence.** They keep
`kolvids.channel.subscriptions` in localStorage, and their ranking recipes contain a
`source.followedChannels` weight (45 on the home recipe, verified). Followed channels are not just a
filter — they bias the feed.

SK Music has artist follows on the music side but **no podcast show follow** (searched `podSub`,
`followShow`, `zw_podfollow` in `assets/ui.html` — no hits). "Your shows" is derived from listening
history (`zw_podhist`), not from an explicit subscription. That is a reasonable design, but it means
a user cannot express interest in a show before listening to it.

**(e) Episode ordering.** Neither product offers a newest/oldest toggle. Their channel page has
Videos and Shorts tabs and a fixed newest-first infinite scroll. **Not a gap.**

### 1.4 Where SK Music is plainly ahead on podcasts

Stated plainly, because this document should not be one-sided:

- **169 shows vs 21 channels.** Nearly 8×.
- **Per-episode resume.** `zw_podhist` + `podPos`, first 30 seconds ignored as a resume point, resume
  bars on episode rows, a Continue listening shelf. KolVids stores `kolvids.video.progress` but has
  no equivalent audio-first browse surface built on it.
- **History re-gated on read, failing closed.** SK Music's `podHistory()` drops any stored episode
  whose show has left the whitelist or is hidden by current filters — a stale local row cannot reopen
  a door the whitelist has closed. KolVids has no filter model at all, so nothing to re-gate.
- **Kol isha per show.** `podShowOK()` blocks a whole show on `isFemale`. Verified that upstream does
  not apply this, so the gate is SK Music's own work. KolVids cannot do this at all (see §4).
- **Parental gating.** Podcasts are opt-in behind a PIN-gated parental switch plus an account-level
  toggle. KolVids has no parental layer.
- **Sleep timer, playback speed, background/lockscreen playback, desktop app** all apply to episodes
  unchanged. KolVids has none of these (verified: no `sleepTimer` or `playbackRate` hits anywhere in
  their bundle).
- **Slugged, readable show URLs** (`/podcasts/living-lchaim`), derived by SK Music since upstream keys
  hosts by opaque `UC…` ids.

---

## 2. Catalog coverage — music

This section is where the prior expectation was most wrong, so the method matters.

Their `music_artists.external_artist_id` is a YouTube channel id (`UC…`), and SK Music's `artist.id`
is the *same identifier space*. Likewise their `music_albums.external_album_id` is a YouTube Music
`MPREb_…` id, which is SK Music's `album.id`. So both comparisons below are **exact joins on a shared
primary key, not fuzzy name matching.**

### 2.1 Artists — the gap is 8 rows

| | Count |
|---|---|
| KolVids artists | 1,522 |
| Matched to SK Music by YouTube channel id | **1,513 (99.4%)** |
| Matched by normalised name only (different channel id) | 1 |
| **Not present in SK Music at all** | **8** |
| SK Music artists absent from KolVids | **109** |

**The eight, in full:**

| Artist | YouTube channel | Their `origin` | Their `is_famous` | Their `listen_count` |
|---|---|---|---|---|
| Alberto Mizrahi | `UC1K7S9wPAwyGIJMgobl5mDA` | american | false | 0 |
| Akay | `UC0WxjQv6RHvUlWQaWt3LmWg` | american | false | 0 |
| A.Y. Bouzaglou | `UC2X70zsZvgHVlFZNBetsxUg` | american | false | 0 |
| Gad Feureisen | `UCuhReTSELcS74ODuFqgKOJQ` | american | false | 0 |
| Michael Allen Productions | `UCH9UmYuJ8Knzt4-mDhOOP0A` | american | false | 0 |
| A.Y. Weiss | `UCvXlUUl5npWBxAA28fu1_nw` | american | false | 0 |
| Akiva Hai | `UC9bCvz39RYE0aC_kNIqMrFQ` | american | false | 0 |
| ZALMAN | `UChucagq8qeMtgii8WT-UAyQ` | american | false | 0 |

All eight are `origin: american`, `artist_type: solo`, `is_famous: false`, `is_kids: false`,
`listen_count: 0`, `quality_score: 0`. **None is a notable omission.** This is a "worth a look when
convenient" list, not a priority.

**Their flag distribution** (verified, all 1,522): `origin` — american 1,153 / israeli 367 /
chasidic 2. `artist_type` — solo 1,307 / group 199 / dj 16. `is_famous` — 147 true. `is_kids` —
42 true. `approval_status` — 1,522 approved (no pending/rejected rows are visible anonymously).

**In the other direction, SK Music has 109 artists KolVids does not — and 73 of them are female-voice
artists.** That is not a coverage win KolVids could replicate; it is a direct consequence of their
import policy (§4). The largest SK-only artists by track count: יוסף משה כהנא (957), Yosef Moshe
Kahana (512), רוני מלר (280), ליאור אלמליח (267), Aharon Segal (192), Franciska (179), Oorah (177).

### 2.2 Albums — a depth gap on artists already carried, not a curation gap

| | Count |
|---|---|
| KolVids albums | 12,146 (album 6,723 / single 5,423) |
| Matched to SK Music by `MPREb_…` id | **10,991 (90.5%)** |
| Not in SK Music | **1,155** (singles 1,030 / albums 125) |
| …of which belong to an artist SK Music **already has** | **1,131 (97.9%)** |
| SK Music albums absent from KolVids | **2,932** |

The shape of this is the finding. Only 24 of the 1,155 missing albums belong to an artist SK Music
doesn't carry. **This is a harvest-depth and refresh-cadence gap on existing artists, overwhelmingly
in singles — not a curation gap.** The fix is a pipeline tuning question (how deep the per-artist
album crawl goes, how often it re-runs), not a whitelist question.

Artists with the most missing releases: Nemouel (15), Waterbury Mesivta (14), Shay Viner (13),
Shragee Gestetner (13), Nachmen Filmer (11), then a long tail at 10 and below — Uncle Moishy,
אושרי טויטו, ניגון ירושלמי, Akiva David, Avrumi Rosenfeld, MixerJr, Zisha'la, Eliezer Kosoy,
Zalman Goldstein, Davis Brothers.

**Artwork:** 11,222 of their 12,146 albums use `w544-h544` square artwork. SK Music's `album.thumbnail`
already uses the same `w544-h544` form (verified in `corpus.db`). **No gap** — the prior research
flagged this as a KolVids advantage; it is not.

### 2.3 Gap checklist — music

Ordered by value. This is a checklist for SK Music's own whitelist pipeline, not an import list
(see §6).

1. **Deepen per-artist album/single harvest.** 1,131 releases on artists already carried. Highest
   value by a wide margin, and it is a pipeline parameter, not a curation decision.
2. **Consider the 8 artists above.** Low value — all zero-signal on their own platform too.
3. **Nothing else.** SK Music leads on artists (1,625 vs 1,522), tracks (71,720 vs ~38,475) and
   albums (13,923 vs 12,146).

---

## 3. Features they do better — ranked by value-to-effort

Two items the prior research flagged are struck out here because **SK Music already has them** —
recorded explicitly so they don't get re-proposed:

- ~~"Albums as first-class objects with square 544×544 artwork"~~ — SK Music has album pages at
  `/albums/:id`, deep-linked, OG-injected, pre-baked to `dist/data/album/:id.json`, with `w544-h544`
  artwork already. Present.
- ~~"Artist-level filter flags instead of per-track tagging"~~ — SK Music's `artists.json` already
  carries `isFemale, isChasid, isKidZone, isDJ, isAmerican, isIsraeli, isFamous, isAcapellaOnly` per
  artist. Present, and richer than their `origin / is_kids / is_famous / is_female`.

### Rank 1 — Language + category fields on the podcast index · **Free**

**What it is.** Two string fields per show in `dist/data/podcasts.json`, plus a chip row on the
podcast tab. Their model: `channels.language` ∈ {english, yiddish, hebrew} and `channels.category`.

**Why it's better than today.** SK Music browses 169 shows as one flat list with no facets of any
kind. That much is certain; the *size* of the language problem specifically is not — see §1.3(a), the
current bake carries no language signal and all 169 titles are Latin script, so the non-English share
is unknown.

**Effort.** Add the fields in `engine/build-static.mjs` where the whitelist is baked; render a chip
row. No new Worker route — `podcasts.json` is a static asset. **Prerequisite:** the language values
have to come from somewhere. Sample the 169 channels for a language signal before committing to this
rank — if the mix turns out to be overwhelmingly English, category tagging is the valuable half and
language is noise.

**Cost: Free.** Baked into `dist/` at build time; static assets bypass the Worker entirely.

### Rank 2 — Fill the 14 podcast show gaps · **Free**

**What it is.** The table in §1.2, run through SK Music's existing whitelist pipeline.

**Why.** 2,862 episodes, including two Yiddish shows in a surface that currently has no Yiddish
browse path at all. Pairs naturally with Rank 1.

**Cost: Free.** Shows land in the baked `podcasts.json`; episode lists already come from the existing
edge-cached `/podcast` and `/podcast-channel` routes (6 h cache) — no new per-user cost.

### Rank 3 — A stable `random_bucket` integer baked into the static catalog · **Free**

**What it is.** An integer column on `music_artists`, `music_albums` and `videos` (verified — e.g.
`random_bucket: 6697` on an album row). It lets the server pick a pseudo-random slice with an indexed
range scan instead of `ORDER BY random()`.

**Why it's better.** SK Music's `home.json` is a fixed curated list baked at build. The same trick
works *client-side and for free*: bake a stable bucket integer per row, and let the client select a
bucket range on load. The home feed then varies between visits **without a single Worker request.**
This is the cheapest source of freshness available to a statically-baked home page.

**Effort.** One field at bake time, a few lines of client-side slicing.

**Cost: Free.** Pure build-time + client-side.

### Rank 4 — Diversity cap and same-artist penalty in the ranking blend · **Free**

**What it is.** Their recipes carry `diversity:{maxPerChannel: 3}` and
`penalties:{sameChannel: 60, watched: 100000, partiallyWatched: 25, dismissed: 100000}` (verified
literals). The home recipe allows at most 3 items per channel; the shorts recipe allows 1.

**Why it's better.** It is an explicit anti-clumping rule. SK Music's trending blend and `home_rank`
have no per-artist cap, so a prolific artist can dominate a shelf.

**Effort.** A cap applied where the trending blend and home shelves are assembled. The `watched` /
`partiallyWatched` penalties are also worth noting — SK Music already has the local history
(`zw_podhist`, recently-played) to apply a client-side "you've heard this" demotion for free.

**Cost: Free** at bake time and client-side.

### Rank 5 — A chip that swaps the ranking recipe · **Free**

**What it is.** Their "Recently uploaded" chip sets `freshness: 200` and zeroes every other weight,
rather than filtering. Same bar, different mechanism.

**Why it's better.** It gives users a "just show me what's new" affordance without a separate page or
a new route. SK Music's Latest Releases is a fixed shelf, not a re-rank of the whole feed.

**Effort.** Small, if Rank 3/4 land first — the client is already re-ordering a baked list.

**Cost: Free.**

### Rank 6 — Enrich the existing play beacon with completion and surface · **Cheap**

**What it is.** `record_music_listen_heartbeat(p_track_id, p_session_id, p_listen_seconds,
p_duration_seconds, p_completed, p_surface, p_visitor_id)` (verified). Keyed to a
`crypto.randomUUID()` visitor id in localStorage under `kolvids.visitor.id`.

**Why it's better.** SK Music already POSTs `/a` for play analytics, so the *request* already exists.
What their payload adds is `completed` and `surface` — the difference between "started" and
"listened through," and where the play came from. That is a materially better trending signal than
play counts alone, which over-reward tracks people skip.

**Effort.** Extra fields on an existing beacon and an extra column server-side.

**Cost: Cheap** — no new request; it enriches the `/a` POST SK Music already sends. (A *new*
per-play request would be Expensive; this deliberately isn't one.)

### Rank 7 — Podcast show follows · **Free**

**What it is.** `kolvids.channel.subscriptions` in localStorage, feeding a `followedChannels` ranking
weight.

**Why it's better.** SK Music's "Your shows" is inferred from listening history, so a user cannot
mark interest in a show before playing it. An explicit follow is a stronger and earlier signal.

**Effort.** A localStorage set plus a shelf. SK Music's own comment in `assets/ui.html` notes the
design rule that keeps these shelves free — keep follows local and the cost stays zero.

**Cost: Free** if kept in localStorage. Server-backed follows would be Expensive (per-user).

### Rank 8 — Client-supplied ranking weights as a live RPC · **Expensive — recommended against**

**What it is.** Their client sends a full recipe object to the server on every feed request:
`get_home_feed(limit_count, cursor, p_channel_category, p_channel_language, p_visitor_id, p_recipe)`,
and for music `get_ranked_music_items` with `p_weights`, `p_penalties`, `p_filters`,
`p_source_track_id / p_source_album_id / p_source_artist_id`.

**Why it's interesting.** Ranking policy lives in the client and can be tuned without a deploy.

**Why not to adopt it as-is.** It requires a database round trip per feed load per user. That is the
exact shape SK Music's architecture avoids — the home feed is a static asset today. **Take the
vocabulary (weights / penalties / diversity), apply it at bake time and client-side (Ranks 3–5), and
skip the RPC.**

**Cost: Expensive** (per-user, per-request). This is the one item on the list to decline.

### Rank 9 — Pre-hydration inline script · **Free, but largely not applicable**

**What it is.** Three inline `<head>` scripts before hydration (verified in their `home.html`): one
sets `.dark` from `localStorage.theme` + `prefers-color-scheme`; one sets
`--sb-w: 72px | 220px` and a `data-sb-collapsed` attribute from `localStorage['sidebar-open']`,
plus `data-immersive` on `/watch/` routes.

**Assessment, honestly:** SK Music is dark-only (`theme-color: #0e0a0b`, no `prefers-color-scheme`
anywhere in `ui.html`) and its sidebar is a fixed-width grid column (`var(--nav-w)`), not a persisted
collapsible. **There is no flash to fix.** Listed only because prior research flagged it; it is a
non-issue unless a collapsible sidebar or a light theme is ever added.

**Cost: Free.** Value: near zero today.

---

## 4. Where SK Music is clearly ahead

Each claim below was checked against their published bundle or their live data before being asserted.

**No content filtering or parental controls — verified.** Searched their entire bundle for `kolIsha`,
`is_female`, `isFemale`, `femaleFilter`, `safeMode`, `parental` — **zero hits.** There is no filter
model, no PIN, no kid mode, no artist allow/blocklist. SK Music has ten account-level filters plus a
PIN-gated parental layer with Kid Zone, artist allow/blocklists, a Sefira/Three-Weeks acapella rule,
and per-feature parental gates.

**`is_female` is structurally unusable to them — verified.** The column exists on `music_artists` and
is `false` on **all 1,522 rows**. They exclude female-voice artists at import rather than tagging
them, which means a parent-configurable kol-isha toggle is *impossible* on their data without a
re-import. SK Music tags instead of excluding — 74 female-voice artists in the corpus, gated at
runtime — which is why SK Music carries 109 artists they don't, 73 of them female-voice. **Tagging
beats excluding, and this is the clearest architectural win in the comparison.**

**No downloads, no offline — verified.** Searched for `downloadUrl`, `"download"`, `Download<` —
zero hits. No service worker registration (the only `serviceworker` strings are in a Vite
modulepreload `switch` statement). SK Music has ranged-chunk offline downloads via the Tauri desktop
app and a PWA service worker caching the shell.

**No sleep timer, no playback speed — verified.** Zero hits for `sleepTimer`, `playbackRate`,
`setPlaybackRate`. SK Music has both (15/30/45/60 min or end-of-song; 0.75×–2× applied to both the
YouTube iframe and the `<audio>` element).

**No gapless playback or crossfade — verified/inferred.** Their playback is a standard
`youtube-nocookie.com/embed` iframe with ordinary `playerVars`; there is no second player and no
crossfade code. SK Music runs a dual-player standby engine that primes the next track ~200 ms early
and swaps on the PLAYING event, plus optional 3/6/9/12 s crossfade.

**Live radio — precise version.** They have 6,326 `is_livestream` videos (verified) — that is
YouTube livestreams appearing in a feed. It is *not* a synchronised radio product. SK Music's Zemer
Radio is three synchronised broadcast stations with a server-provided offset, its own pages, and a
parental station-pinning policy. **Different thing; SK Music is ahead, but "they have no
livestreams" would be wrong.**

**Shiurim — precise version.** They have 33 channels tagged `torah` and a "Torah and Shiurim"
category chip. What they do *not* have is a structured lecture catalog. SK Music bakes
`dist/data/shiurim.json` with **10 topics, 1,341 speakers, 1,141 series and 12 languages** (verified
counts), deep-linkable at `/shiurim/{lecture,speaker,topic,series}/:id`, with per-lecture resume,
kol-isha flags per speaker/lecture, and no-download honouring. **"They have no shiurim" is too
strong; "they have Torah video channels, not a shiurim catalog" is correct.**

**Also ahead, briefly:** time-synced lyrics (LRCLIB, tap-to-seek); a Tauri desktop app with tray,
media keys, mini player and jump list; fully client-side Hebrew-aware fuzzy search off the main
thread; personal playlists with cover art and public share links; 10,145 community playlists;
per-song/artist/album radio via a co-occurrence graph; queue editor with drag-reorder.

**Where they have surface area SK Music doesn't — scope, not gap.** 27,467 Shorts, a games section,
video watch pages, video likes and view counts. SK Music is an audio product; these are deliberate
scope differences and are not treated as gaps.

---

## 5. Cost annotation summary

SK Music's Cloudflare Worker account is request-limited, so every recommendation is marked by what it
costs at runtime. **Free** = baked into `dist/` at build time or pure client-side (static assets
bypass the Worker entirely). **Cheap** = one shared edge-cached route. **Expensive** = per-user or
per-play.

| # | Recommendation | Cost | Notes |
|---|---|---|---|
| 1 | Language + category fields on podcast index | **Free** | Baked into `podcasts.json` |
| 2 | Fill 14 podcast show gaps | **Free** | Baked index; episodes use existing 6 h-cached routes |
| 3 | `random_bucket` in static catalog | **Free** | Build-time field + client-side slice |
| 4 | Diversity cap / same-artist penalty | **Free** | Bake-time + client-side |
| 5 | Recipe-swapping chip | **Free** | Client-side re-rank of a baked list |
| 6 | Enrich existing `/a` beacon | **Cheap** | No new request — extra fields on an existing POST |
| 7 | Podcast show follows | **Free** | localStorage only; server-backed would be Expensive |
| 8 | Client-supplied ranking weights RPC | **Expensive** | **Recommended against** — per-user DB round trip |
| 9 | Pre-hydration inline script | **Free** | Near-zero value today (dark-only, fixed sidebar) |
| — | Deepen per-artist album harvest (§2.3) | **Free** | Build-pipeline parameter |

**Eight of the ten are Free, one is Cheap, and the single Expensive one is the one to decline.**

---

## 6. A note on ideas versus catalog rows

The *mechanics* in this document — a random bucket for cheap variety, diversity caps, a chip bar that
can re-rank instead of filter, completion-aware listen beacons, language and category facets — are
ordinary engineering patterns. They are free to adopt, and adopting them is straightforwardly fair.

Their *catalog rows* are a different question. The 159-channel whitelist and the 1,522-artist
approval list are somebody's curation work — the product of review decisions, not of a crawler. The
right use of §1.2 and §2.3 is as a **gap checklist**: a list of shows and artists worth *evaluating*
for SK Music's own whitelist, then admitting through SK Music's own pipeline with SK Music's own
review, flags and filters applied. Not a copy of their table.

That distinction is also practical, not just ethical. SK Music's filter model tags where theirs
excludes, so an imported row would arrive without the `isFemale` / `isChasid` / `isKidZone` /
`isAcapellaOnly` classification that every SK Music filter depends on — the flags that make the
parental layer work simply do not exist on their side. **Their rows would not be safe to serve
without re-review anyway.**

---

## Appendix — reproducing the counts

- **Endpoint:** `https://jlsqxujzzvbzprrqkpna.supabase.co/rest/v1/`, anon-readable with the
  `sb_publishable_*` key from their client bundle.
- **Conduct:** read-only GETs, paginated at 100–1,000 rows, column-projected, ~250–600 ms between
  pages, well under 100 requests total. No writes, no `admin_*` RPCs, no user tables touched
  (`profiles`, `reports`, `channel_requests`, `game_saves` were never queried).
- **Timeouts:** `count=exact` on `videos` and `music_tracks` returns `statement timeout`; those two
  totals are `count=estimated` and are marked `~` throughout. Per-channel podcast counts are
  `count=exact` and are precise.
- **Joins:** artists joined on `music_artists.external_artist_id` ↔ `artist.id` (both YouTube `UC…`);
  albums on `music_albums.external_album_id` ↔ `album.id` (both `MPREb_…`). Exact-key joins.
- **Podcast matching** was name/author normalised matching over 21 × 169 pairs, then hand-verified —
  the only step in this document that is not an exact key join. All 14 gaps were additionally
  keyword-checked against four SK Music data files.
- **Bundle literals** (ranking recipes, category bar, localStorage keys, heartbeat signature) were
  read from `main_hooks-CmSsj2ji.js`, `main_CategoryBar-BDlHPKc-.js`,
  `music_youtube-music-links-Cd8IiM3G.js` and `home.html` as published.
