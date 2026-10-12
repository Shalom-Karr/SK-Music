# Signed-out limits

Visitors **without an account** get a small taste of the catalog, then are asked to sign in. Enforced by the
Worker (`engine/security.mjs`, counted by the `RateLimiter` Durable Object in `engine/limiter.mjs`); the app
(`assets/ui.html`, `engine/engine.mjs`, `engine/engine-worker.mjs`) shows the prompt. Signed-in accounts,
allowlisted IPs/emails and verified search crawlers (Googlebot, Bingbot incl. Bing's `HeadlessChrome` renderer,
matched by published IP range) are never limited.

| What | Limit (per client) | Over it |
|---|---|---|
| Detail pages — artist, album, curated or YouTube playlist | 5 distinct pages per 7 min | `401 signin_required`, `kind:"detail"` |
| Song starts | 1 distinct song per 7 min | `401 signin_required`, `kind:"play"` |
| Search (the full dataset) | needs an account | `401 signin_required`, `kind:"search"` |

```json
{ "error": "signin_required", "kind": "detail", "resetAt": "2026-10-12T23:06:35.914Z", "retryAfter": 416 }
```

`Retry-After: <retryAfter>` is set for `detail` and `play`; `search` has `resetAt: null, retryAfter: null` and no
`Retry-After`. Responses are `Cache-Control: no-store`. A browser navigation (`Accept: text/html`) gets a small
HTML page with a link to sign in.

## What counts

`anonUse()` in `engine/security.mjs`:

| Request | Counts as | Member (counted once per window) |
|---|---|---|
| `GET/HEAD /data/artist/<id>.json` | detail | `artist:<id>` |
| `GET/HEAD /data/album/<id>.json` | detail | `album:<id>` |
| `GET/HEAD /data/zemer-playlist/<id>.json` (not `acapella`) | detail | `zemer-playlist:<id>` |
| `GET /artist-trending?id=<id>` (artist page's Trending rail) | detail | `artist:<id>` — same slot as the artist file |
| `GET /playlist?id=<id>` (live YouTube playlist) | detail | `playlist:<id>` |
| `GET /zp-live?id=<id>`, except `auto-trending`, `auto-top-50`, `auto-acapella-top-50` | detail | `zemer-playlist:<id>` |
| `POST /play-start?v=<videoId>` | play | `v:<videoId>` (no/invalid id ⇒ every call is new) |
| `GET/HEAD /data/dataset.json.gz` | search | — (always refused signed out) |

- **Distinct, not requests.** Opening the same page twice (hover prefetch + click, back/forward, a 304
  revalidation, the artist file + `/artist-trending`) uses one slot. Replaying the same song (repeat-one, Play
  again) is free. A refused request is not counted.
- **Not counted:** Home and boot routes (`/trending`, `/zemer-home-rows`, `/zemer-new`, the three Home
  `/zp-live` ids, `home.json`, `artists.json`, `zemer-playlists.json`, `acapella.json`), `/radio`, podcasts,
  shiurim lists, stations lists, lyrics, `/song-meta`.
- **Windows start at the first use** (not on a clock boundary): the first counted request opens a 7-minute
  window; `resetAt` is exactly first use + 7 min. Windows live in the Durable Object's storage, so an evicted
  object keeps them; an alarm deletes them once expired.
- The existing burst/minute rate limits run first (a scraper hammering refused files still trips them and
  climbs the ban ladder), then the signed-out limit. The daily catalog quota counts only requests that pass.

### Song starts

The app calls `POST /play-start?v=<id>` right before a song actually starts (`permitThen()` in `playFrom` /
`playIndex`) while signed out. Not for the gapless standby (which is not used at all while signed out — every
next song asks first), a seek, pause/resume, a crossfade, a relay/engine switch or a reload of the same song.
**Shiurim, podcast episodes and SK Music stations count like songs** (each is catalog/lecture audio; a station
is a scheduled run of catalog songs, so exempting it would make the limit meaningless). Non-YouTube items send a
short hash of their id/source as `v`.

Playback is client-side YouTube, so this is enforced by the app: a modified client could skip the call. The
server counter is what makes it one budget per client across tabs and browsers.

## Search without an account

The dataset never goes to a signed-out visitor. In the app:

- The engine worker pre-warms the dataset **only when signed in** (`cgWarm` posts `{cfg:{warm, auth}}`). After
  one refusal the engine remembers it (`needAcct`) and doesn't ask again until a sign-in (`auth:true` /
  `ENGINE.resetAuth()`), so typing a search costs no requests.
- Reads that need the dataset — `/search`, the Playlists tab (`/playlists`), a live YouTube playlist
  (`/playlist`) — show the sign-in prompt (at most once per 30 s) and an inline "needs a free account" card.
  Spoken-word search results (static files + TorahAnytime) still appear.
- Background lookups stay silent: `/track` for the Watch button or an ad-guard duration simply gets nothing.
- A shared `/song/:id` link still plays signed out: the engine checks the song with `/track?lite=1`, which falls
  back to the Worker's `GET /song-meta?v=<id>` (title, artist and the video/explicit/female/Chassidish flags
  from `og.json` — the same whitelist, built from the same tracks) when the dataset is refused.
