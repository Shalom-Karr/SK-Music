-- ============================================================================
-- SK Music — Supabase backend schema (runnable, idempotent).
--
-- Recreates every table, RPC, RLS policy and trigger the SK Music app depends on:
-- anonymous play analytics, the admin allowlist for the /analytics dashboard,
-- user accounts + the parental HARD LOCK (DB-enforced PIN gate), likes, and the
-- crowdsourced artist-tag tables used by the tagger tools.
--
-- ---------------------------------------------------------------------------
-- HOW TO APPLY
--   Option A (Supabase SQL Editor): paste this whole file and Run. Safe to
--     re-run — every object uses `create ... if not exists` /
--     `create or replace` / `drop ... if exists`.
--   Option B (psql):
--     psql "postgresql://postgres:<PW>@db.<ref>.supabase.co:5432/postgres" -f schema.sql
--
-- PROJECT THE CODE TARGETS
--   URL : https://jxttqcouabdptftlvfnd.supabase.co   (project ref: jxttqcouabdptftlvfnd)
--   The anon key committed in the client (web/ui.html, web/analytics.html,
--   supabase-client.js) is the PUBLISHABLE anon key — it is safe to ship because
--   every table is RLS-protected and the sensitive mutations only go through the
--   SECURITY DEFINER pc_* functions below. It is NOT the service_role key.
--
-- WORKER ENVIRONMENT (Cloudflare)
--   The Worker (worker/index.mjs) needs these vars/secrets to reach this backend:
--     SUPABASE_URL   = https://jxttqcouabdptftlvfnd.supabase.co
--     SUPABASE_KEY   = <the anon/publishable key>
--     SUPABASE_TABLE = zemer_analytics    <-- IMPORTANT: the analytics event
--                        table is named `zemer_analytics`. The Worker defaults to
--                        the literal name "analytics" when SUPABASE_TABLE is unset,
--                        so set SUPABASE_TABLE=zemer_analytics (or rename the table).
--
-- TABLE NAMING
--   The live backend intentionally keeps the historical `zemer_*` names
--   (zemer_analytics / zemer_admin / zemer_user / zemer_like) because the shipped
--   code targets them verbatim. They COULD be renamed later, but only in lockstep
--   with the code (worker/index.mjs, web/analytics.html, web/ui.html and the two
--   tagger tools all hardcode these names / the SUPABASE_TABLE value).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. EXTENSIONS
-- ---------------------------------------------------------------------------
-- pgcrypto provides crypt()/gen_salt() (bcrypt) for the parental PIN hashing.
-- Installed into the `extensions` schema per Supabase convention.
create extension if not exists pgcrypto with schema extensions;


-- ============================================================================
-- 1. ANALYTICS  (public.zemer_analytics)
--    One row per client event. Written by the Worker /a beacon (bulk insert with
--    the anon key); read only by admins (via RLS) in the /analytics dashboard;
--    aggregated for the home "Trending" rails by the SECURITY DEFINER RPCs below.
-- ============================================================================
create table if not exists public.zemer_analytics (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  event       text,        -- 'load' | 'nav' | 'play' | 'search' | 'click' | 'like' | 'filter' | 'blocked' | 'conntest'
  url         text,
  path        text,
  referrer    text,        -- Worker maps the client's `ref` field to this column
  ip          text,
  country     text,
  city        text,
  region      text,
  user_agent  text,
  browser     text,        -- parsed server-side from the UA
  os          text,        -- parsed server-side
  device      text,        -- parsed server-side: 'desktop' | 'mobile' | 'tablet'
  screen      text,        -- e.g. "1920x1080" (Worker folds this into meta if the column is absent)
  session     text,        -- per-tab session id (client-generated)
  meta        jsonb        -- event-specific payload: {v,title,artist,qualified,seconds,source,client,
                           --   q,count,rank,kind,vid,f,on,viewport,dpr,pwa,reason,...}
);

-- Indexes that speed up the dashboard's time-range scans and the trending aggregates.
create index if not exists idx_za_created        on public.zemer_analytics (created_at desc);
create index if not exists idx_za_event_created  on public.zemer_analytics (event, created_at desc);
create index if not exists idx_za_play_created    on public.zemer_analytics (created_at) where event = 'play';
create index if not exists idx_za_click_created   on public.zemer_analytics (created_at) where event = 'click';


