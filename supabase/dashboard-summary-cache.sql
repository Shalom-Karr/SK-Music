-- ============================================================================
-- SK Music — /analytics: serve the ALL-TIME window from an hourly precomputed cache.
--
-- WHY
--   dashboard_summary(p_hours <= 0) aggregates the whole of zemer_analytics in one statement. As the
--   table grew that passed the `authenticated` role's statement timeout (~8s on Supabase), so "All"
--   failed with "canceling statement due to statement timeout" — and the page then fell back to
--   downloading every raw row into the browser. A function-level SET statement_timeout can't fix it:
--   the API call is one statement whose timer is already running at the role's limit.
--
--   So the all-time summary is computed OFF the request path, by pg_cron, with a long timeout, and
--   stored. dashboard_summary(p_hours <= 0) returns the stored copy instantly. It stays EXACT (real
--   distinct visitors/sessions — not summed daily rollups), at most ~1 hour old; the page shows
--   "as of HH:MM". Windows of 24h / 7d / 30d are unchanged and still computed live.
--
-- WHAT
--   dashboard_summary_compute()  the original aggregation, verbatim, minus the admin gate.
--                                Internal: not executable by anon/authenticated.
--   dashboard_summary_cache      one row per (tz, top) the dashboard has asked for. RLS on, no
--                                policies: only the definer functions below touch it.
--   dashboard_summary()          admin gate → all-time: cached jsonb (+ cached_at), or
--                                {"pending": true} the first time a tz is requested (queues it);
--                                other windows: computed live, exactly as before.
--   dashboard_summary_refresh()  recomputes every cache row requested in the last 30 days.
--   cron job                     hourly at :17.
--
-- APPLY
--   1. Supabase → Database → Extensions → enable **pg_cron** (or the CREATE EXTENSION below does it).
--   2. SQL Editor → paste this file → Run. Idempotent: safe to re-run.
--   The last statement fills the cache once right away. If the SQL Editor's own time limit cuts it
--   off, nothing is lost — the hourly job fills it.
-- ============================================================================

