# SK Music — Content Filters & Parental Controls

The filtering system has two layers:

1. **Content filters** — per-device toggles that hide categories of content (female singers, Chasidish,
   DJ, Israeli, non-Acapella, plus the Kid Zone). Applied both **client-side** (in the search engine)
   and via **query params** on every list request.
2. **Parental controls** — an account-bound, **server-enforced** hard lock (a PIN gate in Postgres) that
   makes a chosen filter/artist policy un-bypassable from the client.

Cross-refs: [`architecture.md`](architecture.md) (where filtering sits in the engine) ·
[`backend.md`](backend.md) (the `zemer_user` table + `pc_*` RPCs) · the runnable
[`../supabase/schema.sql`](../supabase/schema.sql).

All the logic below lives in `assets/ui.html` (function names are given so you can find it).

---

## 1. The content filters

| Filter | Client state (localStorage) | Values | Query param | Backing data |
|---|---|---|---|---|
| Female singers ("Kol Isha") | `zw_noFemale` | on/off (**on by default**, opt-out) | `allowFemale=0` | `artist.isFemale` |
| Chasidish | `zw_chasid` | `""` off · `only` · `hide` | `allowChasid=0` (hide) | `artist.isChasid` / `chasidish_artist_tag` |
| DJ | `zw_noDJ` | on/off | (client-side) | whitelist `isDJ` |
| Israeli | `zw_israeli` | `""` off · `only` · `hide` | (client-side) | `israeli_artist_tag` |
| Acapella | `zw_acapella` | `""` off · `only` · `hide` | (playlist set) | upstream Acapella playlist |
| Kid Zone | `kid_only` policy / `kidzone` tab | on/off | `kidZone=1` | `artist.isKidZone` (+ parent `kid_add`/`kid_remove`) |

Accessors: `noFemale()`, `chasidMode()`/`noChasid()`, `noDJ()`, `israeliMode()`, `acapellaPref()`/
`acapellaMode()`, `kidZoneActive()`. `anyFilter()` reports whether any is active.

### How filters are applied

- **Client-side:** the engine's `searchCategories(..., {allowFemale, allowChasid, kidZoneOnly, blockVideos})`
  post-filters results using the packed artist flags (female/chasid/kidzone) in the interned dataset.
  Detail/browse feeds are re-gated by `gate()` in `ui.html`, which additionally applies the DJ / Israeli /
  Acapella / allow-blocklist / Kid-Zone rules that aren't encoded as dataset flags.
- **Query params:** `filterQS()` builds the query string (`allowFemale=0`, `allowChasid=0`,
  `blockVideos=1`, `kidZone=1`) that list requests carry, so the same policy is expressed to the engine's
  route handlers. `includeKid=false` is passed for browse/search so an allowlisted or `kid_add` artist can
  still surface (a server-side `kidZone=1` would pre-exclude them).
- `blockVideos()` is intentionally a no-op ("Audio only" was removed from the UI — playback is audio
  either way).

### Who can change filters

Changing any content filter requires being **signed in** — a signed-out device stays on the safe defaults
(Kol Isha on). `filterGate()` enforces this and, if a PIN is set, blocks changes until the PIN is entered
(`filtersLocked()`). This is what makes filters enforceable: **the parent's account + PIN is the single
control point.** When signed in, filter changes are mirrored to the account via `acctSyncFilters()` →
`pc_update` (so they follow the user across devices) — but only when not PIN-locked, to avoid burning the
PIN brute-force counter with "free" top-bar toggles.

---

## 2. Sefira / Three Weeks — forced Acapella

During the two traditional mourning periods when instrumental music is set aside, the app **forces
Acapella-only mode** by default.

- **Detection** (`mourningPeriod()`): a self-contained Hebrew-calendar implementation
  (Dershowitz–Reingold fixed algorithm, `_hebToRD` etc.) computes, for today's civil date, whether it
  falls in:
  - **Sefira** — 22 Nisan through 17 Iyar (music resumes on Lag BaOmer, 18 Iyar, which is excluded), or
  - **The Three Weeks** — 17 Tammuz through Tisha B'Av (9 Av), inclusive.

  It returns a period key (`sefira-<hy>` / `bein-<hy>`) or `null`, memoized per calendar day (it's called
  per list item).
- **Enforcement** (`acapellaMode()` / `acapellaLocked()`): in a mourning period the effective Acapella
  mode is forced to `"only"` and the filter row is shown locked/informational (`tgAcapLocked`); only songs
  from the upstream Acapella playlist play. Outside those periods, Acapella is a free 3-state preference.
