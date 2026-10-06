-- ============================================================================
-- SK Music — catalog account gate + daily per-account catalog quota (database side).
--
-- WHY
--   The per-entity catalog files (artist / album / curated-playlist detail) and the full dataset are what a
--   scraper wants. The Worker now serves all of them behind the security gate (engine/security.mjs), and
--   this file adds the two controls it enforces there:
--     1. catalog_requires_account — when ON, signed-out visitors get 401 {"error":"account_required"} for
--        catalog files (the app then asks them to sign in). OFF by default; the admin flips it from the
--        dashboard's Security tab.
--     2. catalog_daily_quota — catalog files per key per UTC day (key = "u:<user id>" for accounts,
--        "ip:<ip>" for signed-out visitors while the gate is off). Going over blocks the CATALOG for that key until the
--        next 00:00 UTC — one ban per key per day, so a heavy listener can never escalate within a day. Only
--        quota bans on separate days climb security_ban's ladder (level 3 = 24 h, 4+ = permanent). 0 = no quota.
--
-- WHAT
--   security_bans    + catalog_only boolean: a daily-quota ban (blocks catalog files only)
--   security_config  + catalog_requires_account boolean (default false), catalog_daily_quota int (default 400)
--   catalog_usage    (key, day) → n requests; RLS on, no policies, no client privileges
--   Worker RPCs (EXECUTE to anon; p_token checked exactly like security.sql's, else 'forbidden'):
--     catalog_state(p_token)                          -> {requires_account, daily_quota, quota_blocks}
--     catalog_usage_add(p_token, p_counts, p_emails)  -> [{key, n, until, level}] for keys now over quota
--       p_counts = {"u:<uuid>": 37, "ip:1.2.3.4": 5, …} (batched by the Worker), p_emails = {"u:<uuid>": email}.
--       The first time a key goes over quota on a UTC day (and no other ban covers it) it is banned via
--       security_ban (the ONE source of levels), marked catalog_only, extended to at least the next 00:00 UTC,
--       and a `quota_exceeded` event is written. Later overage that day never bans again; a quota ban an
--       admin lifts stays lifted for the day.
--   Admin RPCs (EXECUTE to authenticated; each requires public.is_zemer_admin()):
--     catalog_gate_get(p_hours)                          -> {requires_account, daily_quota, today, events}
--     catalog_gate_set(p_requires_account, p_daily_quota) -> same shape as catalog_state (null = keep)
--   security_log: re-created with two more event kinds, `account_required` and `quota_exceeded`.
--
-- WHY A SEPARATE catalog_state (not extending security_state)
--   security.sql is documented as safe to re-run. If the flag lived in security_state, re-running it would
--   silently drop the flag from what the Worker reads and switch the gate off. A separate RPC (the Worker
--   calls both together, once a minute per isolate) can't be clobbered that way. The new security_log kinds
--   CAN be (re-running security.sql restores the old kind list, so those two event kinds would stop being
--   recorded) — re-run this file after any re-run of security.sql.
--
-- APPLY (order matters)
--   Run AFTER supabase/security.sql (refuses to run, changing nothing, if it is missing).
--   SQL Editor -> paste -> Run. Idempotent: safe to re-run.
--   The gate stays OFF until the admin turns it on from the Security tab (or:
--     select public.catalog_gate_set(true, null);  -- as an admin session; the SQL editor is not one).
-- ============================================================================

-- 0) Require security.sql.
do $$ begin
  if to_regclass('public.security_config') is null
     or to_regprocedure('public.security_ban(text, text, uuid, text, text)') is null
     or to_regprocedure('public.security_require_token(text)') is null then
    raise exception 'catalog-gate.sql requires supabase/security.sql — run it first, then re-run this file.';
  end if;
end $$;


-- ---------------------------------------------------------------------------
-- 1) Config + usage table
-- ---------------------------------------------------------------------------
alter table public.security_config add column if not exists catalog_requires_account boolean not null default false;
alter table public.security_config add column if not exists catalog_daily_quota int not null default 400;
alter table public.security_config drop constraint if exists security_config_catalog_daily_quota_check;
alter table public.security_config add constraint security_config_catalog_daily_quota_check
  check (catalog_daily_quota between 0 and 1000000);

-- A daily-quota ban blocks the CATALOG only (the Worker serves everything else as usual). It is still an
-- ordinary security_bans row, so it shows on the Security tab, can be lifted there, and counts as one level
-- in security_ban's escalation.
alter table public.security_bans add column if not exists catalog_only boolean not null default false;

create table if not exists public.catalog_usage (
  key        text not null,
  day        date not null,
  n          int not null default 0,
  email      text,
  ban_id     bigint,
  updated_at timestamptz not null default now(),
  primary key (key, day)
);
create index if not exists idx_catalog_usage_day on public.catalog_usage (day);