- The For You "mix from your artists" rail (six artist files in the background) and hover prefetch are skipped
  signed out, so nothing spends the budget without a click.

## Who is "a client"

`anonClient()`:

1. **Ordinary networks:** `CF-Connecting-IP`. IPv6 is grouped by **/64** (`ip6:<first 4 groups>::/64`) so one
   household can't rotate addresses; IPv4-mapped IPv6 is the IPv4 address.
2. **Content-filter proxies** (`FILTER_ASNS`: Techloq 402239/397263/211476, CloudWebManage 44709, DataVerge
   395383, PV-Hosted 208172, PureVoltage 26548) carry many listeners per IP:
   - **X-Forwarded-For**, trusted *only* on these ASNs. Cloudflare appends the address that connected to it (the
     proxy) to any `X-Forwarded-For` it receives, so the last entry must equal `CF-Connecting-IP`, and the entry
     immediately before it — the one the proxy added — is the listener. It must parse (ports and `[v6]:port`
     tolerated) and be public: not private, loopback, link-local, CGNAT, documentation, benchmarking,
     multicast/reserved, Teredo/6to4, Cloudflare's own ranges, or the proxy itself. Entries further left are
     client-supplied and ignored. Keyed like any IP (v6 by /64).
   - Otherwise the **device cookie** `sk_dev=<id>.<sig>`: a random 128-bit id plus HMAC-SHA256 under a key derived
     from `SEC_TOKEN` (HMAC(SEC_TOKEN, "sk_dev cookie key v1")). `HttpOnly; Secure; SameSite=Lax; Path=/;
     Max-Age=31536000`. Issued on any Worker response to a signed-out request from these ASNs that lacks a valid
     one (Home's boot requests, so it is set before the first detail page); that one response is made
     `Cache-Control: private, no-cache` so a proxy cache never hands one listener's id to another. A forged,
     unsigned or other-key cookie is ignored and replaced; until a valid one comes back the request is keyed on
     the proxy IP.
3. No cookies are issued anywhere else.

Every refusal is logged as a `signin_required` security event (batched, deduped per client/kind per minute) with
`detail: {kind, via}`, `via` = `ip` | `xff` | `device` — the Security tab shows how often filter proxies forward
an `X-Forwarded-For`.

Residual risk: if a filter proxy passed a client's own `X-Forwarded-For` through without appending the real
client, that client could choose its key. Only possible behind those ASNs; the burst/minute limits still apply
per proxy IP.

## Failure behaviour

- **Fail open** for `detail` and `play`: no `LIMITER` binding (old deploy / local dev), a slow (>1.5 s) or failing
  Durable Object, or any error in the gate ⇒ the request goes through. These limits are a nudge to create an
  account, not a security boundary, and an infrastructure problem must never block a listener.
- **The dataset stays refused** without the limiter — that rule needs no counter.
- A well-formed, unexpired token for this project that can't be checked because Supabase's signing keys are
  unavailable (JWKS never loaded) is **not** held to these limits — an auth outage can't put signed-in listeners
  on them. A token that fails verification while the keys are loaded is anonymous as before.
- The app fails open too: `/play-start` network error or any answer other than 401/403/429 ⇒ the song plays.

## Interaction with the account gate

With **Require an account for the catalog** on (`docs/catalog-gate.md`), signed-out visitors get the existing
`401 account_required` for everything above — detail files, `/artist-trending`, `/playlist`, non-Home `/zp-live`,
`/play-start` and the dataset — and the app shows "Sign in to keep listening". The Home `/zp-live` ids stay public.

## The app

- Notice: the existing `#gateModal`, titled **You've reached the limit without an account**, text **Sign in or
  create a free account to keep browsing and listening.**, buttons **Create free account** / **Sign in**, and for
  detail/play **or wait m:ss** counting down to `resetAt`. One notice at a time: it never opens over another
  dialog or the rate-limit overlay. After signing in, what was blocked is retried (`gateAfterLogin`): the page
  re-renders or the song starts.
- A detail page over the limit shows a "This needs a free account" card behind the notice, not "Not available".
- Music already playing keeps playing: a detail refusal never pauses it, and a refused song start leaves the
  current song (and the queue) alone.
- Signed in but the Worker saw no valid token (expired `sk_at` cookie): no notice; the token is refreshed once
  and the request retried.

## Database

The limits need no database. `supabase/anon-limits.sql` only adds the `signin_required` kind to `security_log`
(without it those events are dropped): run it once in the Supabase SQL editor, after `security.sql` and
`catalog-gate.sql`, and again after any re-run of either. Idempotent.

## Cost

Each signed-out detail/play request is one extra Durable Object request (the anonymous `anon:<client>` object)
on top of the rate-limiter call, plus a storage write when a new member is counted. Signed-in traffic is
unchanged. `/song-meta` is one Worker request per shared-song visit while signed out.
