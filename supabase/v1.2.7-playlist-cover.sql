-- ============================================================================
-- SK Music 1.2.7 — playlist cover art
--
-- Run AFTER v1.2.5-admin-detail.sql. Idempotent: safe to re-run.
--
-- A cover is a videoId belonging to the playlist, not an uploaded image. That
-- choice is the design: no storage bucket, no upload path, no image moderation
-- surface, and nothing a user can point at an arbitrary URL. The client renders
-- it through the same YouTube thumbnail helper every other card already uses.
--
-- NULL means "no choice made" and the client falls back to the first track's
-- art, so every playlist has a cover without anyone having to pick one.
-- ============================================================================

alter table public.zemer_playlist_user
  add column if not exists cover_video_id text;


-- ---------------------------------------------------------------------------
-- set_playlist_cover — owner-guarded, and the video must actually be IN the
-- playlist. Passing null clears it (back to the first-track fallback).
--
-- SECURITY INVOKER, so RLS ("own playlists") does the ownership check; the
-- membership check below is what stops a cover being set to an arbitrary id.
-- ---------------------------------------------------------------------------
create or replace function public.set_playlist_cover(p_id uuid, p_video_id text)
returns void language plpgsql security invoker as $$
begin
  if p_video_id is not null and not exists (
       select 1 from public.zemer_playlist_item
        where playlist_id = p_id and video_id = p_video_id) then
    return;  -- not a member of this playlist → no-op rather than an arbitrary cover
  end if;

  update public.zemer_playlist_user
     set cover_video_id = p_video_id, updated_at = now()
   where id = p_id and user_id = auth.uid();
end;
$$;


-- ---------------------------------------------------------------------------
-- get_my_playlists now also reports cover_video_id, plus first_video_id so the
-- client can render the fallback cover without fetching every playlist's tracks
-- just to draw the library grid. Signature change → drop first.
-- ---------------------------------------------------------------------------
drop function if exists public.get_my_playlists();
create function public.get_my_playlists()
returns table (id uuid, name text, item_count bigint, updated_at timestamptz,
               is_public boolean, cover_video_id text, first_video_id text)
language sql security invoker stable as $$
  select p.id, p.name, count(i.video_id)::bigint as item_count, p.updated_at, p.is_public,
         p.cover_video_id,
         (select i2.video_id from public.zemer_playlist_item i2
           where i2.playlist_id = p.id order by i2.position limit 1) as first_video_id
  from public.zemer_playlist_user p
  left join public.zemer_playlist_item i on i.playlist_id = p.id
  where p.user_id = auth.uid()
  group by p.id, p.name, p.updated_at, p.is_public, p.cover_video_id
  order by p.updated_at desc;
$$;

grant execute on function public.set_playlist_cover(uuid, text) to authenticated;
grant execute on function public.get_my_playlists()              to authenticated;