-- 1) The original aggregation, unchanged except for the admin gate (the caller enforces it).
create or replace function public.dashboard_summary_compute(
  p_hours int  default 168,          -- window in hours; <= 0 means all-time
  p_tz    text default 'UTC',        -- tz for day/hour bucketing (heatmap, new-vs-returning, daily)
  p_top   int  default 30            -- max rows per categorical breakdown (dashboard shows <= 9)
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_start timestamptz := case when p_hours > 0 then now() - make_interval(hours => p_hours)
                              else '-infinity'::timestamptz end;
  v_tz    text        := coalesce(nullif(p_tz, ''), 'UTC');
  v_top   int         := greatest(1, least(200, coalesce(p_top, 30)));
  result  jsonb;
begin
  with e as (
    select * from public.zemer_analytics where created_at >= v_start
  ),
  plays as (
    select * from e where event = 'play'
  ),
  likes as (
    select * from e
    where event = 'like' and coalesce(meta->>'on', 'true') <> 'false'
  ),
  -- per-session rollup (duration + bounce)
  sess as (
    select session, count(*) n, min(created_at) mn, max(created_at) mx
    from e where coalesce(session, '') <> ''
    group by session
  ),
  -- sessions per visitor id (returning = seen in >= 2 sessions)
  vis as (
    select meta->>'vid' vid, count(distinct session) sessions_cnt
    from e where coalesce(meta->>'vid', '') <> ''
    group by meta->>'vid'
  ),
  -- first referrer domain per session (traffic sources)
  firstref as (
    select distinct on (session)
      session,
      case when coalesce(referrer, '') = '' then 'Direct'
           else coalesce(nullif(regexp_replace(regexp_replace(referrer, '^https?://(www\.)?', ''), '/.*$', ''), ''), 'Direct')
      end dom
    from e where coalesce(session, '') <> ''
    order by session, created_at asc
  ),
  -- visitor-day matrix for new-vs-returning
  vidday as (
    select meta->>'vid' vid, (created_at at time zone v_tz)::date d
    from e where coalesce(meta->>'vid', '') <> ''
    group by 1, 2
  ),
  vidfirst as (select vid, min(d) fd from vidday group by vid)

  select jsonb_build_object(
    'window_hours',        p_hours,
    'tz',                  v_tz,
    'generated_at',        now(),

    -- ---- stat tiles (scalars) ----
    'events',              (select count(*)                              from e),
    'events_today',        (select count(*) from e where (created_at at time zone v_tz)::date = (now() at time zone v_tz)::date),
    'plays',               (select count(*)                              from plays),
    'likes',               (select count(*)                              from likes),
    'sessions',            (select count(*)                              from sess),
    'events_per_session',  (select case when count(*) > 0 then round((select count(*) from e)::numeric / count(*), 1) else 0 end from sess),
    'avg_session_min',     (select coalesce(round(avg(extract(epoch from (mx - mn)) / 60.0)::numeric, 2), 0) from sess),
    'bounce_pct',          (select coalesce(round(100.0 * count(*) filter (where n <= 1) / nullif(count(*), 0), 1), 0) from sess),
    'visitors',            (select count(*) from vis),
    'visitors_returning',  (select count(*) from vis where sessions_cnt >= 2),
    'visitors_ip',         (select count(distinct ip) from e where coalesce(ip, '') <> ''),

    -- ---- signed-in vs anonymous ----
    -- identity_split() answers the same question but only in whole DAYS, so it can't line up with a
    -- 6h or 24h view. Computing it here over `e` means the card is measured on the SAME window as
    -- every other tile. People, not events: an account is one person however much they play; an
    -- anonymous visitor is their per-visitor id, falling back to session for rows predating vid.
    'users_account',       (select count(distinct user_id) from e where user_id is not null),
    'users_anon',          (select count(distinct coalesce(meta->>'vid', session)) from e
                              where user_id is null and coalesce(meta->>'vid', session, '') <> ''),
    'events_account',      (select count(*) from e where user_id is not null),
    'events_anon',         (select count(*) from e where user_id is null),

    -- ---- categorical breakdowns: [[label, count], ...] desc (feed barList/shareBar) ----
    -- plays_total / likes_total let the client compute shareBar "Other" correctly even though
    -- each list is capped to p_top.
    'plays_total',   (select count(*) from plays),
    'likes_total',   (select count(*) from likes),

    'by_event',   (select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(event, '—') k, count(*) c from e group by 1 order by c desc limit v_top) t),
    'by_path',    (select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(path, '—') k, count(*) c from e group by 1 order by c desc limit v_top) t),
    'by_device',  (select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(device, '—') k, count(*) c from e group by 1 order by c desc limit v_top) t),
    'by_browser', (select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(browser, '—') k, count(*) c from e group by 1 order by c desc limit v_top) t),
    'by_os',      (select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(os, '—') k, count(*) c from e group by 1 order by c desc limit v_top) t),
    'by_country', (select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(country, '—') k, count(*) c from e group by 1 order by c desc limit v_top) t),
    'by_screen',  (select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(nullif(screen, ''), meta->>'screen', '—') k, count(*) c from e group by 1 order by c desc limit v_top) t),
    'by_referrer',(select coalesce(jsonb_agg(jsonb_build_array(dom, c) order by c desc), '[]'::jsonb)
                   from (select dom, count(*) c from firstref group by dom order by c desc limit v_top) t),
    'by_viewport',(select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(meta->>'viewport', '—') k, count(*) c from e where event = 'load' group by 1 order by c desc limit v_top) t),

    'by_artist',  (select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(nullif(meta->>'artist', ''), '—') k, count(*) c from plays group by 1 order by c desc limit v_top) t),
    'by_song',    (select coalesce(jsonb_agg(jsonb_build_array(label, c) order by c desc), '[]'::jsonb)
                   from (
                     select case when coalesce(a, '') <> '' then t || ' · ' || a else t end label, c
                     from (
                       select (array_agg(coalesce(meta->>'title', meta->>'v') order by created_at desc))[1] t,
                              (array_agg(meta->>'artist' order by created_at desc))[1] a,
                              count(*) c
                       from plays
                       where coalesce(meta->>'v', meta->>'title') is not null
                       group by coalesce(meta->>'v', meta->>'title')
                     ) g order by c desc limit v_top
                   ) t),
    'liked_artists',(select coalesce(jsonb_agg(jsonb_build_array(k, c) order by c desc), '[]'::jsonb)
                     from (select coalesce(nullif(meta->>'artist', ''), '—') k, count(*) c from likes group by 1 order by c desc limit v_top) t),
    'liked_songs',(select coalesce(jsonb_agg(jsonb_build_array(label, c) order by c desc), '[]'::jsonb)
                   from (
                     select case when coalesce(a, '') <> '' then t || ' · ' || a else t end label, c
                     from (
                       select (array_agg(coalesce(meta->>'title', meta->>'v') order by created_at desc))[1] t,
                              (array_agg(meta->>'artist' order by created_at desc))[1] a,
                              count(*) c
                       from likes
                       where coalesce(meta->>'v', meta->>'title') is not null
                       group by coalesce(meta->>'v', meta->>'title')
                     ) g order by c desc limit v_top
                   ) t),
    'top_search', (select coalesce(jsonb_agg(jsonb_build_array(q, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(nullif(meta->>'q', ''), '—') q, count(*) c
                         from e where event = 'search' group by 1 order by c desc limit v_top) t),
    'zero_search',(select coalesce(jsonb_agg(jsonb_build_array(q, c) order by c desc), '[]'::jsonb)
                   from (select coalesce(nullif(meta->>'q', ''), '—') q, count(*) c
                         from e where event = 'search' and coalesce(meta->>'count', '') = '0'
                         group by 1 order by c desc limit v_top) t),

    -- ---- time series: hourly counts [[iso_hour, count], ...] asc (client re-buckets) ----
    'hourly',     (select coalesce(jsonb_agg(jsonb_build_array(h, c) order by h), '[]'::jsonb)
                   from (select date_trunc('hour', created_at) h, count(*) c from e group by 1) t),

    -- ---- heatmap: [[dow(0=Sun..6=Sat), hour(0-23), count], ...] in p_tz ----
    'heatmap',    (select coalesce(jsonb_agg(jsonb_build_array(dow, hr, c)), '[]'::jsonb)
                   from (
                     select extract(dow  from created_at at time zone v_tz)::int dow,
                            extract(hour from created_at at time zone v_tz)::int hr,
                            count(*) c
                     from e group by 1, 2
                   ) t),

    -- ---- new vs returning per day: [[iso_date, new, returning], ...] asc, in p_tz ----
    'new_returning', (select coalesce(jsonb_agg(jsonb_build_array(d, nw, rt) order by d), '[]'::jsonb)
                      from (
                        select vd.d,
                               count(*) filter (where vd.d = vf.fd) nw,
                               count(*) filter (where vd.d > vf.fd) rt
                        from vidday vd join vidfirst vf using (vid)
                        group by vd.d
                      ) t)
  )
  into result;

  return result;
end $$;

revoke execute on function public.dashboard_summary_compute(int, text, int) from public, anon, authenticated;

-- 2) The cache.
create table if not exists public.dashboard_summary_cache (
  tz           text        not null,
  top          int         not null,
  data         jsonb,
  computed_at  timestamptz,
  requested_at timestamptz not null default now(),
  primary key (tz, top)
);
alter table public.dashboard_summary_cache enable row level security;
revoke all on public.dashboard_summary_cache from anon, authenticated;

