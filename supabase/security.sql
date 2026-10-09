-- ============================================================================
-- SK Music — anti-scraping / abuse security layer (database side).
--
-- WHY
--   The Worker now rate-limits, datacenter-blocks and temporarily bans abusive clients. It needs a
--   shared, durable place for: the admin allowlist (IPs / emails that are never limited), the ban list
--   (with escalation history), and an event log the admin dashboard can read. Separately, content
--   reports had no per-account cap (a script with one account could flood zemer_content_report), and
--   bot plays were shaping the public trending rails.
--
-- WHAT
--   Tables (RLS on, NO policies, all client privileges revoked — only the functions below touch them):
--     security_config     single row: sha256 hex of the Worker's shared token (SEC_TOKEN)
--     security_allowlist  (kind 'ip'|'email', value) — never limited, banned or datacenter-blocked
--     security_bans       bans by ip and/or user_id, with escalation level (+ lifted_by_admin)
--     security_events     rate_limited / datacenter_block / banned_hit / auto_ban / report_blocked
--     security_contacts   unblock requests sent by blocked people via the Worker's /unblock-request
--   Worker RPCs (EXECUTE to anon; each requires p_token whose sha256 matches security_config, else
--   raises 'forbidden'):
--     security_state(p_token)                                   -> {allow_ips, allow_emails, bans}
--     security_log(p_token, p_events)                           -> rows written (max 50 per call)
--     security_ban(p_token, p_ip, p_user_id, p_email, p_reason) -> {id, until, level}
--       level = 1 + ALL-TIME prior bans for the same ip/user NOT lifted by an admin:
--       1 = 15 min, 2 = 1 h, 3 = 24 h, 4+ = permanent (until = 'infinity', JSON "infinity").
--     security_contact(p_token, p_ip, p_user_id, p_email, p_message, p_block_reason)
--                                                               -> {ok:true,id} | {ok:false,reason}
--       caps: 5 per ip per 24 h, 300 total per 24 h (reason "limit").
--   Admin RPCs (EXECUTE to authenticated; each requires public.is_zemer_admin()):
--     security_overview(p_hours), security_allow_add(p_kind, p_value, p_note),
--     security_allow_remove(p_id), security_unban(p_id) (also marks lifted_by_admin),
--     security_contact_resolve(p_id)
--   Setup (NOT executable by anon/authenticated — owner runs it in the SQL editor):
--     security_set_token(p_token)
--   submit_report(): now SECURITY DEFINER with per-account caps — 10/hour, 30/day, accounts younger
--     than 24 h 3/day; the same account reporting the same video again within 24 h silently succeeds
--     without inserting. Over-cap writes a `report_blocked` security_event (see NOTE below).
--   top_songs / top_artists / artist_top_songs: exclude bot rows (zemer_analytics.is_bot).
--
-- NOTE — over-cap reports
--   An event row written inside a function that then RAISEs is rolled back with it (PostgREST runs each
--   RPC in one transaction; Postgres has no autonomous transactions). So an over-cap report is refused
--   SILENTLY — nothing inserted, `report_blocked` event recorded, the call returns normally — exactly
--   like the duplicate case. That is the only way the admin's report_blocks counter can be real, and
--   it also doesn't reveal the cap to a bot.
--
-- SHA-256
--   Uses core pg_catalog.sha256(bytea) (Postgres 11+), which gives the same digest as
--   pgcrypto's extensions.digest(text, 'sha256') — no extension dependency.
--
-- APPLY (order matters)
--   Run AFTER analytics-bot-split.sql (adds zemer_analytics.is_bot) and artist-top-songs.sql.
--   This file refuses to run (and changes nothing) if the is_bot column is missing.
--   SQL Editor -> paste -> Run. Idempotent: safe to re-run.
--   Then, ONCE, set the Worker's shared token (same value as the Worker secret SEC_TOKEN):
--     select public.security_set_token('<the SEC_TOKEN value>');
--   Until that runs, the four Worker RPCs raise 'forbidden' (the Worker fails open).
-- ============================================================================

