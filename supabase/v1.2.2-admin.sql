-- ============================================================================
-- SK Music 1.2.2 — admin console (/admin)
--
-- Run AFTER schema.sql, v1.1.0-features.sql and v1.1.2-playlists.sql.
-- Idempotent: safe to re-run.
--
-- THREAT MODEL — read this before changing anything below.
--   The Supabase anon key ships in the client. Anyone can read admin.html, lift
--   the key, and call the REST API directly. So NOTHING here may rely on the UI
--   hiding a button. Every function is SECURITY DEFINER and re-checks
--   is_zemer_admin() itself, on every call, server-side. That check — membership
--   in public.zemer_admin, keyed on the caller's identity from the verified JWT,
--   never from a parameter — is the only thing standing between a signed-in
--   stranger and every user's row. (v1.2.4 re-keys it from the mutable `email`
--   claim to auth.uid(); run that migration too.)
--
--   Consequences that shaped the design:
--     · pin_hash is NEVER returned by any function here. Admins get has_pin
--       (boolean) only, exactly like pc_get() does for the user themselves.
--       An admin can CLEAR a PIN (a parent locked out of their own account) but
--       can never read or set one, so they cannot impersonate the parent gate.
--     · Writes are whitelisted per column. admin_set_user takes a jsonb patch but
--       only ever reads known keys out of it, so a crafted patch cannot reach
--       pin_hash, id or email.
--     · Every write is logged to zemer_admin_audit with the acting admin, the
--       target, and the before/after. One user editing another user's parental
--       controls without a trail is not something that should exist.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Audit trail for admin writes.
-- ---------------------------------------------------------------------------
create table if not exists public.zemer_admin_audit (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  admin_email text not null,
  target_user uuid not null,
  action      text not null,          -- 'set_user' | 'clear_pin'
  before      jsonb,
  after       jsonb
);
create index if not exists idx_zaa_created on public.zemer_admin_audit (created_at desc);
create index if not exists idx_zaa_target  on public.zemer_admin_audit (target_user, created_at desc);

alter table public.zemer_admin_audit enable row level security;
-- No policy = no direct access for anon/authenticated. The RPCs below are
-- SECURITY DEFINER and bypass RLS; that is the only intended read path.
revoke all on public.zemer_admin_audit from anon, authenticated;


-- ---------------------------------------------------------------------------
-- Guard helper — raises rather than returning empty, so a non-admin caller gets
-- a hard error instead of silently seeing "no users" and thinking it worked.
-- ---------------------------------------------------------------------------
create or replace function public.admin_guard()
returns void
language plpgsql security definer set search_path = '' stable as $$
begin
  if not public.is_zemer_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_list_users — the console's main table.
-- p_q filters on email or display name (case-insensitive, substring).
-- Ordered newest-first. pin_hash is deliberately absent; has_pin replaces it.
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_users(
  p_q      text default null,
  p_limit  int  default 100,
  p_offset int  default 0
)
returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare
  v_rows  jsonb;
  v_total bigint;
  v_lim   int := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_off   int := greatest(coalesce(p_offset, 0), 0);
  v_q     text := nullif(btrim(coalesce(p_q, '')), '');