-- ============================================================================
-- 2. ADMIN ALLOWLIST  (public.zemer_admin)
--    Emails allowed to view the /analytics dashboard. A dashboard user signs in
--    via Supabase Auth, then their email must be present here.
-- ============================================================================
create table if not exists public.zemer_admin (
  email text primary key
);


-- ============================================================================
-- 3. USER PROFILE + PARENTAL CONTROLS  (public.zemer_user)
--    One row per Supabase Auth user. Holds the synced content-filter prefs,
--    the artist allow/blocklist, the Kid-Zone lock, and the parental PIN state.
--    The hard-lock section (below) is what prevents a signed-in kid from PATCHing
--    the REST API to unlock themselves.
-- ============================================================================
create table if not exists public.zemer_user (
  id            uuid primary key references auth.users on delete cascade,
  email         text,
  parental_lock boolean not null default false,     -- filters + artist list can't change without the PIN
  pin_hash      text,                                -- bcrypt HASH of the PIN (pgcrypto) — never the raw digits
  filters       jsonb  not null default '{}'::jsonb, -- {noFemale, chasid, noChasid, blockVideos, acapella, noDJ, israeli, kidZone, sefira}
  artist_mode   text   not null default 'all',       -- 'all' | 'only' (allowlist) | 'except' (blocklist)
  artist_ids    jsonb  not null default '[]'::jsonb, -- picked artist ids for 'only'/'except'
  kid_only      boolean not null default false,      -- lock the whole account to Kid-Zone content only
  kid_add       jsonb  not null default '[]'::jsonb, -- artist ids the parent ADDED to this kid's Kid Zone
  kid_remove    jsonb  not null default '[]'::jsonb, -- artist ids the parent REMOVED from the default Kid Zone
  recents       jsonb  not null default '[]'::jsonb, -- recently played (small, capped client-side) — the ONLY freely-writable column
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Brute-force guard state for the PIN gate (server-side; a kid cannot reset these
-- because the whole row is write-locked below except `recents`).
alter table public.zemer_user add column if not exists pin_fails        int         not null default 0;
alter table public.zemer_user add column if not exists pin_locked_until timestamptz;


-- ============================================================================
-- 4. LIKES  (public.zemer_like)
--    A queryable per-song likes table (not a JSON blob). Loaded once on login and
--    kept in sync via the get_my_likes / toggle_like RPCs.
-- ============================================================================
create table if not exists public.zemer_like (
  user_id   uuid not null references auth.users on delete cascade,
  video_id  text not null,
  title     text,
  artist    text,
  added_at  timestamptz not null default now(),
  primary key (user_id, video_id)                    -- one like per song, no dupes
);
create index if not exists idx_zl_user_added on public.zemer_like (user_id, added_at desc);


-- ============================================================================
-- 5. CROWDSOURCED ARTIST TAGS  (israeli_artist_tag, chasidish_artist_tag)
--    Shared curation tables the /israeli-tagger and /chasidish-tagger tools read
--    and write with the anon key. INTENTIONALLY no RLS (low-value curation data,
--    attributed by `contributor`); access is governed purely by the grants below.
--    Supabase will flag them "public / RLS disabled" — that is expected.
--    build-static.mjs reads these at build time to tag artists in the baked dataset.
-- ============================================================================
create table if not exists public.israeli_artist_tag (
  channel_id  text primary key,          -- the artist's YouTube channel id (UC…)
  name        text,                       -- artist name (convenience copy)
  is_israeli  boolean not null,
  contributor text,                       -- who set it (a name/handle from the tool)
  updated_at  timestamptz not null default now()
);
create index if not exists idx_iat_updated on public.israeli_artist_tag (updated_at desc);

create table if not exists public.chasidish_artist_tag (
  channel_id    text primary key,          -- the artist's YouTube channel id (UC…)
  name          text,                       -- artist name (convenience copy)
  is_chasidish  boolean not null,
  contributor   text,                       -- who set it (a name/handle from the tool)
  updated_at    timestamptz not null default now()
);
create index if not exists idx_cat_updated on public.chasidish_artist_tag (updated_at desc);


-- ============================================================================
-- ============================================================================
--  SECURITY MODEL  (read before touching the policies below)
--
--  PUBLIC-READABLE / anon-writable:
--    * zemer_analytics  — anon may INSERT (the beacon); only admins may SELECT.
--    * israeli_artist_tag / chasidish_artist_tag — anon may SELECT+INSERT+UPDATE
--        +DELETE (RLS disabled by design; grant-governed).
--    * top_songs / top_artists / play_analytics / search_analytics — anon may
--        EXECUTE; SECURITY DEFINER so they aggregate zemer_analytics WITHOUT
--        exposing the raw rows.
--
--  OWNER-ONLY:
--    * zemer_like — each user reads/writes only their own rows (RLS).
--
--  PARENTAL HARD LOCK (zemer_user):
--    RLS scopes a user to their OWN row, but that alone is not enough — a kid
--    signed into the account could PATCH parental_lock=false via the REST API and
--    unlock themselves. So direct UPDATE/DELETE are REVOKED (only `recents` is
--    writable), SELECT of the secret columns (pin_hash, pin state) is REVOKED, and
--    every protected mutation must go through a pc_* SECURITY DEFINER function that
--    verifies the PIN first. Postgres enforces the gate; there is no client bypass.
-- ============================================================================
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 6. RLS — analytics + admin
-- ---------------------------------------------------------------------------
alter table public.zemer_analytics enable row level security;
alter table public.zemer_admin     enable row level security;

-- Anyone (the anon key the Worker uses) may INSERT analytics rows.
drop policy if exists "anon can insert" on public.zemer_analytics;
create policy "anon can insert" on public.zemer_analytics
  for insert to anon, authenticated
  with check (true);

-- Admin membership check — SECURITY DEFINER so it can read zemer_admin regardless
-- of the caller's own RLS.
create or replace function public.is_zemer_admin()
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (select 1 from public.zemer_admin where email = auth.jwt() ->> 'email');
$$;

-- Only admins (email in zemer_admin) may SELECT raw analytics rows.
drop policy if exists "authenticated can select" on public.zemer_analytics;
drop policy if exists "admins can select"        on public.zemer_analytics;
create policy "admins can select" on public.zemer_analytics
  for select to authenticated
  using (public.is_zemer_admin());

-- A signed-in user may read their OWN admin row (so the dashboard can confirm membership).
drop policy if exists "read own admin row" on public.zemer_admin;
create policy "read own admin row" on public.zemer_admin
  for select to authenticated
  using ((auth.jwt() ->> 'email') = email);


-- ---------------------------------------------------------------------------
-- 7. RLS — likes (own rows only)
-- ---------------------------------------------------------------------------
alter table public.zemer_like enable row level security;
drop policy if exists "own likes" on public.zemer_like;
create policy "own likes" on public.zemer_like
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- 8. RLS + column locks — zemer_user (the PARENTAL HARD LOCK)
-- ---------------------------------------------------------------------------
alter table public.zemer_user enable row level security;

-- Take away direct write on the row; hand back ONLY `recents` (safe to sync freely).
revoke update, delete on public.zemer_user from authenticated;
grant  update (recents) on public.zemer_user to authenticated;

-- Take away SELECT *; hand back every column EXCEPT the secrets (pin_hash + lock
-- state), so the hash can never be pulled client-side and offline-cracked.
revoke select on public.zemer_user from authenticated;
grant  select (id, email, parental_lock, filters, artist_mode, artist_ids,
               kid_only, kid_add, kid_remove, recents, created_at, updated_at)
  on public.zemer_user to authenticated;

-- Row scoping stays via RLS (own row only): read own row, update own row (the
-- update is further constrained to `recents` by the column grant above).
drop policy if exists "own profile"    on public.zemer_user;   -- pre-hardlock policy, if present
drop policy if exists "own row read"    on public.zemer_user;
drop policy if exists "own row recents" on public.zemer_user;
create policy "own row read"    on public.zemer_user for select to authenticated using (id = auth.uid());
create policy "own row recents" on public.zemer_user for update to authenticated using (id = auth.uid()) with check (id = auth.uid());


-- ============================================================================
-- 9. ACCOUNT LIFECYCLE — auto-create a profile row for every auth user
-- ============================================================================
-- Trigger: create the profile row on signup.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.zemer_user (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Belt-and-suspenders: client-callable RPC that creates the caller's profile if the
-- trigger never fired. The client calls this on every login. ON CONFLICT DO NOTHING.
create or replace function public.ensure_profile()
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.zemer_user (id, email)
  values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()))
  on conflict (id) do nothing;
