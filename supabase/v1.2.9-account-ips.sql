-- ============================================================================
-- SK Music 1.2.9 — admin console: signup IP + every IP an account used
--
-- Run AFTER v1.2.5-admin-detail.sql (needs admin_guard() from v1.2.2, the
-- analytics user_id from v1.2.3, uid-keyed admin from v1.2.4). Independent of
-- v1.2.8. Idempotent: safe to re-run.
--
-- WHY
--   The owner asked to see, per account, the IP it was created from and every
--   IP it has been seen on — to tell a family's shared home connection from an
--   account being used from somewhere unexpected, and to line accounts up with
--   the Security tab's flagged/banned IPs.
--
-- WHAT
--   admin_signup_ips(uuid[])  — batch, one call per page of the accounts list:
--                               { "<uuid>": {ip, at, source, provider}, ... }
--   admin_user_ips(uuid, int) — the user window: { signup, ips: [...], total }
--   admin_ip_norm(text)       — internal: canonical text form of an IP.
--
--   Signup IP, first source that has one:
--     'signup'        auth.audit_log_entries, action = user_signedup (email AND
--                     OAuth: GoTrue logs both with actor_id = the user's id and
--                     traits.provider = 'email' | 'google' | ...)
--     'first_sign_in' earliest surviving auth.sessions row. Sessions are deleted
--                     on sign-out/expiry, so this is "earliest on record", not
--                     necessarily the very first.
--     'first_visit'   earliest signed-in zemer_analytics row (from 1.2.3 on).
--   Visited IPs: union of zemer_analytics (events + distinct sessions),
--   auth.audit_log_entries (auth events: sign-ins, token refreshes), auth.sessions
--   and security_events (so blocked attempts show), grouped per IP with the
--   sources it appeared in.
--
--   Every auth.* / security_events read is dynamic SQL behind a to_regclass +
--   pg_attribute check and its own exception block: a project where GoTrue no
--   longer writes the audit table, an older GoTrue with no sessions.ip, or a
--   revoked privilege on the auth schema drops that one source, never the call.
--
-- PRIVACY
--   IPs are personal data. Both functions are SECURITY DEFINER, call
--   admin_guard() first, and are executable by `authenticated` only (the guard
--   then refuses non-admins). No table, view or policy is added; nothing here is
--   readable any other way. Same trust caveat as v1.2.3: analytics rows are
--   client-attributed, so analytics-sourced IPs are observed, not proven.
--
--   Note: audit_log_entries keeps the actor id inside its json payload with no
--   index, so each call scans that table once. Fine at this project's size; if
--   it ever isn't, add an expression index on (payload->>'actor_id').
--
-- APPLY
--   Supabase SQL editor: paste this whole file, Run. Verify:
--     select public.admin_user_ips('<some user uuid>');   -- as an admin
-- ============================================================================