begin
  perform public.admin_guard();

  select count(*) into v_total
  from public.zemer_user zu
  left join auth.users au on au.id = zu.id
  where v_q is null
     or zu.email ilike '%' || v_q || '%'
     or coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '') ilike '%' || v_q || '%';

  select coalesce(jsonb_agg(r order by r_created desc), '[]'::jsonb) into v_rows
  from (
    select
      jsonb_build_object(
        'id',               zu.id,
        'email',            zu.email,
        'name',             coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name'),
        'provider',         au.raw_app_meta_data ->> 'provider',
        'filters',          zu.filters,
        'artist_mode',      zu.artist_mode,
        'artist_count',     coalesce(jsonb_array_length(zu.artist_ids), 0),
        'kid_only',         zu.kid_only,
        'kid_add_count',    coalesce(jsonb_array_length(zu.kid_add), 0),
        'kid_remove_count', coalesce(jsonb_array_length(zu.kid_remove), 0),
        'parental_lock',    zu.parental_lock,
        'has_pin',          (zu.pin_hash is not null),   -- never the hash itself
        'pin_fails',        zu.pin_fails,
        'pin_locked_until', zu.pin_locked_until,
        'recents_count',    coalesce(jsonb_array_length(zu.recents), 0),
        'likes_count',      (select count(*) from public.zemer_like zl where zl.user_id = zu.id),
        'created_at',       zu.created_at,
        'updated_at',       zu.updated_at,
        'last_sign_in_at',  au.last_sign_in_at,
        'email_confirmed',  (au.email_confirmed_at is not null)
      ) as r,
      zu.created_at as r_created
    from public.zemer_user zu
    left join auth.users au on au.id = zu.id
    where v_q is null
       or zu.email ilike '%' || v_q || '%'
       or coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name', '') ilike '%' || v_q || '%'
    order by zu.created_at desc
    limit v_lim offset v_off
  ) s;

  return jsonb_build_object('total', v_total, 'limit', v_lim, 'offset', v_off, 'users', v_rows);
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_user_detail — one user, plus what they've been listening to.
--
-- Returns `recents` (the recently-played list the app syncs) and the likes table.
-- The real per-song play history lives in admin_user_history (v1.2.3), which reads
-- the account-attributed analytics rows; it is a separate call so a large history
-- doesn't hold up this panel.
-- ---------------------------------------------------------------------------
create or replace function public.admin_user_detail(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare v_out jsonb;
begin
  perform public.admin_guard();

  select jsonb_build_object(
    'id',               zu.id,
    'email',            zu.email,
    'name',             coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name'),
    'provider',         au.raw_app_meta_data ->> 'provider',
    'filters',          zu.filters,
    'artist_mode',      zu.artist_mode,
    'artist_ids',       zu.artist_ids,
    'kid_only',         zu.kid_only,
    'kid_add',          zu.kid_add,
    'kid_remove',       zu.kid_remove,
    'parental_lock',    zu.parental_lock,
    'has_pin',          (zu.pin_hash is not null),
    'pin_fails',        zu.pin_fails,
    'pin_locked_until', zu.pin_locked_until,
    'created_at',       zu.created_at,
    'updated_at',       zu.updated_at,
    'last_sign_in_at',  au.last_sign_in_at,
    'recents',          zu.recents,
    'likes', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'video_id', zl.video_id, 'title', zl.title,
                'artist', zl.artist, 'added_at', zl.added_at)
              order by zl.added_at desc), '[]'::jsonb)
      from (select * from public.zemer_like where user_id = zu.id order by added_at desc limit 200) zl
    ),
    'audit', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'at', a.created_at, 'admin', a.admin_email, 'action', a.action)
              order by a.created_at desc), '[]'::jsonb)
      from (select * from public.zemer_admin_audit where target_user = zu.id order by created_at desc limit 50) a
    )
  ) into v_out
  from public.zemer_user zu
  left join auth.users au on au.id = zu.id
  where zu.id = p_user;

  if v_out is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;
  return v_out;
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_set_user — edit a user's settings on their behalf.
--
-- The patch is READ KEY BY KEY, never merged wholesale, so an attacker-supplied
-- key (pin_hash, id, email) has no path into the UPDATE. Absent keys are left
-- untouched. `filters` replaces wholesale, matching pc_update's semantics, so
-- the caller must send the complete object.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user(p_user uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after  jsonb;
  v_admin  text := auth.jwt() ->> 'email';
begin
  perform public.admin_guard();
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'bad patch' using errcode = '22023';
  end if;

  select to_jsonb(zu) - 'pin_hash' into v_before from public.zemer_user zu where zu.id = p_user;
  if v_before is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  update public.zemer_user zu set
    filters       = case when p_patch ? 'filters'       then p_patch -> 'filters'                 else zu.filters       end,
    artist_mode   = case when p_patch ? 'artist_mode'   then p_patch ->> 'artist_mode'            else zu.artist_mode   end,
    artist_ids    = case when p_patch ? 'artist_ids'    then p_patch -> 'artist_ids'              else zu.artist_ids    end,
    kid_only      = case when p_patch ? 'kid_only'      then (p_patch ->> 'kid_only')::boolean    else zu.kid_only      end,
    kid_add       = case when p_patch ? 'kid_add'       then p_patch -> 'kid_add'                 else zu.kid_add       end,
    kid_remove    = case when p_patch ? 'kid_remove'    then p_patch -> 'kid_remove'              else zu.kid_remove    end,
    parental_lock = case when p_patch ? 'parental_lock' then (p_patch ->> 'parental_lock')::boolean else zu.parental_lock end,
    updated_at    = now()
  where zu.id = p_user;

  -- artist_mode is a closed set; a bad value would silently break the client gate.
  if (select artist_mode from public.zemer_user where id = p_user) not in ('all', 'only', 'except') then
    raise exception 'bad artist_mode' using errcode = '22023';
  end if;

  select to_jsonb(zu) - 'pin_hash' into v_after from public.zemer_user zu where zu.id = p_user;
  insert into public.zemer_admin_audit (admin_email, target_user, action, before, after)
  values (coalesce(v_admin, '?'), p_user, 'set_user', v_before, v_after);

  return v_after;
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_clear_pin — for a parent locked out of their own controls.
-- Clears the hash and the brute-force counters. An admin can never SET a PIN,
-- only remove one, so this cannot be used to lock a user out of their account.
-- ---------------------------------------------------------------------------
create or replace function public.admin_clear_pin(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_admin text := auth.jwt() ->> 'email';
begin
  perform public.admin_guard();
  if not exists (select 1 from public.zemer_user where id = p_user) then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  update public.zemer_user
     set pin_hash = null, pin_fails = 0, pin_locked_until = null, parental_lock = false, updated_at = now()
   where id = p_user;

  insert into public.zemer_admin_audit (admin_email, target_user, action, before, after)
  values (coalesce(v_admin, '?'), p_user, 'clear_pin', jsonb_build_object('has_pin', true), jsonb_build_object('has_pin', false));

  return jsonb_build_object('ok', true);
end;
$$;


-- ---------------------------------------------------------------------------
-- Grants. `authenticated` only — anon can never reach these, and every function
-- re-checks admin membership regardless of who holds the grant.
-- ---------------------------------------------------------------------------
revoke all on function public.admin_guard()                     from public, anon;
revoke all on function public.admin_list_users(text, int, int)   from public, anon;
revoke all on function public.admin_user_detail(uuid)            from public, anon;
revoke all on function public.admin_set_user(uuid, jsonb)        from public, anon;
revoke all on function public.admin_clear_pin(uuid)              from public, anon;

grant execute on function public.admin_list_users(text, int, int) to authenticated;
grant execute on function public.admin_user_detail(uuid)          to authenticated;
grant execute on function public.admin_set_user(uuid, jsonb)      to authenticated;
grant execute on function public.admin_clear_pin(uuid)            to authenticated;
