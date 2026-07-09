# SK Music — Backend (Supabase)

The only stateful backend is a single **Supabase** project. It stores anonymous usage analytics, the
admin allowlist, user accounts + parental-control state, likes, and two crowdsourced artist-tag tables.
Everything is defined in one runnable file: [`../supabase/schema.sql`](../supabase/schema.sql).

Cross-refs: [`architecture.md`](architecture.md) · [`filters-and-parental-controls.md`](filters-and-parental-controls.md).

- **Project URL:** `https://jxttqcouabdptftlvfnd.supabase.co` (ref `jxttqcouabdptftlvfnd`)
- **Anon key:** the committed key (in `assets/ui.html`, `assets/analytics.html`, `supabase/supabase-client.js`)
  is the **publishable anon key** — safe to ship because every table is RLS-protected and sensitive writes
  only go through SECURITY DEFINER functions. It is **not** the `service_role` key.

> The live backend intentionally keeps the historical `zemer_*` table names, because the shipped code
> targets them verbatim. They can be renamed later only in lockstep with the code.

---

## 1. Tables

| Table | Purpose | Access model |
|---|---|---|
| `zemer_analytics` | one row per client event (play/search/nav/…) | anon **INSERT** only; **SELECT** = admins only (RLS) |
| `zemer_admin` | emails allowed into the `/analytics` dashboard | a user reads only their own row |
| `zemer_user` | per-user profile + parental controls | **hard-locked**: own-row read of non-secret cols; only `recents` writable; protected cols via `pc_*` |
| `zemer_like` | queryable per-song likes | own rows only (RLS) |
| `israeli_artist_tag` | crowdsourced "is this artist Israeli?" | **no RLS** — open to the anon key (grant-governed) |
| `chasidish_artist_tag` | crowdsourced "is this artist Chasidish?" | **no RLS** — open to the anon key (grant-governed) |

Full column lists, comments, and the exact RLS/grant statements are in `supabase/schema.sql`. The
security model is summarized at the top of that file; the parental hard lock is explained in
[filters-and-parental-controls.md](filters-and-parental-controls.md).

---

## 2. RPCs (functions)

| Function | Caller | Security | Used for |
|---|---|---|---|
| `top_songs(days,lim)` | anon | DEFINER | home Trending (Worker `/trending`) — top qualified plays, deduped by videoId |
| `top_artists(days,lim)` | anon | DEFINER | home Trending — top qualified-play artists |
| `play_analytics(days)` | anon | DEFINER | dashboard: listen hours + play source attribution |
| `search_analytics(days)` | anon | DEFINER | dashboard: search click-through rate + avg clicked rank |
| `is_zemer_admin()` | (policy) | DEFINER | RLS predicate for admin SELECT on analytics |
| `ensure_profile()` | authed | DEFINER | create the caller's `zemer_user` row if the signup trigger missed |
| `get_my_likes(lim)` | authed | INVOKER | load a user's likes on login |
| `toggle_like(video_id,title,artist)` | authed | INVOKER | like/unlike in one call, returns new state |
| `pc_get()` | authed | DEFINER | read own settings (`has_pin`, never the hash) + lockout countdown |
| `pc_verify(pin)` | authed | DEFINER | unlock screen (bcrypt check + escalating lockout) |
| `pc_update(pin,patch)` | authed | DEFINER | change protected parental settings (PIN-gated) |
| `pc_set_pin(new,old)` | authed | DEFINER | set/change the PIN |
| `pc_clear_pin(pin)` | authed | DEFINER | remove the PIN, release the lock |
| `pc_check_pin(pin)` | *internal* | DEFINER | PIN check + failure counter; execute REVOKED from all client roles |
| `handle_new_user()` | trigger | DEFINER | auto-create `zemer_user` on `auth.users` insert |
| `iat_touch()` / `cat_touch()` | trigger | — | keep `updated_at` fresh on the tag tables |

The aggregate RPCs are SECURITY DEFINER so the public anon key can read **counts** from `zemer_analytics`
without ever exposing the raw rows (which stay admin-only via RLS).

---

## 3. The analytics pipeline

```
assets/ui.html  ──batch──▶  Worker POST /a  ──bulk insert──▶  zemer_analytics
  (client                 (enrich: IP,                       │
   batches events;        country, city,                     ├─▶ /analytics dashboard  (admin SELECT, RLS)
   `sid` session,         browser/OS/                        │      assets/analytics.html
   `meta` payload)        device from UA)                    └─▶ top_songs / top_artists (anon RPC)
                                                                    │
                                                                    ▼
                                                              Worker /trending  ──▶  home "Trending" rails
```