-- ---------------------------------------------------------------------------
-- admin_ip_norm — one spelling per address so the same IP from two sources
-- groups together: valid addresses go through inet (lowercase, compressed IPv6,
-- no /32 or /128), anything else is trimmed and kept as-is.
-- ---------------------------------------------------------------------------
create or replace function public.admin_ip_norm(p_ip text)
returns text
language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p_ip, '')), '');
begin
  if v is null then return null; end if;
  begin
    return pg_catalog.host(v::inet);
  exception when others then
    return v;
  end;
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_signup_ips — signup IP for a batch of accounts (the list's page).
-- Accounts with no IP from any source are simply absent from the result.
-- ---------------------------------------------------------------------------
create or replace function public.admin_signup_ips(p_users uuid[])
returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare
  v_ids  uuid[];
  v_txt  text[];
  v_out  jsonb := '{}'::jsonb;
  v_part jsonb;
  v_sess regclass := to_regclass('auth.sessions');
  v_aud  regclass := to_regclass('auth.audit_log_entries');
begin
  perform public.admin_guard();

  select coalesce(array_agg(distinct u), '{}') into v_ids
  from (select unnest(coalesce(p_users, '{}'::uuid[])) as u limit 500) s
  where u is not null;
  if cardinality(v_ids) = 0 then return v_out; end if;
  v_txt := v_ids::text[];

  -- Lowest priority first; each later source overwrites (||) the earlier.
  select coalesce(jsonb_object_agg(f.user_id::text, jsonb_build_object(
           'ip', f.ip, 'at', f.created_at, 'source', 'first_visit')), '{}'::jsonb)
  into v_part
  from (
    select distinct on (a.user_id) a.user_id, public.admin_ip_norm(a.ip) as ip, a.created_at
    from public.zemer_analytics a
    where a.user_id = any (v_ids) and nullif(btrim(a.ip), '') is not null
    order by a.user_id, a.created_at
  ) f;
  v_out := v_out || v_part;

  if v_sess is not null and exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = v_sess and attname = 'ip' and not attisdropped) then
    begin
      execute $q$
        select coalesce(jsonb_object_agg(f.user_id::text, jsonb_build_object(
                 'ip', f.ip, 'at', f.created_at, 'source', 'first_sign_in')), '{}'::jsonb)
        from (
          select distinct on (s.user_id) s.user_id,
                 public.admin_ip_norm(split_part(s.ip::text, '/', 1)) as ip, s.created_at
          from auth.sessions s
          where s.user_id = any ($1) and s.ip is not null
          order by s.user_id, s.created_at
        ) f
        where f.ip is not null
      $q$ into v_part using v_ids;
      v_out := v_out || v_part;
    exception when others then null;
    end;
  end if;

  if v_aud is not null and exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = v_aud and attname = 'ip_address' and not attisdropped) then
    begin
      execute $q$
        select coalesce(jsonb_object_agg(f.actor, jsonb_build_object(
                 'ip', f.ip, 'at', f.created_at, 'source', 'signup', 'provider', f.provider)), '{}'::jsonb)
        from (
          select distinct on (e.payload ->> 'actor_id')
                 e.payload ->> 'actor_id' as actor,
                 public.admin_ip_norm(e.ip_address::text) as ip,
                 e.created_at,
                 (e.payload::jsonb) -> 'traits' ->> 'provider' as provider
          from auth.audit_log_entries e
          where e.payload ->> 'action' = 'user_signedup'
            and e.payload ->> 'actor_id' = any ($1)
            and nullif(btrim(e.ip_address::text), '') is not null
          order by e.payload ->> 'actor_id', e.created_at
        ) f
      $q$ into v_part using v_txt;
      v_out := v_out || v_part;
    exception when others then null;
    end;
  end if;

  return v_out;
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_user_ips — every IP one account has been seen on, newest first.
--
-- Per IP: first_seen / last_seen across all sources, `events` and `visits`
-- (analytics rows and distinct analytics sessions), `auth_events` (audit log),
-- `sign_ins` (surviving sessions), `security` (security_events rows), the latest
-- known country/city/region (analytics) and asn/as_org (security_events), and
-- `sources` — which of visit | auth | session | security | signup it came from.
-- ---------------------------------------------------------------------------
create or replace function public.admin_user_ips(p_user uuid, p_limit int default 200)
returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare
  v_lim    int := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_signup jsonb;
  v_parts  jsonb;
  v_part   jsonb;
  v_ips    jsonb;
  v_total  bigint;
  v_sess   regclass := to_regclass('auth.sessions');
  v_aud    regclass := to_regclass('auth.audit_log_entries');
  v_sec    regclass := to_regclass('public.security_events');