-- 0) Require the bot-split migration.
do $$ begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'zemer_analytics' and column_name = 'is_bot') then
    raise exception 'security.sql requires zemer_analytics.is_bot — run supabase/analytics-bot-split.sql first, then re-run this file.';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 1) Tables
-- ---------------------------------------------------------------------------
create table if not exists public.security_config (
  id           int primary key check (id = 1),
  token_sha256 text
);

create table if not exists public.security_allowlist (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('ip', 'email')),
  value      text not null,
  note       text,
  created_at timestamptz not null default now(),
  unique (kind, value)
);

create table if not exists public.security_bans (
  id         bigint generated always as identity primary key,
  ip         text,
  user_id    uuid,
  email      text,
  reason     text,
  level      int not null default 1,
  created_at timestamptz not null default now(),
  until      timestamptz not null,
  check (ip is not null or user_id is not null)
);
create index if not exists idx_security_bans_until   on public.security_bans (until);
create index if not exists idx_security_bans_ip      on public.security_bans (ip, created_at);
create index if not exists idx_security_bans_user_id on public.security_bans (user_id, created_at);
-- A ban an admin lifted is a false positive: it never counts toward escalation.
alter table public.security_bans add column if not exists lifted_by_admin boolean not null default false;

-- Unblock requests from blocked people (the Worker's /unblock-request form).
create table if not exists public.security_contacts (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  ip           text,
  user_id      uuid,
  email        text,
  message      text,
  ban_id       bigint,
  block_reason text,
  status       text not null default 'open' check (status in ('open', 'handled')),
  handled_at   timestamptz
);
create index if not exists idx_security_contacts_created_at on public.security_contacts (created_at);
create index if not exists idx_security_contacts_ip         on public.security_contacts (ip, created_at);
create index if not exists idx_security_contacts_open       on public.security_contacts (created_at) where status = 'open';

create table if not exists public.security_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind       text not null,
  ip         text,
  user_id    uuid,
  email      text,
  asn        int,
  as_org     text,
  path       text,
  ua         text,
  detail     jsonb
);
create index if not exists idx_security_events_created_at on public.security_events (created_at);
create index if not exists idx_security_events_ip         on public.security_events (ip);
create index if not exists idx_security_events_user_id    on public.security_events (user_id);

alter table public.security_config    enable row level security;
alter table public.security_allowlist enable row level security;
alter table public.security_bans      enable row level security;
alter table public.security_events    enable row level security;
alter table public.security_contacts  enable row level security;

-- Defense in depth: RLS default-deny is not the only barrier.
revoke all on public.security_config    from public, anon, authenticated;
revoke all on public.security_allowlist from public, anon, authenticated;
revoke all on public.security_bans      from public, anon, authenticated;
revoke all on public.security_events    from public, anon, authenticated;
revoke all on public.security_contacts  from public, anon, authenticated;
revoke all on sequence public.security_contacts_id_seq  from public, anon, authenticated;
revoke all on sequence public.security_allowlist_id_seq from public, anon, authenticated;
revoke all on sequence public.security_bans_id_seq      from public, anon, authenticated;
revoke all on sequence public.security_events_id_seq    from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2) Internal helpers (not callable from the API)
-- ---------------------------------------------------------------------------
-- Raises 'forbidden' unless p_token hashes to the stored token. Never logs the token.
create or replace function public.security_require_token(p_token text)
returns void
language plpgsql security definer set search_path = public stable
as $$
declare v_hash text;
begin
  select token_sha256 into v_hash from public.security_config where id = 1;
  if v_hash is null or p_token is null or p_token = ''
     or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') <> v_hash then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