end $$;

-- Backfill any existing auth users missing a profile row.
insert into public.zemer_user (id, email)
select u.id, u.email from auth.users u
left join public.zemer_user z on z.id = u.id
where z.id is null;


-- ============================================================================
-- 10. LIKES RPCs
-- ============================================================================
-- Read the signed-in user's likes, newest first (loaded once on login into a Set).
create or replace function public.get_my_likes(lim int default 1000)
returns table (video_id text, title text, artist text, added_at timestamptz)
language sql security invoker stable as $$
  select video_id, title, artist, added_at
  from public.zemer_like
  where user_id = auth.uid()
  order by added_at desc
  limit greatest(1, least(5000, lim));
$$;

-- Toggle a like in one call — inserts if missing, removes if present. Returns the
-- new state (true = now liked).
create or replace function public.toggle_like(p_video_id text, p_title text default null, p_artist text default null)
returns boolean
language plpgsql security invoker as $$
begin
  delete from public.zemer_like where user_id = auth.uid() and video_id = p_video_id;
  if found then return false; end if;                 -- was liked → now unliked
  insert into public.zemer_like (user_id, video_id, title, artist)
    values (auth.uid(), p_video_id, p_title, p_artist);
  return true;                                         -- now liked
end $$;


-- ============================================================================
-- 11. PARENTAL-CONTROL RPCs (the only way to mutate the protected columns)
--     All SECURITY DEFINER; they own the columns the app revoked from clients.
-- ============================================================================

