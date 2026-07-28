-- SK Music 1.1.2 — playlist sharing (public/private) + "already in playlist" lookup.
-- Idempotent; safe to re-run. Run AFTER supabase/v1.1.0-features.sql (it builds on those tables).
-- (De-duping songs needs no change here: zemer_playlist_item already has PRIMARY KEY
--  (playlist_id, video_id) and add_to_playlist already does ON CONFLICT DO NOTHING.)

-- ── Public / private sharing ────────────────────────────────────────────────
alter table public.zemer_playlist_user
  add column if not exists is_public boolean not null default false;

-- Owner toggles a playlist public/private. Returns true when a row was updated.
create or replace function public.set_playlist_public(p_id uuid, p_public boolean)
returns boolean language plpgsql security invoker as $$
begin
  update public.zemer_playlist_user
     set is_public = p_public, updated_at = now()
   where id = p_id and user_id = auth.uid();
  return found;
end $$;

-- get_my_playlists now also reports is_public (signature change → drop first).
drop function if exists public.get_my_playlists();
create function public.get_my_playlists()
returns table (id uuid, name text, item_count bigint, updated_at timestamptz, is_public boolean)
language sql security invoker stable as $$
  select p.id, p.name, count(i.video_id)::bigint as item_count, p.updated_at, p.is_public
  from public.zemer_playlist_user p
  left join public.zemer_playlist_item i on i.playlist_id = p.id
  where p.user_id = auth.uid()
  group by p.id, p.name, p.updated_at, p.is_public
  order by p.updated_at desc;
$$;

-- Public read: ANYONE (even anonymous) can read a playlist that's marked public. SECURITY DEFINER so
-- it bypasses the owner-only RLS, but the WHERE is_public = true clause is the only thing it exposes.
-- Ordered by position; name repeats on each row (take it from any row). No `position` column returned
-- (reserved word) — rows already arrive in order.
create or replace function public.get_public_playlist(p_id uuid)
returns table (name text, video_id text, title text, artist text)
language sql security definer stable
set search_path = public as $$
  select p.name, i.video_id, i.title, i.artist
  from public.zemer_playlist_user p
  left join public.zemer_playlist_item i on i.playlist_id = p.id
  where p.id = p_id and p.is_public = true
  order by i.position asc nulls last;
$$;
grant execute on function public.get_public_playlist(uuid) to anon, authenticated;

-- ── "Already in a playlist" lookup (grey out those in the Add-to-playlist menu) ──
-- Returns the ids of the caller's playlists that already contain p_video_id.
create or replace function public.playlists_with_song(p_video_id text)
returns table (playlist_id uuid) language sql security invoker stable as $$
  select i.playlist_id
  from public.zemer_playlist_item i
  join public.zemer_playlist_user p on p.id = i.playlist_id
  where p.user_id = auth.uid() and i.video_id = p_video_id;
$$;