-- Canonical text for a single host address (v4 or v6), or null if not one. Rejects CIDR ranges.
create or replace function public.security_norm_ip(p_ip text)
returns text
language plpgsql immutable set search_path = public
as $$
declare v inet;
begin
  if p_ip is null or btrim(p_ip) = '' or length(p_ip) > 64 then return null; end if;
  v := btrim(p_ip)::inet;
  if (family(v) = 4 and masklen(v) <> 32) or (family(v) = 6 and masklen(v) <> 128) then return null; end if;
  return host(v);
exception when others then
  return null;
end $$;

revoke all on function public.security_require_token(text) from public, anon, authenticated;
revoke all on function public.security_norm_ip(text)       from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3) Setup: store the Worker token's hash (owner only, SQL editor)
-- ---------------------------------------------------------------------------
create or replace function public.security_set_token(p_token text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_token is null or length(p_token) < 16 then
    raise exception 'token must be at least 16 characters';
  end if;
  insert into public.security_config (id, token_sha256)
  values (1, encode(sha256(convert_to(p_token, 'UTF8')), 'hex'))
  on conflict (id) do update set token_sha256 = excluded.token_sha256;
end $$;

revoke all on function public.security_set_token(text) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4) Worker RPCs
-- ---------------------------------------------------------------------------
create or replace function public.security_state(p_token text)
returns jsonb
language plpgsql security definer set search_path = public stable
as $$
begin
  perform public.security_require_token(p_token);
  return jsonb_build_object(
    'allow_ips', coalesce((select jsonb_agg(value order by value) from public.security_allowlist where kind = 'ip'), '[]'::jsonb),
    'allow_emails', coalesce((select jsonb_agg(value order by value) from public.security_allowlist where kind = 'email'), '[]'::jsonb),
    'bans', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'ip', ip, 'user_id', user_id, 'until', until) order by id)
                      from public.security_bans where until > now()), '[]'::jsonb)
  );
end $$;