alter table public.catalog_usage enable row level security;
revoke all on public.catalog_usage from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2) Worker RPCs
-- ---------------------------------------------------------------------------
create or replace function public.catalog_state(p_token text)
returns jsonb
language plpgsql security definer set search_path = public stable
as $$
declare c public.security_config;
begin
  perform public.security_require_token(p_token);
  select * into c from public.security_config where id = 1;
  return jsonb_build_object('requires_account', coalesce(c.catalog_requires_account, false),
                            'daily_quota', coalesce(c.catalog_daily_quota, 400),
                            -- active catalog-only bans: the Worker keeps these out of its site-wide ban list
                            'quota_blocks', coalesce((
                              select jsonb_agg(jsonb_build_object('id', id, 'ip', ip, 'user_id', user_id, 'until', until) order by id)
                              from public.security_bans where catalog_only and until > now()), '[]'::jsonb));
end $$;

-- Adds one batch of per-key counts to today's (UTC) totals and bans keys that are now over the quota.
-- Malformed keys/values are skipped; at most 1000 keys per call; one value counts at most 100000.
create or replace function public.catalog_usage_add(p_token text, p_counts jsonb, p_emails jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_day   date := (now() at time zone 'utc')::date;
  v_quota int;
  v_out   jsonb := '[]'::jsonb;
  v_ip    text;
  v_uid   uuid;
  v_ban   jsonb;
  v_banid bigint;
  v_until timestamptz;
  v_mid   timestamptz := (v_day + 1)::timestamp at time zone 'utc'; -- next 00:00 UTC
  b       public.security_bans;
  r       record;
begin
  perform public.security_require_token(p_token);
  if p_counts is null or jsonb_typeof(p_counts) <> 'object' then
    return v_out;
  end if;
  select coalesce(catalog_daily_quota, 400) into v_quota from public.security_config where id = 1;

  for r in
    with src as (
      select case when e.k ~* '^u:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then lower(e.k)
                  when e.k like 'ip:%' and public.security_norm_ip(substr(e.k, 4)) is not null
                    then 'ip:' || public.security_norm_ip(substr(e.k, 4)) end as key,
             least((e.v #>> '{}')::bigint, 100000) as n,
             case when e.k like 'u:%' and jsonb_typeof(p_emails) = 'object'
                  then left(nullif(lower(btrim(p_emails ->> e.k)), ''), 320) end as email
      from (select k, v from jsonb_each(p_counts) as j(k, v) limit 1000) e
      where jsonb_typeof(e.v) = 'number' and (e.v #>> '{}') ~ '^[0-9]{1,15}$' and (e.v #>> '{}')::bigint > 0
    ),
    agg as (
      select key, sum(n)::int as n, max(email) as email from src where key is not null group by key
    )
    insert into public.catalog_usage as cu (key, day, n, email)
    select key, v_day, n, email from agg
    on conflict (key, day) do update
      set n = cu.n + excluded.n, email = coalesce(excluded.email, cu.email), updated_at = now()
    returning cu.key, cu.n, cu.email, cu.ban_id
  loop
    continue when v_quota <= 0 or r.n <= v_quota;

    -- At most ONE quota ban per key per UTC day. Already banned today: report it while it is active (so the
    -- flushing isolate enforces it at once), never ban again or escalate — and a ban an admin lifted stays lifted.
    if r.ban_id is not null then
      select * into b from public.security_bans where id = r.ban_id;
      if found and b.until > now() and not b.lifted_by_admin then
        v_out := v_out || jsonb_build_array(jsonb_build_object('key', r.key, 'n', r.n, 'until', b.until, 'level', b.level));
      end if;
      continue;
    end if;

    v_ip  := case when r.key like 'ip:%' then substr(r.key, 4) end;
    v_uid := case when r.key like 'u:%' then substr(r.key, 3)::uuid end;
    -- A ban already covers this key (a site-wide rate-limit ban, or an earlier day's quota ban that is still
    -- running): leave it alone; if the key is still over quota once it ends, the next flush bans it for today.
    continue when exists (select 1 from public.security_bans
                           where until > now()
                             and ((v_ip is not null and ip = v_ip) or (v_uid is not null and user_id = v_uid)));
    -- security_ban picks the level (all earlier bans count) — the one escalation ladder.
    v_ban := public.security_ban(p_token, v_ip, v_uid, r.email,
                                 format('auto: daily catalog quota (%s/%s)', r.n, v_quota));
    v_banid := (v_ban ->> 'id')::bigint;
    select * into b from public.security_bans where id = v_banid;
    -- Lost a race with another writer's ban (security_ban handed that one back): leave it alone too.
    continue when not found or b.created_at <> now() or b.catalog_only;

    -- Catalog-only, and at least until the next 00:00 UTC (the ladder's 24 h / permanent can be longer).
    v_until := greatest(b.until, v_mid);
    update public.security_bans set until = v_until, catalog_only = true where id = v_banid;
    update public.security_events set detail = jsonb_set(detail, '{until}', to_jsonb(v_until))
     where kind = 'auto_ban' and detail ->> 'ban_id' = v_banid::text;
    update public.catalog_usage set ban_id = v_banid where key = r.key and day = v_day;
    insert into public.security_events (kind, ip, user_id, email, detail)
    values ('quota_exceeded', v_ip, v_uid, r.email,
            jsonb_build_object('n', r.n, 'quota', v_quota, 'ban_id', v_banid, 'level', b.level,
                               'until', v_until, 'day', v_day));
    v_out := v_out || jsonb_build_array(jsonb_build_object('key', r.key, 'n', r.n, 'until', v_until, 'level', b.level));
  end loop;

  -- Retention: a few days is plenty (only today's totals matter). Opportunistic, ~1 in 50 calls.
  if random() < 0.02 then
    delete from public.catalog_usage where day < v_day - 3;
  end if;
  return v_out;
end $$;

revoke all on function public.catalog_state(text)                    from public, anon, authenticated;
revoke all on function public.catalog_usage_add(text, jsonb, jsonb)  from public, anon, authenticated;
grant execute on function public.catalog_state(text)                   to anon;
grant execute on function public.catalog_usage_add(text, jsonb, jsonb) to anon;

-- Same body as security.sql, plus the kinds `account_required` and `quota_exceeded`.
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
    and e->>'kind' in ('rate_limited', 'datacenter_block', 'banned_hit', 'auto_ban', 'account_required', 'quota_exceeded');
  get diagnostics n = row_count;

  -- Retention: opportunistic, ~1 in 200 calls.
  if random() < 0.005 then
    delete from public.security_events where created_at < now() - interval '90 days';
  end if;
  return n;
end $$;

revoke all on function public.security_log(text, jsonb) from public, anon, authenticated;
grant execute on function public.security_log(text, jsonb) to anon;


-- ---------------------------------------------------------------------------
-- 3) Admin RPCs
-- ---------------------------------------------------------------------------
-- p_hours <= 0 (or null) = all time (for the event counts; `today` is always the current UTC day).
create or replace function public.catalog_gate_get(p_hours int)
returns jsonb
language plpgsql security definer set search_path = public stable
as $$
declare
  c       public.security_config;
  v_day   date := (now() at time zone 'utc')::date;
  v_since timestamptz;
  v_quota int;
begin
  if not public.is_zemer_admin() then
    raise exception 'Not authorized';
  end if;
  v_since := case when coalesce(p_hours, 0) <= 0 then '-infinity'::timestamptz
                  else now() - make_interval(hours => least(p_hours, 24 * 3650)) end;
  select * into c from public.security_config where id = 1;
  v_quota := coalesce(c.catalog_daily_quota, 400);

  return jsonb_build_object(
    'requires_account', coalesce(c.catalog_requires_account, false),
    'daily_quota', v_quota,
    'today', jsonb_build_object(
      'day', v_day,
      'keys', (select count(*) from public.catalog_usage where day = v_day),
      'requests', (select coalesce(sum(n), 0) from public.catalog_usage where day = v_day),
      'over_quota', (select count(*) from public.catalog_usage where day = v_day and v_quota > 0 and n > v_quota),
      'top', coalesce((
        select jsonb_agg(jsonb_build_object('key', key, 'n', n, 'email', email, 'ban_id', ban_id) order by n desc, key)
        from (select * from public.catalog_usage where day = v_day order by n desc, key limit 20) t), '[]'::jsonb)),
    'events', jsonb_build_object(
      'account_required', (select count(*) from public.security_events where kind = 'account_required' and created_at >= v_since),
      'quota_exceeded', (select count(*) from public.security_events where kind = 'quota_exceeded' and created_at >= v_since))
  );
end $$;

-- null keeps the current value. Quota 0 turns the quota off; otherwise 1..1000000.
create or replace function public.catalog_gate_set(p_requires_account boolean, p_daily_quota int)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare c public.security_config;
begin
  if not public.is_zemer_admin() then
    raise exception 'Not authorized';
  end if;
  if p_daily_quota is not null and (p_daily_quota < 0 or p_daily_quota > 1000000) then
    raise exception 'daily quota must be between 0 and 1000000';
  end if;
  insert into public.security_config (id) values (1) on conflict (id) do nothing;
  update public.security_config
     set catalog_requires_account = coalesce(p_requires_account, catalog_requires_account),
         catalog_daily_quota      = coalesce(p_daily_quota, catalog_daily_quota)
   where id = 1
  returning * into c;
  return jsonb_build_object('requires_account', c.catalog_requires_account, 'daily_quota', c.catalog_daily_quota);
end $$;

revoke all on function public.catalog_gate_get(int)              from public, anon, authenticated;
revoke all on function public.catalog_gate_set(boolean, int)     from public, anon, authenticated;
grant execute on function public.catalog_gate_get(int)             to authenticated;
grant execute on function public.catalog_gate_set(boolean, int)    to authenticated;