-- 3) The public RPC: same signature and output shape as before.
create or replace function public.dashboard_summary(
  p_hours int  default 168,
  p_tz    text default 'UTC',
  p_top   int  default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
volatile                                   -- it records which (tz, top) the dashboard asks for
as $$
declare
  v_tz  text := coalesce(nullif(p_tz, ''), 'UTC');
  v_top int  := greatest(1, least(200, coalesce(p_top, 30)));
  c     public.dashboard_summary_cache;
begin
  if not public.is_zemer_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if p_hours > 0 then
    return public.dashboard_summary_compute(p_hours, v_tz, v_top);
  end if;

  insert into public.dashboard_summary_cache as k (tz, top) values (v_tz, v_top)
  on conflict (tz, top) do update set requested_at = now()
  returning * into c;

  if c.data is null then
    return jsonb_build_object('pending', true, 'tz', v_tz);
  end if;
  return c.data || jsonb_build_object('cached_at', c.computed_at);
end $$;

revoke execute on function public.dashboard_summary(int, text, int) from public, anon;
grant  execute on function public.dashboard_summary(int, text, int) to authenticated;

-- 4) The refresher (cron only). One bad tz must not stop the others.
create or replace function public.dashboard_summary_refresh()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.dashboard_summary_cache;
  n int := 0;
begin
  for r in select * from public.dashboard_summary_cache where requested_at > now() - interval '30 days' loop
    begin
      update public.dashboard_summary_cache
         set data = public.dashboard_summary_compute(0, r.tz, r.top), computed_at = now()
       where tz = r.tz and top = r.top;
      n := n + 1;
    exception when others then
      raise warning 'dashboard_summary_refresh(%, %) failed: %', r.tz, r.top, sqlerrm;
    end;
  end loop;
  return n;
end $$;

revoke execute on function public.dashboard_summary_refresh() from public, anon, authenticated;

-- 5) Hourly job. cron.schedule with a name replaces an existing job of that name (idempotent).
create extension if not exists pg_cron;
select cron.schedule(
  'dashboard-summary-cache',
  '17 * * * *',
  $job$ set statement_timeout = '15min'; select public.dashboard_summary_refresh(); $job$
);

-- 6) Fill it once now for the dashboard's usual settings, so "All" works immediately.
insert into public.dashboard_summary_cache (tz, top) values ('America/New_York', 30), ('UTC', 30)
on conflict (tz, top) do nothing;
set statement_timeout = '15min';
select public.dashboard_summary_refresh();