-- Inserts up to the first 50 events of p_events (a JSON array). Elements without a known kind are
-- skipped; malformed optional fields are stored as null; text fields are length-clamped.
create or replace function public.security_log(p_token text, p_events jsonb)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int := 0;
begin
  perform public.security_require_token(p_token);
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;

  insert into public.security_events (kind, ip, user_id, email, asn, as_org, path, ua, detail)
  select e->>'kind',
         public.security_norm_ip(e->>'ip'),
         case when (e->>'user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (e->>'user_id')::uuid end,
         left(nullif(lower(btrim(e->>'email')), ''), 320),
         case when (e->>'asn') ~ '^\d{1,9}$' then (e->>'asn')::int end,
         left(e->>'as_org', 200),
         left(e->>'path', 512),
         left(e->>'ua', 512),
         case when jsonb_typeof(e->'detail') in ('object', 'array') and length((e->'detail')::text) <= 4000
              then e->'detail' end
  from jsonb_array_elements(p_events) with ordinality as t(e, ord)
  where t.ord <= 50
    and jsonb_typeof(e) = 'object'
    and e->>'kind' in ('rate_limited', 'datacenter_block', 'banned_hit', 'auto_ban');
  get diagnostics n = row_count;

  -- Retention: opportunistic, ~1 in 200 calls.
  if random() < 0.005 then
    delete from public.security_events where created_at < now() - interval '90 days';
  end if;
  return n;
end $$;

-- Bans an ip and/or account. Level = 1 + ALL-TIME prior bans for that ip/account that an admin did not
-- lift: 1 = 15 min, 2 = 1 h, 3 = 24 h, 4+ = permanent (until = 'infinity'). If an active ban already
-- covers that ip/account (another isolate got there first), returns it unchanged instead of stacking.
create or replace function public.security_ban(p_token text, p_ip text, p_user_id uuid, p_email text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ip    text := public.security_norm_ip(p_ip);
  v_email text := left(nullif(lower(btrim(p_email)), ''), 320);
  v_prior int;
  v_level int;
  v_until timestamptz;
  v_id    bigint;
  b       public.security_bans;
begin
  perform public.security_require_token(p_token);
  if p_ip is not null and btrim(p_ip) <> '' and v_ip is null then
    raise exception 'invalid ip';
  end if;
  if v_ip is null and p_user_id is null then
    raise exception 'ip or user_id required';
  end if;

  perform pg_advisory_xact_lock(hashtext('security_ban:' || coalesce(v_ip, '')), hashtext(coalesce(p_user_id::text, '')));

  select * into b from public.security_bans
   where until > now()
     and ((v_ip is not null and ip = v_ip) or (p_user_id is not null and user_id = p_user_id))
   order by until desc limit 1;
  if found then
    return jsonb_build_object('id', b.id, 'until', b.until, 'level', b.level);
  end if;

  select count(*) into v_prior from public.security_bans
   where not lifted_by_admin
     and ((v_ip is not null and ip = v_ip) or (p_user_id is not null and user_id = p_user_id));
  v_level := v_prior + 1;
  v_until := case when v_level = 1 then now() + interval '15 minutes'
                  when v_level = 2 then now() + interval '1 hour'
                  when v_level = 3 then now() + interval '24 hours'
                  else 'infinity'::timestamptz end;

  insert into public.security_bans (ip, user_id, email, reason, level, until)
  values (v_ip, p_user_id, v_email, left(coalesce(nullif(btrim(p_reason), ''), 'rate_limit'), 200), v_level, v_until)
  returning id into v_id;

  insert into public.security_events (kind, ip, user_id, email, detail)
  values ('auto_ban', v_ip, p_user_id, v_email,
          jsonb_build_object('ban_id', v_id, 'level', v_level, 'until', v_until,
                             'reason', left(coalesce(nullif(btrim(p_reason), ''), 'rate_limit'), 200)));

  return jsonb_build_object('id', v_id, 'until', v_until, 'level', v_level);
end $$;

revoke all on function public.security_state(text)                         from public, anon, authenticated;
revoke all on function public.security_log(text, jsonb)                    from public, anon, authenticated;
revoke all on function public.security_ban(text, text, uuid, text, text)   from public, anon, authenticated;
grant execute on function public.security_state(text)                       to anon;
grant execute on function public.security_log(text, jsonb)                  to anon;
grant execute on function public.security_ban(text, text, uuid, text, text) to anon;

-- Unblock request from a blocked person, relayed by the Worker. Never raises for user input:
-- returns {"ok":true,"id"} or {"ok":false,"reason":"limit"|"invalid_message"|"invalid_email"}.
-- Caps: 5 per ip per 24 h, 300 in total per 24 h. Links the ip/account's current active ban, if any.
create or replace function public.security_contact(p_token text, p_ip text, p_user_id uuid, p_email text,
                                                   p_message text, p_block_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_ip      text := public.security_norm_ip(p_ip);
  v_email   text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_message text := btrim(coalesce(p_message, ''));
  v_ban_id  bigint;
  v_id      bigint;
begin
  perform public.security_require_token(p_token);
  if length(v_message) < 1 or length(v_message) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_message');
  end if;
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 320) then
    return jsonb_build_object('ok', false, 'reason', 'invalid_email');
  end if;

  -- Serialize so concurrent submissions can't slip past the caps (volume is tiny).
  perform pg_advisory_xact_lock(hashtext('security_contact'));
  if (select count(*) from public.security_contacts where created_at > now() - interval '24 hours') >= 300
     or (v_ip is not null and (select count(*) from public.security_contacts
                               where ip = v_ip and created_at > now() - interval '24 hours') >= 5) then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;

  if v_ip is not null or p_user_id is not null then
    select id into v_ban_id from public.security_bans
     where until > now()
       and ((v_ip is not null and ip = v_ip) or (p_user_id is not null and user_id = p_user_id))
     order by until desc, id desc limit 1;
  end if;

  insert into public.security_contacts (ip, user_id, email, message, ban_id, block_reason)
  values (v_ip, p_user_id, v_email, v_message, v_ban_id, left(nullif(btrim(p_block_reason), ''), 40))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.security_contact(text, text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.security_contact(text, text, uuid, text, text, text) to anon;


-- ---------------------------------------------------------------------------
-- 5) Admin RPCs
-- ---------------------------------------------------------------------------
-- p_hours <= 0 (or null) = all time.
create or replace function public.security_overview(p_hours int)
returns jsonb
language plpgsql security definer set search_path = public stable
as $$
declare v_since timestamptz;
begin
  if not public.is_zemer_admin() then
    raise exception 'Not authorized';
  end if;
  v_since := case when coalesce(p_hours, 0) <= 0 then '-infinity'::timestamptz
                  else now() - make_interval(hours => least(p_hours, 24 * 3650)) end;

  return jsonb_build_object(
    'events_by_kind', coalesce((
      select jsonb_agg(jsonb_build_array(kind, n) order by n desc, kind)
      from (select kind, count(*) n from public.security_events where created_at >= v_since group by kind) k), '[]'::jsonb),

    'events_hourly', coalesce((
      select jsonb_agg(jsonb_build_array(to_char(h, 'YYYY-MM-DD"T"HH24:00:00"Z"'), n) order by h)
      from (select date_trunc('hour', created_at at time zone 'UTC') h, count(*) n
            from public.security_events where created_at >= v_since group by 1) x), '[]'::jsonb),

    'flagged_ips', coalesce((
      select jsonb_agg(jsonb_build_object('ip', ip, 'events', events, 'last_seen', last_seen, 'kinds', kinds,
                                          'asn', asn, 'as_org', as_org) order by events desc, last_seen desc)
      from (select ip, count(*) events, max(created_at) last_seen,
                   to_jsonb(array_agg(distinct kind order by kind)) kinds,
                   (array_agg(asn order by created_at desc) filter (where asn is not null))[1] asn,
                   (array_agg(as_org order by created_at desc) filter (where as_org is not null))[1] as_org
            from public.security_events where created_at >= v_since and ip is not null
            group by ip order by count(*) desc, max(created_at) desc limit 50) f), '[]'::jsonb),

    'flagged_accounts', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', user_id, 'email', email, 'events', events,
                                          'last_seen', last_seen, 'kinds', kinds) order by events desc, last_seen desc)
      from (select user_id, count(*) events, max(created_at) last_seen,
                   to_jsonb(array_agg(distinct kind order by kind)) kinds,
                   (array_agg(email order by created_at desc) filter (where email is not null))[1] email
            from public.security_events where created_at >= v_since and user_id is not null
            group by user_id order by count(*) desc, max(created_at) desc limit 50) f), '[]'::jsonb),

    'active_bans', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'ip', ip, 'user_id', user_id, 'email', email, 'reason', reason,
                                          'level', level, 'created_at', created_at, 'until', until,
                                          'permanent', until = 'infinity'::timestamptz) order by created_at desc)
      from public.security_bans where until > now()), '[]'::jsonb),

    'recent_events', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'kind', kind, 'ip', ip, 'email', email,
                                          'asn', asn, 'as_org', as_org, 'path', path, 'ua', ua) order by id desc)
      from (select * from public.security_events where created_at >= v_since order by id desc limit 100) r), '[]'::jsonb),

    'allowlist', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'value', value, 'note', note, 'created_at', created_at)
                       order by created_at desc, id desc)
      from public.security_allowlist), '[]'::jsonb),

    'report_blocks', (select count(*) from public.security_events where kind = 'report_blocked' and created_at >= v_since),

    -- Contacts ignore p_hours: open requests must never fall out of view.
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'created_at', created_at, 'ip', ip, 'email', email, 'user_id', user_id,
                                          'message', message, 'ban_id', ban_id, 'block_reason', block_reason,
                                          'status', status, 'handled_at', handled_at)
                       order by (status = 'open') desc, created_at desc, id desc)
      from (select * from public.security_contacts
            order by (status = 'open') desc, created_at desc, id desc limit 200) c), '[]'::jsonb),

    'contacts_open', (select count(*) from public.security_contacts where status = 'open')
  );
