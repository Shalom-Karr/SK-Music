# Catalog account gate + daily catalog quota

Two controls on the catalog files, both enforced by the Worker (`engine/security.mjs`) and both **off until
the database migration is applied** — and the account gate stays off until the admin switches it on.

| Control | Setting (`security_config`) | Default | Effect |
|---|---|---|---|
| Account gate | `catalog_requires_account` | `false` | Signed-out ⇒ `401 {"error":"account_required"}` on catalog files |
| Daily quota | `catalog_daily_quota` | `400` | Catalog files per key per UTC day; over it ⇒ catalog blocked until the next 00:00 UTC (`429 daily_limit`). `0` = off |

## What counts as a catalog file

`isCatalogPath()` in `engine/security.mjs`, GET/HEAD only:

- `/data/dataset.json.gz`
- `/data/artist/<id>.json`, `/data/album/<id>.json`, `/data/zemer-playlist/<id>.json`

With `SK_PRIVATE_DIR` set (CI), `engine/build-static.mjs` writes the per-entity files under
`dist/<SK_PRIVATE_DIR>/data/<kind>/<id>.json` instead of `dist/data/…` (moved, not copied — the 20,000-asset
budget is unchanged). The public path is then an asset miss, so the request reaches the Worker, passes
`securityGate`, and `serveCatalogFile()` in `engine/index.mjs` fetches the private copy (ETag / 304 pass
through, `Cache-Control: private, max-age=0, must-revalidate`, a missing file is a JSON 404). The deep-link
OG shells read the same private files (`entityPath()`).

Stays public and static (no Worker request): `home.json`, `home.kidzone.json`, `meta.json`, `artists.json`,
`synonyms.json`, `blocked-ids.json`, `zemer-playlists.json`, the playlist cover SVGs, and
`zemer-playlist/acapella.json` (the Acapella filter and `/charts` need it for signed-out visitors).

Without `SK_PRIVATE_DIR` (local dev) the layout is the old one and everything is static.

## Request flow for a catalog file

1. Allowlisted IP/email → served, not counted.
2. Active site-wide ban → `403 banned` (daily-quota bans are not site-wide, see step 6).
3. Verified search crawler (Googlebot/Bingbot from their published ranges) → served, not counted.
4. Anonymous datacenter → `403 datacenter` (unchanged).
5. Gate on and signed out → `401 account_required` (logged as `account_required`, deduped per IP per minute).
6. Over today's quota (a `catalog_only` ban for this key) → `429 {"error":"daily_limit", until, retryAfter,
   signIn, contact}` with `Retry-After`. `signIn:true` when the key is a signed-out IP — an account has its own
   quota. Nothing else on the site is blocked.
7. Rate limit: the **burst** tier only (15/10 s anonymous, 45/10 s signed in); catalog files never use up
   the per-minute budget. Signed in on a datacenter network: no limiter tier applies (the quota does).
8. Served, and counted toward the daily quota: key `u:<user id>` when signed in, else `ip:<ip>` — except
   content-filter proxy IPs (`FILTER_ASNS`), which carry many listeners each and are never IP-counted.

Counts are kept per isolate and flushed every ~10 s (or at 200 waiting keys) to `catalog_usage_add`, which
adds them to today's totals. The first time a key goes over the quota on a UTC day — and no other ban
covers it — it calls `security_ban` (which picks the level from ALL earlier bans: the one escalation ladder),
marks the ban `catalog_only`, extends it to at least the next 00:00 UTC, and writes one `quota_exceeded`
event. That is one ban and at most one escalation level per key per day: later overage the same day never
bans again. Quota bans on separate days climb the normal ladder — level 1–2 end at midnight UTC, level 3
lasts 24 h, level 4+ is permanent (catalog only). The Worker applies the returned block at once; other
isolates get it from `catalog_state.quota_blocks` within a minute and keep those bans out of their site-wide
ban list. A quota ban an admin lifts (Security tab → Unban) stays lifted for the rest of the day. Every
database failure fails open (gate off, nothing counted).

The settings are read with `catalog_state` alongside `security_state` (60 s per isolate), so a change from
the dashboard reaches every server within about a minute.

## The app

- The Worker stamps `X-SK-Catalog-Gate: <0|1>;<ms the setting was read>` on `/trending`, `/artist-trending`,
  `/zemer-home-rows`, `/zemer-new` and on its 401 — the app already fetches those at boot, so it learns the
  setting without an extra request and keeps the newest reading (`sk_cgate` in localStorage, trusted for a
  day).
- Gate on and signed out: opening an artist/album/playlist, searching (needs the dataset) or pressing Play
  shows **Sign in to keep listening** (Create free account / Sign in). After signing in, the blocked view
  is reloaded (or the blocked track plays). The engine skips the dataset pre-warm and hover prefetch while
  the catalog would refuse them, and the "accounts are coming" popup is not shown.
- Rate limits and bans show the full-site block overlay with a countdown (see CHANGELOG 1.9.9). Over the
  daily quota it says **Daily browsing limit reached — opens again at <local time of the next 00:00 UTC>**
  with the countdown, **Contact us**, **Create a free account** when the block is on a signed-out IP, and
  **Close** (only the catalog is blocked; the next catalog request shows it again, without re-announcing).

## Turning it on

1. Apply the migration (once, after `supabase/security.sql`), in the Supabase SQL editor:
   paste `supabase/catalog-gate.sql` → Run. It is idempotent. Re-run it after any re-run of
   `security.sql` (that file's `security_log` would otherwise drop the two new event kinds).
2. Deploy the Worker + build (CI does this on push). From then on the quota (400/day) is active and the
   per-entity files are served by the Worker.
3. Dashboard → **Security** → **Catalog access** → tick **Require an account for the catalog** → Save →
   confirm. Within a minute signed-out visitors are asked to sign in. Untick to undo.

Check it from a signed-out browser: `curl -i https://skmusic.shalomkarr.com/data/artist/<id>.json` →
`401` with `{"error":"account_required"}` when on, `200` when off.

## Cost

Per-entity files now cost a Worker request each (measured ~3k `/data/` requests a day against a 100k/day
free plan), and each signed-in or IP-counted request adds a share of one `catalog_usage_add` call per isolate
per ~10 s.