1. **Client** (`assets/ui.html`) batches events and beacons them to the Worker's `POST /a`. Each event has
   an `event` type, a per-tab `sid` (session), a `screen`, an optional `ref` (referrer), and an
   event-specific `meta` object. Key `meta` fields:
   - `play` (fires on **end**): `v` (videoId), `title`, `artist`, `seconds` (listen time),
     `qualified` (`false` for a quick skip), `source`, `client`.
   - `search`: `q`, `count`. `click`: `rank` (0-based), `kind`, `vid`. `blocked`: `title`/`v`, `reason`.
2. **Worker `/a`** (`analytics()` in `engine/index.mjs`) accepts a batched array, adds request-level
   fields (IP, country/city/region from `request.cf`, and browser/OS/device parsed from the UA), clips
   strings to length, and **bulk-inserts one row per event in a single Supabase POST**
   (`ctx.waitUntil`, so it never blocks the 204 beacon response). If the `screen` column doesn't exist yet
   it retries with `screen` folded into `meta` — no data lost. Target table = `SUPABASE_TABLE`
   (**must be `zemer_analytics`**; the code default is the literal `"analytics"`).
3. **Reads:**
   - The **`/analytics` dashboard** (`assets/analytics.html`) signs the admin in via Supabase Auth, checks
     their email against `zemer_admin`, then `SELECT *` from `zemer_analytics` over a time window (RLS
     permits it only for admins). It renders sessions, bounce, traffic sources, countries, an hour×day
     heatmap, per-event breakdowns, etc.
   - The **home Trending rails** come from the Worker `/trending` route calling `top_songs` + `top_artists`
     (edge-cached 30 min).

---

## 4. Setup / operating a fresh backend

1. **Create a Supabase project** (or reuse `jxttqcouabdptftlvfnd`).
2. **Apply the schema:** paste [`../supabase/schema.sql`](../supabase/schema.sql) into the SQL Editor and
   Run (idempotent), or `psql … -f supabase/schema.sql`. This creates every table, RPC, RLS policy, and
   trigger above and installs `pgcrypto`.
3. **Seed an admin:** the schema inserts one admin email — change it to yours (bottom of the file), and
   add the same email under **Authentication → Users** so you can sign into `/analytics`.
4. **Point the app at the project.** Update the anon key + URL in `assets/ui.html`,
   `assets/analytics.html`, and `supabase/supabase-client.js` if you changed projects. Configure the
   **Worker** environment (Cloudflare dashboard or `wrangler secret`):

   ```
   SUPABASE_URL   = https://<ref>.supabase.co
   SUPABASE_KEY   = <anon / publishable key>
   SUPABASE_TABLE = zemer_analytics     # else the Worker writes to a table literally named "analytics"
   ```

   > These three are **not** in `.env.example` — that file only covers the build. They are Worker
   > vars/secrets. Without them, `/a` returns 204 (no-op) and `/trending` returns empty rails, so the
   > static app still works; only analytics + trending go dark.

5. **Auth:** email/password sign-in is used for both the parental-controls accounts and the analytics
   dashboard. The signup trigger + `ensure_profile()` guarantee a `zemer_user` row exists per user.
6. **Artist-tag tools** (`/israeli-tagger`, `/chasidish-tagger`): contributors write directly to
   `israeli_artist_tag` / `chasidish_artist_tag` with the anon key (no login). `build-static.mjs` reads
   these at build time to tag artists in the baked dataset. These tables are deliberately RLS-disabled;
   Supabase will flag them "public / RLS disabled" — that's expected.

---

## 5. Files

| Path | What |
|---|---|
| [`../supabase/schema.sql`](../supabase/schema.sql) | the full runnable backend (start here) |
| `supabase/supabase-client.js` | tiny browser client (URL + anon key) |
| `assets/israeli-artist-tag.sql`, `chasidish-artist-tag.sql` | the tag tables (also folded into `schema.sql`) |
| `assets/pin-fail-reset.sql` | re-affirm the PIN counter-reset (also in `schema.sql`) |
| `engine/index.mjs` | `/a` ingestion, `/trending`, OG previews, static serving |
| `assets/analytics.html` | the admin dashboard |