- **Kid Zone exemption** (`kidZoneActive()`): kids' music plays as usual in the Kid Zone even during a
  mourning period — whether a parent locked the whole device to Kid Zone (`kid_only`) or the Kid Zone tab
  is simply open. The forced-Acapella check explicitly excludes `kidZoneActive()`.
- **Parent override:** a parent can lift the requirement for their account by setting `filters.sefira =
  false` (PIN-gated, via `pcToggleSefira()` → `pc_update`). `sefiraRequire()` reads it; default
  (undefined/true) = required. When lifted, the account returns to its free 3-state Acapella preference.

---

## 3. Kid Zone

Kid Zone is both a browsable tab and a lockable policy.

- **Base membership:** `artist.isKidZone` in the catalog seeds the default Kid-Zone artist set; feeds pass
  `kidZone=1` for a rich kid base.
- **Parent adjustments:** a parent can widen or narrow their child's Kid Zone with `kid_add` (artist ids
  added) and `kid_remove` (artist ids removed from the default set). `hiddenByParental()` applies these:
  under `kid_only`, an artist is hidden unless it is a default Kid-Zone artist or in `kid_add`, and always
  hidden if in `kid_remove`.
- **Whole-device lock:** `kid_only` locks the entire account to Kid-Zone content only (not just the tab).

---

## 4. The parental HARD LOCK (device policy + server enforcement)

The soft version stored the policy only client-side, which a signed-in kid could defeat by PATCHing their
own `zemer_user` row via the REST API. The hard lock closes that hole in the database.

### Device-cached policy (soft layer)

`cachePolicy()` writes the gating policy — `kid_only`, `artist_mode`, `artist_ids`, `kid_add`,
`kid_remove`, `has_pin`, `filters` — to `localStorage["zw_policy"]` so it **survives sign-out**: a kid
can't escape the filters by logging out. `pcPolicy()` prefers the live profile but falls back to this
cache. This layer is soft (a technical user could clear localStorage), which is exactly why the *changes*
are locked server-side.

### Server-enforced policy (hard layer)

The protected columns of `zemer_user` (`parental_lock`, `pin_hash`, `filters`, `artist_mode`,
`artist_ids`, `kid_only`, `kid_add`, `kid_remove`) are **not directly writable** by clients. Postgres
enforces it (see [backend.md](backend.md) and `supabase/schema.sql`):

- Direct `UPDATE`/`DELETE` on `zemer_user` is revoked from `authenticated`; only `recents` is grantable.
- `SELECT` of the secret columns (`pin_hash`, `pin_fails`, `pin_locked_until`) is revoked, so the hash can
  never be pulled client-side and offline-cracked.
- Every protected mutation goes through a **SECURITY DEFINER** `pc_*` function that verifies the PIN first
  (bcrypt via pgcrypto), with a server-side escalating lockout after 5 wrong tries (30s, 60s… capped at
  15 min).

### The client flow (`ui.html`)

The client never sees or hashes the PIN — it only holds the entered value in memory (`acct.pin`) to
authorize `pc_update` while Parental Controls are unlocked. Relevant RPC calls (via `sbRpc()` /
`sbSelectProfile()`, all with a one-shot token refresh on 401):

| UI action | RPC | Notes |
|---|---|---|
| Load profile on login / reload | `pc_get` (+ `ensure_profile`) | returns `has_pin` (never the hash) + all non-secret fields; never clobbers the gate on a failed load |
| Unlock screen | `pc_verify(p_pin)` | bcrypt check + server lockout |
| Change a protected setting | `pc_update(p_pin, p_patch)` | `pcSet()`, `pcSave()`; re-gates + reloads on `kid_only`/`artist_mode` |
| Set / change PIN | `pc_set_pin(p_new_pin, p_old_pin)` | set: old ignored; change: needs current |
| Remove PIN | `pc_clear_pin(p_pin)` | releases `parental_lock` |
| Toggle Sefira requirement | `pc_update` (`filters.sefira`) | `pcToggleSefira()` |
| Recents sync | direct `PATCH zemer_user?id=eq.<uid>` | `recents` is the one freely-writable column |

`parentalActive()` reports whether any parental policy is in force (`parental_lock`, `kid_only`, or a
non-`all` `artist_mode`); `searchMustBeLocal()` forces search to stay on the whitelisted local dataset
whenever an allow/blocklist or Kid-Zone lock is active.

### Recovering a locked-out / mis-hashed PIN

If a parent gets locked out, or an account still carries a legacy non-bcrypt hash, see
`assets/pin-fail-reset.sql` (re-affirms the correct `pc_check_pin` that resets the counter on a correct
PIN). The schema also clears any non-bcrypt (`!~ '^\$2'`) `pin_hash` on apply so the parent simply re-sets
the PIN.