end $$;

-- kind 'ip' | 'email'. Email lowercased/trimmed; ip must be a single v4/v6 address (stored canonical).
-- Upserts on (kind, value): re-adding updates the note. Returns the row id.
create or replace function public.security_allow_add(p_kind text, p_value text, p_note text)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare v_kind text := lower(btrim(coalesce(p_kind, ''))); v_value text; v_id bigint;
begin
  if not public.is_zemer_admin() then
    raise exception 'Not authorized';
  end if;
  if v_kind = 'ip' then
    v_value := public.security_norm_ip(p_value);
    if v_value is null then raise exception 'invalid ip'; end if;
  elsif v_kind = 'email' then
    v_value := lower(btrim(coalesce(p_value, '')));
    if v_value !~ '^[^@\s]+@[^@\s]+$' or length(v_value) > 320 then raise exception 'invalid email'; end if;
  else
    raise exception 'kind must be ip or email';
  end if;

  insert into public.security_allowlist (kind, value, note)
  values (v_kind, v_value, left(nullif(btrim(p_note), ''), 500))
  on conflict (kind, value) do update set note = excluded.note
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.security_allow_remove(p_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_zemer_admin() then
    raise exception 'Not authorized';
  end if;
  delete from public.security_allowlist where id = p_id;
end $$;

-- Ends a ban now and marks it lifted_by_admin (a false positive: it never counts toward escalation).
-- Marking an already-expired ban also clears it from the offender's escalation history.
create or replace function public.security_unban(p_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_zemer_admin() then
    raise exception 'Not authorized';
  end if;
  update public.security_bans set until = least(until, now()), lifted_by_admin = true where id = p_id;
end $$;

create or replace function public.security_contact_resolve(p_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_zemer_admin() then
    raise exception 'Not authorized';
  end if;
  update public.security_contacts set status = 'handled', handled_at = coalesce(handled_at, now()) where id = p_id;
end $$;

revoke all on function public.security_overview(int)               from public, anon, authenticated;
revoke all on function public.security_allow_add(text, text, text) from public, anon, authenticated;
revoke all on function public.security_allow_remove(bigint)        from public, anon, authenticated;
revoke all on function public.security_unban(bigint)               from public, anon, authenticated;
revoke all on function public.security_contact_resolve(bigint)     from public, anon, authenticated;
grant execute on function public.security_overview(int)               to authenticated;
grant execute on function public.security_allow_add(text, text, text) to authenticated;
grant execute on function public.security_allow_remove(bigint)        to authenticated;
grant execute on function public.security_unban(bigint)               to authenticated;
grant execute on function public.security_contact_resolve(bigint)     to authenticated;


-- ---------------------------------------------------------------------------
-- 6) Content reports: per-account caps
--    SECURITY DEFINER to read auth.users (account age) and write security_events; the auth.uid()
--    check replaces the RLS insert policy this bypasses.
-- ---------------------------------------------------------------------------
create or replace function public.submit_report(p_video_id text, p_reason text, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_email   text := lower(nullif(btrim(auth.jwt() ->> 'email'), ''));
  v_created timestamptz;
  v_hour    int;
  v_day     int;
  v_cap     text;
begin
  if v_uid is null then
    raise exception 'Not signed in';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason is required';
  end if;

  -- Serialize one account's reports so parallel calls can't slip past the caps.
  perform pg_advisory_xact_lock(hashtext('submit_report'), hashtext(v_uid::text));

  -- Same video again within 24 h: succeed silently, insert nothing.
  if p_video_id is not null and exists (
       select 1 from public.zemer_content_report
        where user_id = v_uid and video_id = p_video_id and created_at > now() - interval '24 hours') then
    return;
  end if;

  select count(*) filter (where created_at > now() - interval '1 hour'),
         count(*)
    into v_hour, v_day
    from public.zemer_content_report
   where user_id = v_uid and created_at > now() - interval '24 hours';

  select created_at into v_created from auth.users where id = v_uid;

  if v_hour >= 10 then
    v_cap := 'hour';
  elsif v_day >= 30 then
    v_cap := 'day';
  elsif (v_created is null or v_created > now() - interval '24 hours') and v_day >= 3 then
    v_cap := 'new_account';
  end if;

  if v_cap is not null then
    -- Refused silently (see header NOTE): a RAISE here would roll this event back with it.
    insert into public.security_events (kind, user_id, email, detail)
    values ('report_blocked', v_uid, left(v_email, 320),
            jsonb_build_object('cap', v_cap, 'video_id', left(p_video_id, 64),
                               'reports_1h', v_hour, 'reports_24h', v_day));
    return;
  end if;

  insert into public.zemer_content_report (user_id, video_id, reason, note)
  values (v_uid, p_video_id, p_reason, left(p_note, 1000));
end $$;

revoke all on function public.submit_report(text, text, text) from public, anon;
grant execute on function public.submit_report(text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 7) Trending integrity: bot plays never shape public trending.
--    Same bodies as schema.sql / artist-top-songs.sql plus `not coalesce(is_bot, false)`.
-- ---------------------------------------------------------------------------
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
    and not coalesce(is_bot, false)
    and coalesce(meta->>'qualified', 'true') <> 'false'
    and coalesce(meta->>'v', '') <> '' and coalesce(meta->>'title', '') <> '' and coalesce(meta->>'artist', '') <> ''
  group by meta->>'v'
  order by plays desc, max(created_at) desc
  limit greatest(1, least(100, lim));
$$;

create or replace function public.top_artists(days int default 30, lim int default 20)
returns table (artist text, plays bigint)
language sql security definer set search_path = public stable as $$
  select meta->>'artist' as artist, count(*)::bigint as plays
  from public.zemer_analytics
  where event = 'play' and created_at >= now() - (days * interval '1 day')
    and not coalesce(is_bot, false)
    and coalesce(meta->>'qualified', 'true') <> 'false'
    and coalesce(meta->>'artist', '') <> ''
  group by meta->>'artist'
  order by plays desc, max(created_at) desc
  limit greatest(1, least(100, lim));
$$;

create or replace function public.artist_top_songs(p_artist text, days int default 30, lim int default 24)
returns table (video_id text, title text, artist text, plays bigint)
language sql security definer set search_path = public stable as $$
  select meta->>'v' as video_id,
    (array_agg(meta->>'title'  order by created_at desc))[1] as title,
    (array_agg(meta->>'artist' order by created_at desc))[1] as artist,
    count(*)::bigint as plays
  from public.zemer_analytics
  where event = 'play'
    and created_at >= now() - (greatest(1, least(365, days)) * interval '1 day')
    and not coalesce(is_bot, false)
    and coalesce(meta->>'qualified', 'true') <> 'false'
    and coalesce(meta->>'v', '') <> '' and coalesce(meta->>'title', '') <> ''
    and lower(regexp_replace(trim(meta->>'artist'), '\s+', ' ', 'g'))
        = lower(regexp_replace(trim(coalesce(p_artist, '')), '\s+', ' ', 'g'))
  group by meta->>'v'
  order by plays desc, max(created_at) desc
  limit greatest(1, least(100, lim));
$$;

grant execute on function public.top_songs(int, int)              to anon, authenticated;
grant execute on function public.top_artists(int, int)            to anon, authenticated;
grant execute on function public.artist_top_songs(text, int, int) to anon, authenticated;
