-- ============================================================================
-- SK Music 1.2.5 — admin console: playlists + visit history
--
-- Run AFTER v1.2.4-admin-hardening.sql. Idempotent: safe to re-run.
--
-- Two more read-only views for the console, both admin-gated exactly like the
-- rest of the admin_* family (admin_guard() first, execute revoked from anon).
-- Neither touches pin_hash and neither writes anything.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- admin_user_playlists — a user's own playlists, with their tracks.
--
-- zemer_playlist_user / zemer_playlist_item are owner-only under RLS
-- ("own playlists", using user_id = auth.uid()). SECURITY DEFINER is what lets
-- an admin see someone else's, which is the whole point of the console — so the
-- guard below is the only thing making that legitimate.
-- ---------------------------------------------------------------------------
create or replace function public.admin_user_playlists(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare v_out jsonb;
begin
  perform public.admin_guard();

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',         p.id,
           'name',       p.name,
           'is_public',  p.is_public,
           'created_at', p.created_at,
           'updated_at', p.updated_at,
           'count',      (select count(*) from public.zemer_playlist_item i where i.playlist_id = p.id),
           'tracks', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'videoId', i.video_id, 'title', i.title,
                      'artist', i.artist, 'position', i.position, 'added_at', i.added_at)
                    order by i.position), '[]'::jsonb)
             from public.zemer_playlist_item i where i.playlist_id = p.id
           )
         ) order by p.updated_at desc), '[]'::jsonb)
  into v_out
  from public.zemer_playlist_user p
  where p.user_id = p_user;

  return jsonb_build_object('playlists', v_out);
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_user_visits — when this account was actually using the app.
--
-- One row per analytics `session` (a per-tab id), collapsed into a visit: when
-- it started and ended, how many events, how many plays, and the device it came
-- from. This is the "when did they visit" view; last_sign_in_at only tells you
-- when a token was minted, which is not the same thing.
--
-- Only covers events carrying this user_id — i.e. from 1.2.3 onward, while the
-- account was signed in. Anonymous browsing by the same person is unattributable
-- by construction and is NOT included.
-- ---------------------------------------------------------------------------
create or replace function public.admin_user_visits(
  p_user  uuid,
  p_days  int default 90,
  p_limit int default 100
)
returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare
  v_out  jsonb;
  v_lim  int := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_days int := least(greatest(coalesce(p_days, 90), 1), 3650);
begin
  perform public.admin_guard();

  select coalesce(jsonb_agg(to_jsonb(v) order by v.started desc), '[]'::jsonb)
  into v_out
  from (
    select
      a.session                                            as session,
      min(a.created_at)                                    as started,
      max(a.created_at)                                    as ended,
      count(*)                                             as events,
      count(*) filter (where a.event = 'play')             as plays,
      count(*) filter (where a.event = 'search')           as searches,
      max(a.device)                                        as device,
      max(a.browser)                                       as browser,
      max(a.os)                                            as os,
      max(a.country)                                       as country,
      max(a.city)                                          as city,
      round(extract(epoch from (max(a.created_at) - min(a.created_at))) / 60.0, 1) as minutes
    from public.zemer_analytics a
    where a.user_id = p_user
      and a.session is not null
      and a.created_at >= now() - make_interval(days => v_days)
    group by a.session
    order by min(a.created_at) desc
    limit v_lim
  ) v;

  return jsonb_build_object('days', v_days, 'visits', v_out);
end;
$$;


revoke all on function public.admin_user_playlists(uuid)         from public, anon;
revoke all on function public.admin_user_visits(uuid, int, int)  from public, anon;
grant execute on function public.admin_user_playlists(uuid)        to authenticated;
grant execute on function public.admin_user_visits(uuid, int, int) to authenticated;
