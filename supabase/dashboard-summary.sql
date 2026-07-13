-- ============================================================================
-- SK Music — /analytics dashboard server-side aggregation RPC.
--
-- WHY THIS EXISTS
--   assets/analytics.html currently pages the ENTIRE time window out of
--   zemer_analytics (select=* , 1000 rows/page, sequentially, with OFFSET) and
--   then does ~20 full-array aggregations in JavaScript on the main thread. For
--   anything past a few thousand rows that means multiple megabytes over many
--   sequential round-trips plus heavy client CPU — which is the real reason the
--   page is slow (NOT the Worker that serves the HTML, and NOT a missing index).
--
--   This function does all of that aggregation IN Postgres — one indexed range
--   scan + hash-aggregate — and returns a single compact JSONB (a few KB) in ONE
--   round-trip. It replaces "download all rows, count in JS" with "count in the DB".
--
-- SECURITY
--   SECURITY DEFINER so it can read zemer_analytics regardless of the caller's RLS,
--   BUT it self-enforces the same admin gate the raw-select RLS uses
--   (public.is_zemer_admin) and is granted to `authenticated` only — never `anon`.
--   A signed-in non-admin gets an exception, same as they'd get no rows today.
--
-- APPLY
--   Supabase SQL Editor → paste → Run. Idempotent (create or replace + guarded grant).
--   Safe to fold into schema.sql section 12 later; kept standalone here so it can
--   ship without re-running the whole schema.
--
-- CLIENT WIRING (follow-up — see report; needs a smoke test against Supabase)
--   Replace the paginated load() in assets/analytics.html with a single POST:
--     POST {SUPABASE_URL}/rest/v1/rpc/dashboard_summary
--     headers: apikey, Authorization: Bearer <access_token>, Content-Type: json
--     body: { "p_hours": <RANGE_H>, "p_tz": <IANA tz, e.g. Intl…timeZone> }
--   Then feed the returned pair arrays straight into barList()/shareBar() (they
--   already take [[label,count],…]) and the scalars into the stat tiles. Keep a
--   small `select=<cols>&order=created_at.desc&limit=80` fetch for the raw
--   "Recent events" table only. p_hours <= 0 means all-time.
-- ============================================================================

create or replace function public.dashboard_summary(
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
  -- Same gate as the "admins can select" RLS policy on the raw table.
  if not public.is_zemer_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

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

-- Signed-in users only; the function itself further restricts to zemer_admin. Never anon.
revoke execute on function public.dashboard_summary(int, text, int) from public, anon;
grant  execute on function public.dashboard_summary(int, text, int) to authenticated;