-- PIN check + failure counter + escalating lockout. INTERNAL ONLY (execute is
-- revoked from every client role); the pc_* wrappers below call it.
create or replace function public.pc_check_pin(p_pin text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare u public.zemer_user;
begin
  select * into u from public.zemer_user where id = auth.uid();
  if u.id is null then return false; end if;
  if u.pin_hash is null then return true; end if;                          -- no PIN set → open
  if u.pin_locked_until is not null and u.pin_locked_until > now() then
    raise exception 'PIN locked — too many attempts. Try again later.';
  end if;
  if u.pin_hash = extensions.crypt(coalesce(p_pin, ''), u.pin_hash) then    -- correct → reset counter + clear lockout
    update public.zemer_user set pin_fails = 0, pin_locked_until = null where id = u.id and pin_fails <> 0;
    return true;
  end if;
  update public.zemer_user                                                  -- wrong → count; lock after 5, escalating
     set pin_fails = pin_fails + 1,
         pin_locked_until = case when pin_fails + 1 >= 5
           then now() + make_interval(secs => least(900, (30 * power(2, pin_fails + 1 - 5))::int))  -- 30s,60s… cap 15m
           else pin_locked_until end
   where id = u.id;
  return false;
end $$;
revoke execute on function public.pc_check_pin(text) from public, anon, authenticated;  -- internal only

-- Read own settings (never the hash). Returns has_pin instead of pin_hash, plus a
-- live lockout countdown (locked_secs).
create or replace function public.pc_get()
returns jsonb language sql security definer set search_path = '' stable as $$
  select jsonb_build_object(
    'has_pin',       u.pin_hash is not null,
    'parental_lock', u.parental_lock,
    'filters',       u.filters,
    'artist_mode',   u.artist_mode,
    'artist_ids',    u.artist_ids,
    'kid_only',      u.kid_only,
    'kid_add',       u.kid_add,
    'kid_remove',    u.kid_remove,
    'recents',       u.recents,
    'locked_secs',   greatest(0, ceil(extract(epoch from coalesce(u.pin_locked_until, now()) - now())))::int
  ) from public.zemer_user u where u.id = auth.uid();
$$;

-- Verify a PIN (the unlock screen).
create or replace function public.pc_verify(p_pin text)
returns boolean language sql security definer set search_path = '' as $$
  select public.pc_check_pin(p_pin);
$$;

-- Change protected settings (PIN-gated). p_patch may carry any of:
-- parental_lock, filters, artist_mode, artist_ids, kid_only, kid_add, kid_remove.
create or replace function public.pc_update(p_pin text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.pc_check_pin(p_pin) then raise exception 'Incorrect PIN.'; end if;
  if p_patch ? 'artist_mode' and (p_patch->>'artist_mode') not in ('all','only','except') then
    raise exception 'bad artist_mode';
  end if;
  update public.zemer_user u set
    parental_lock = coalesce((p_patch->>'parental_lock')::boolean, u.parental_lock),
    filters       = coalesce(p_patch->'filters',              u.filters),
    artist_mode   = coalesce(p_patch->>'artist_mode',         u.artist_mode),
    artist_ids    = coalesce(p_patch->'artist_ids',           u.artist_ids),
    kid_only      = coalesce((p_patch->>'kid_only')::boolean, u.kid_only),
    kid_add       = coalesce(p_patch->'kid_add',              u.kid_add),
    kid_remove    = coalesce(p_patch->'kid_remove',           u.kid_remove),
    updated_at    = now()
   where u.id = auth.uid();
  return public.pc_get();
end $$;

-- Set / change the PIN. No PIN yet → sets one (p_old_pin ignored). PIN exists →
-- requires the correct current PIN. Setting a PIN also turns parental_lock on.
create or replace function public.pc_set_pin(p_new_pin text, p_old_pin text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cur text;
begin
  select pin_hash into cur from public.zemer_user where id = auth.uid();
  if cur is not null and not public.pc_check_pin(p_old_pin) then raise exception 'Incorrect current PIN.'; end if;
  if p_new_pin !~ '^\d{4,8}$' then raise exception 'PIN must be 4-8 digits.'; end if;
  update public.zemer_user
     set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10)),
         parental_lock = true, pin_fails = 0, pin_locked_until = null, updated_at = now()
   where id = auth.uid();
  return public.pc_get();
end $$;

-- Clear the PIN (needs the current PIN). Also releases the parental_lock.
create or replace function public.pc_clear_pin(p_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.pc_check_pin(p_pin) then raise exception 'Incorrect PIN.'; end if;
  update public.zemer_user set pin_hash = null, parental_lock = false, pin_fails = 0, pin_locked_until = null, updated_at = now()
   where id = auth.uid();
  return public.pc_get();
end $$;


-- ============================================================================
-- 12. TRENDING + ANALYTICS-REPORTING RPCs
--     Aggregate-only (counts, no raw rows). SECURITY DEFINER so the public anon
--     key can call them WITHOUT exposing zemer_analytics. The Worker /trending
--     route calls top_songs/top_artists; the dashboard can call the others.
-- ============================================================================

-- Top played songs over the last N days. Dedupes by videoId (keeps the latest
-- title/artist seen). Counts only QUALIFIED plays — the client's play event fires
-- on END with real listen time and `qualified` (a 2-second skip is qualified=false).
-- Rows written before that change have no `qualified` key → coalesce to 'true' so
-- historical data still counts.
create or replace function public.top_songs(days int default 30, lim int default 24)
returns table (video_id text, title text, artist text, plays bigint)
language sql security definer set search_path = public stable as $$
  select meta->>'v' as video_id,
    (array_agg(meta->>'title'  order by created_at desc))[1] as title,
    (array_agg(meta->>'artist' order by created_at desc))[1] as artist,
    count(*)::bigint as plays
  from public.zemer_analytics
  where event = 'play'
    and created_at >= now() - (days * interval '1 day')
    and coalesce(meta->>'qualified', 'true') <> 'false'
    and coalesce(meta->>'v', '') <> '' and coalesce(meta->>'title', '') <> '' and coalesce(meta->>'artist', '') <> ''
  group by meta->>'v'
  order by plays desc, max(created_at) desc
  limit greatest(1, least(100, lim));
$$;

-- Top played artists over the last N days (qualified plays).
create or replace function public.top_artists(days int default 30, lim int default 20)
returns table (artist text, plays bigint)
language sql security definer set search_path = public stable as $$
  select meta->>'artist' as artist, count(*)::bigint as plays
  from public.zemer_analytics
  where event = 'play' and created_at >= now() - (days * interval '1 day')
    and coalesce(meta->>'qualified', 'true') <> 'false'
    and coalesce(meta->>'artist', '') <> ''
  group by meta->>'artist'
  order by plays desc, max(created_at) desc
  limit greatest(1, least(100, lim));
$$;

-- Listen-quality summary + where listens START (play.source attribution) — one row
-- per source. (Reporting helper; not required for the home rails.)
create or replace function public.play_analytics(days int default 30)
returns table (source text, plays bigint, qualified_plays bigint, listen_hours numeric)
language sql security definer set search_path = public stable as $$
  select coalesce(nullif(meta->>'source', ''), 'other') as source,
    count(*)::bigint as plays,
    count(*) filter (where coalesce(meta->>'qualified', 'true') <> 'false')::bigint as qualified_plays,
    round(sum(coalesce((meta->>'seconds')::numeric, 0)) / 3600.0, 1) as listen_hours
  from public.zemer_analytics
  where event = 'play' and created_at >= now() - (days * interval '1 day')
  group by 1
  order by plays desc;
$$;

-- Search relevance: click-through rate + average clicked rank (lower avg rank =
-- users click the top results = good ranking). Search-result clicks carry
-- meta.rank (0-based) and meta.kind.
create or replace function public.search_analytics(days int default 30)
returns table (searches bigint, clicks bigint, ctr numeric, avg_click_rank numeric)
language sql security definer set search_path = public stable as $$
  with s as (select count(*)::numeric n from public.zemer_analytics
             where event = 'search' and created_at >= now() - (days * interval '1 day')),
       c as (select count(*)::numeric n, avg((meta->>'rank')::numeric) r from public.zemer_analytics
             where event = 'click' and created_at >= now() - (days * interval '1 day') and (meta->>'rank') ~ '^\d+$')
  select s.n::bigint, c.n::bigint,
    case when s.n > 0 then round(c.n / s.n, 3) else 0 end,
    round(coalesce(c.r, 0), 2)
  from s, c;
$$;


-- ============================================================================
-- 13. ARTIST-TAG TABLE PLUMBING (touch triggers + open grants, no RLS)
-- ============================================================================
-- Keep updated_at fresh on every insert/update (also advances on upsert).
create or replace function public.iat_touch() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists iat_touch on public.israeli_artist_tag;
create trigger iat_touch before insert or update on public.israeli_artist_tag
  for each row execute function public.iat_touch();

create or replace function public.cat_touch() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists cat_touch on public.chasidish_artist_tag;
create trigger cat_touch before insert or update on public.chasidish_artist_tag
  for each row execute function public.cat_touch();

-- Open access (no row-level security), governed by grants only.
alter table public.israeli_artist_tag   disable row level security;
alter table public.chasidish_artist_tag disable row level security;
grant select, insert, update, delete on public.israeli_artist_tag   to anon, authenticated;
grant select, insert, update, delete on public.chasidish_artist_tag to anon, authenticated;


-- ============================================================================
-- 14. GRANTS (function execute privileges)
-- ============================================================================
-- Aggregate/report RPCs — callable with the public anon key.
grant execute on function public.top_songs(int, int)   to anon, authenticated;
grant execute on function public.top_artists(int, int) to anon, authenticated;
grant execute on function public.play_analytics(int)   to anon, authenticated;
grant execute on function public.search_analytics(int) to anon, authenticated;

-- Account + parental RPCs — signed-in users only. (pc_check_pin stays internal.)
grant execute on function public.ensure_profile()                    to authenticated;
grant execute on function public.get_my_likes(int)                   to authenticated;
grant execute on function public.toggle_like(text, text, text)       to authenticated;
grant execute on function public.pc_get()                            to authenticated;
grant execute on function public.pc_verify(text)                     to authenticated;
grant execute on function public.pc_update(text, jsonb)              to authenticated;
grant execute on function public.pc_set_pin(text, text)              to authenticated;
grant execute on function public.pc_clear_pin(text)                  to authenticated;


-- ============================================================================
-- 15. MIGRATION HOUSEKEEPING (safe on a fresh DB; fixes an older one)
-- ============================================================================
-- The pre-hardlock "soft" version stored a client-side SHA-256 PIN that can't
-- verify with bcrypt crypt(). Clear any non-bcrypt hash so parents simply re-set
-- the PIN under the new scheme. (bcrypt hashes start with "$2".)
update public.zemer_user set pin_hash = null where pin_hash is not null and pin_hash !~ '^\$2';


-- ============================================================================
-- 16. SEED — grant yourself dashboard access
--     Also add this email under Supabase → Authentication → Users so you can sign in.
-- ============================================================================
insert into public.zemer_admin (email) values ('nate.karr@ontargetaba.com') on conflict do nothing;
-- TODO: verify — replace/add the admin email(s) that should reach the /analytics dashboard.