begin
  perform public.admin_guard();
  if p_user is null then
    return jsonb_build_object('signup', null, 'ips', '[]'::jsonb, 'total', 0, 'limit', v_lim);
  end if;

  v_signup := public.admin_signup_ips(array[p_user]) -> p_user::text;

  -- Each source yields rows of one shape; grouped per raw IP first so the
  -- (exception-handling) normaliser runs once per distinct address, not per row.
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_parts
  from (
    select btrim(a.ip) as ip, 'visit' as src,
           min(a.created_at) as first_seen, max(a.created_at) as last_seen,
           count(*) as n, count(distinct a.session) as visits,
           (array_agg(a.country order by a.created_at desc) filter (where nullif(a.country, '') is not null))[1] as country,
           (array_agg(a.city    order by a.created_at desc) filter (where nullif(a.city, '')    is not null))[1] as city,
           (array_agg(a.region  order by a.created_at desc) filter (where nullif(a.region, '')  is not null))[1] as region,
           null::int as asn, null::text as as_org
    from public.zemer_analytics a
    where a.user_id = p_user and nullif(btrim(a.ip), '') is not null
    group by btrim(a.ip)
  ) r;

  if v_aud is not null and exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = v_aud and attname = 'ip_address' and not attisdropped) then
    begin
      execute $q$
        select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
        from (
          select btrim(e.ip_address::text) as ip, 'auth' as src,
                 min(e.created_at) as first_seen, max(e.created_at) as last_seen,
                 count(*) as n, 0 as visits,
                 null::text as country, null::text as city, null::text as region,
                 null::int as asn, null::text as as_org
          from auth.audit_log_entries e
          where e.payload ->> 'actor_id' = $1
            and nullif(btrim(e.ip_address::text), '') is not null
          group by btrim(e.ip_address::text)
        ) r
      $q$ into v_part using p_user::text;
      v_parts := v_parts || v_part;
    exception when others then null;
    end;
  end if;

  if v_sess is not null and exists (
       select 1 from pg_catalog.pg_attribute
       where attrelid = v_sess and attname = 'ip' and not attisdropped) then
    begin
      execute $q$
        select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
        from (
          select split_part(s.ip::text, '/', 1) as ip, 'session' as src,
                 min(s.created_at) as first_seen,
                 max(greatest(s.created_at, coalesce(s.updated_at, s.created_at))) as last_seen,
                 count(*) as n, 0 as visits,
                 null::text as country, null::text as city, null::text as region,
                 null::int as asn, null::text as as_org
          from auth.sessions s
          where s.user_id = $1 and s.ip is not null
          group by split_part(s.ip::text, '/', 1)
        ) r
      $q$ into v_part using p_user;
      v_parts := v_parts || v_part;
    exception when others then null;
    end;
  end if;

  if v_sec is not null then
    begin
      execute $q$
        select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
        from (
          select btrim(x.ip) as ip, 'security' as src,
                 min(x.created_at) as first_seen, max(x.created_at) as last_seen,
                 count(*) as n, 0 as visits,
                 null::text as country, null::text as city, null::text as region,
                 (array_agg(x.asn    order by x.created_at desc) filter (where x.asn is not null))[1] as asn,
                 (array_agg(x.as_org order by x.created_at desc) filter (where nullif(x.as_org, '') is not null))[1] as as_org
          from public.security_events x
          where x.user_id = $1 and nullif(btrim(x.ip), '') is not null
          group by btrim(x.ip)
        ) r
      $q$ into v_part using p_user;
      v_parts := v_parts || v_part;
    exception when others then null;
    end;
  end if;

  if v_signup is not null and v_signup ->> 'source' = 'signup' then
    v_parts := v_parts || jsonb_build_array(jsonb_build_object(
      'ip', v_signup ->> 'ip', 'src', 'signup',
      'first_seen', v_signup -> 'at', 'last_seen', v_signup -> 'at', 'n', 0, 'visits', 0));
  end if;

  with raw as (
    select public.admin_ip_norm(x.ip) as ip, x.src, x.first_seen, x.last_seen, x.n, x.visits,
           x.country, x.city, x.region, x.asn, x.as_org
    from jsonb_to_recordset(v_parts) as x(
      ip text, src text, first_seen timestamptz, last_seen timestamptz, n bigint, visits bigint,
      country text, city text, region text, asn int, as_org text)
  ),
  g as (
    select ip,
           min(first_seen) as first_seen,
           max(last_seen)  as last_seen,
           coalesce(sum(n)      filter (where src = 'visit'), 0)    as events,
           coalesce(sum(visits) filter (where src = 'visit'), 0)    as visits,
           coalesce(sum(n)      filter (where src = 'auth'), 0)     as auth_events,
           coalesce(sum(n)      filter (where src = 'session'), 0)  as sign_ins,
           coalesce(sum(n)      filter (where src = 'security'), 0) as security,
           (array_agg(country order by last_seen desc) filter (where country is not null))[1] as country,
           (array_agg(city    order by last_seen desc) filter (where city    is not null))[1] as city,
           (array_agg(region  order by last_seen desc) filter (where region  is not null))[1] as region,
           (array_agg(asn     order by last_seen desc) filter (where asn     is not null))[1] as asn,
           (array_agg(as_org  order by last_seen desc) filter (where as_org  is not null))[1] as as_org,
           array_agg(distinct src order by src) as sources
    from raw
    where ip is not null
    group by ip
  )
  select (select count(*) from g),
         coalesce((select jsonb_agg(to_jsonb(t) order by t.last_seen desc nulls last, t.ip)
                   from (select * from g order by last_seen desc nulls last, ip limit v_lim) t), '[]'::jsonb)
  into v_total, v_ips;

  return jsonb_build_object('signup', v_signup, 'ips', v_ips, 'total', v_total, 'limit', v_lim);
end;
$$;


revoke all on function public.admin_ip_norm(text)          from public, anon, authenticated;
revoke all on function public.admin_signup_ips(uuid[])     from public, anon;
revoke all on function public.admin_user_ips(uuid, int)    from public, anon;
grant execute on function public.admin_signup_ips(uuid[])  to authenticated;
grant execute on function public.admin_user_ips(uuid, int) to authenticated;
