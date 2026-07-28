-- ============================================================================
-- SK Music — v1.1.0 FEATURES migration (runnable, idempotent).
--
-- Adds three new user-scoped feature sets on top of the base schema.sql:
--   1. User-created playlists   (zemer_playlist_user + zemer_playlist_item)
--   2. Artist follows           (zemer_artist_follow)
--   3. Content reports          (zemer_content_report)
--
-- Follows the exact conventions established in schema.sql:
--   * every new table has RLS enabled, scoped to the owner via auth.uid();
--   * every RPC is SECURITY INVOKER (relies on RLS for owner-scoping, like
--     get_my_likes / toggle_like) and is GRANTed EXECUTE to `authenticated`;
--   * table DML privileges come from Supabase's default grants to the
--     `authenticated` role (same as zemer_like — no explicit table grants here);
--   * ids use gen_random_uuid().
--
-- ---------------------------------------------------------------------------
-- HOW TO APPLY
--   Supabase SQL Editor: paste this whole file and Run once. Safe to re-run —
--   every object uses `create table if not exists` / `create or replace
--   function` / `drop policy if exists` then `create policy`.
--   Apply AFTER schema.sql (it does not redefine anything from schema.sql).
-- ============================================================================


-- ============================================================================
-- 1. USER-CREATED PLAYLISTS
-- ============================================================================

-- One row per playlist, owned by the creator.
create table if not exists public.zemer_playlist_user (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_zpu_user_updated on public.zemer_playlist_user (user_id, updated_at desc);

-- One row per (playlist, song). `position` orders the playlist; reads sort by it.
create table if not exists public.zemer_playlist_item (
  playlist_id  uuid not null references public.zemer_playlist_user(id) on delete cascade,
  video_id     text not null,
  title        text,
  artist       text,
  position     int  not null,
  added_at     timestamptz not null default now(),
  primary key (playlist_id, video_id)              -- one entry per song per playlist
);
create index if not exists idx_zpi_playlist_pos on public.zemer_playlist_item (playlist_id, position);

-- ---- RLS: playlists are owner-only ----------------------------------------
alter table public.zemer_playlist_user enable row level security;
drop policy if exists "own playlists" on public.zemer_playlist_user;
create policy "own playlists" on public.zemer_playlist_user
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---- RLS: items visible/mutable only when the parent playlist is owned -----
alter table public.zemer_playlist_item enable row level security;
drop policy if exists "own playlist items" on public.zemer_playlist_item;
create policy "own playlist items" on public.zemer_playlist_item
  for all to authenticated
  using (exists (select 1 from public.zemer_playlist_user p
                 where p.id = playlist_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.zemer_playlist_user p
                      where p.id = playlist_id and p.user_id = auth.uid()));

-- ---- Playlist RPCs (all SECURITY INVOKER; RLS enforces ownership) ----------

-- Create a playlist; returns the new id.
create or replace function public.create_playlist(p_name text)
returns uuid language sql security invoker as $$
  insert into public.zemer_playlist_user (user_id, name)
  values (auth.uid(), p_name)
  returning id;
$$;

-- Rename a playlist (owner-guarded) and touch updated_at.
create or replace function public.rename_playlist(p_id uuid, p_name text)
returns void language sql security invoker as $$
  update public.zemer_playlist_user
     set name = p_name, updated_at = now()
   where id = p_id and user_id = auth.uid();
$$;

-- Delete a playlist (owner-guarded); the cascade drops its items.
create or replace function public.delete_playlist(p_id uuid)
returns void language sql security invoker as $$
  delete from public.zemer_playlist_user
   where id = p_id and user_id = auth.uid();
$$;

-- Add a song to a playlist. IDEMPOTENT (on conflict do nothing); appends at
-- position = current max + 1; owner-guarded; touches updated_at.
create or replace function public.add_to_playlist(p_id uuid, p_video_id text, p_title text default null, p_artist text default null)
returns void language plpgsql security invoker as $$
begin
  if not exists (select 1 from public.zemer_playlist_user
                 where id = p_id and user_id = auth.uid()) then
    return;                                            -- not the owner → no-op
  end if;
  insert into public.zemer_playlist_item (playlist_id, video_id, title, artist, position)
  values (p_id, p_video_id, p_title, p_artist,
          coalesce((select max(position) from public.zemer_playlist_item where playlist_id = p_id), 0) + 1)
  on conflict (playlist_id, video_id) do nothing;
  update public.zemer_playlist_user set updated_at = now()
   where id = p_id and user_id = auth.uid();
end $$;

-- Remove a song from a playlist (owner-guarded); touches updated_at.
-- Position gaps are fine — reads order by position.
create or replace function public.remove_from_playlist(p_id uuid, p_video_id text)
returns void language plpgsql security invoker as $$
begin
  if not exists (select 1 from public.zemer_playlist_user
                 where id = p_id and user_id = auth.uid()) then
    return;
  end if;
  delete from public.zemer_playlist_item
   where playlist_id = p_id and video_id = p_video_id;
  update public.zemer_playlist_user set updated_at = now()
   where id = p_id and user_id = auth.uid();
end $$;

-- Reorder: set each item's position to its 1-based index in p_video_ids.
-- Ids not present in the playlist are ignored. Owner-guarded; touches updated_at.
create or replace function public.set_playlist_order(p_id uuid, p_video_ids text[])
returns void language plpgsql security invoker as $$
begin
  if not exists (select 1 from public.zemer_playlist_user
                 where id = p_id and user_id = auth.uid()) then
    return;
  end if;
  update public.zemer_playlist_item pi
     set position = ord.n::int
    from unnest(p_video_ids) with ordinality as ord(vid, n)
   where pi.playlist_id = p_id and pi.video_id = ord.vid;
  update public.zemer_playlist_user set updated_at = now()
   where id = p_id and user_id = auth.uid();
end $$;

-- The caller's playlists, newest-updated first, with an item count.
create or replace function public.get_my_playlists()
returns table (id uuid, name text, item_count bigint, updated_at timestamptz)
language sql security invoker stable as $$
  select p.id, p.name, count(i.video_id)::bigint as item_count, p.updated_at
  from public.zemer_playlist_user p
  left join public.zemer_playlist_item i on i.playlist_id = p.id
  where p.user_id = auth.uid()
  group by p.id, p.name, p.updated_at
  order by p.updated_at desc;
$$;

-- A playlist's items ordered by position asc (owner-guarded; empty if not owned).
create or replace function public.get_playlist(p_id uuid)
returns table (video_id text, title text, artist text, "position" int)
language sql security invoker stable as $$
  select i.video_id, i.title, i.artist, i.position
  from public.zemer_playlist_item i
  where i.playlist_id = p_id
    and exists (select 1 from public.zemer_playlist_user p
                where p.id = p_id and p.user_id = auth.uid())
  order by i.position asc;
$$;


-- ============================================================================
-- 2. ARTIST FOLLOWS
-- ============================================================================
create table if not exists public.zemer_artist_follow (
  user_id      uuid not null default auth.uid(),
  channel_id   text not null,
  artist_name  text,
  followed_at  timestamptz not null default now(),
  primary key (user_id, channel_id)                -- one follow per artist, no dupes
);
create index if not exists idx_zaf_user_followed on public.zemer_artist_follow (user_id, followed_at desc);

alter table public.zemer_artist_follow enable row level security;
drop policy if exists "own follows" on public.zemer_artist_follow;
create policy "own follows" on public.zemer_artist_follow
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Follow an artist. IDEMPOTENT (on conflict do nothing).
create or replace function public.follow_artist(p_channel_id text, p_name text default null)
returns void language sql security invoker as $$
  insert into public.zemer_artist_follow (user_id, channel_id, artist_name)
  values (auth.uid(), p_channel_id, p_name)
  on conflict (user_id, channel_id) do nothing;
$$;

-- Unfollow an artist.
create or replace function public.unfollow_artist(p_channel_id text)
returns void language sql security invoker as $$
  delete from public.zemer_artist_follow
   where user_id = auth.uid() and channel_id = p_channel_id;
$$;

-- The caller's follows, newest first.
create or replace function public.get_my_follows()
returns table (channel_id text, artist_name text, followed_at timestamptz)
language sql security invoker stable as $$
  select channel_id, artist_name, followed_at
  from public.zemer_artist_follow
  where user_id = auth.uid()
  order by followed_at desc;
$$;


-- ============================================================================
-- 3. CONTENT REPORTS
--    Users may INSERT their own reports and SELECT their own. No user
--    update/delete (admins triage via the service role / Supabase dashboard).
-- ============================================================================
create table if not exists public.zemer_content_report (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid default auth.uid(),
  video_id    text,
  reason      text not null,
  note        text,
  created_at  timestamptz not null default now(),
  status      text not null default 'open'          -- 'open' | (admin-set) 'reviewed' | 'closed' ...
);
create index if not exists idx_zcr_user_created on public.zemer_content_report (user_id, created_at desc);

alter table public.zemer_content_report enable row level security;
-- Insert only your own reports.
drop policy if exists "insert own reports" on public.zemer_content_report;
create policy "insert own reports" on public.zemer_content_report
  for insert to authenticated with check (user_id = auth.uid());
-- Read only your own reports. (No update/delete policies → denied for users.)
drop policy if exists "read own reports" on public.zemer_content_report;
create policy "read own reports" on public.zemer_content_report
  for select to authenticated using (user_id = auth.uid());

-- Submit a report for the caller. Rejects an empty reason; clamps note to 1000 chars.
create or replace function public.submit_report(p_video_id text, p_reason text, p_note text default null)
returns void language plpgsql security invoker as $$
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'reason is required';
  end if;
  insert into public.zemer_content_report (user_id, video_id, reason, note)
  values (auth.uid(), p_video_id, p_reason, left(p_note, 1000));
end $$;


-- ============================================================================
-- 4. GRANTS (function execute privileges — signed-in users only)
-- ============================================================================
-- Playlists
grant execute on function public.create_playlist(text)                              to authenticated;
grant execute on function public.rename_playlist(uuid, text)                        to authenticated;
grant execute on function public.delete_playlist(uuid)                              to authenticated;
grant execute on function public.add_to_playlist(uuid, text, text, text)            to authenticated;
grant execute on function public.remove_from_playlist(uuid, text)                   to authenticated;
grant execute on function public.set_playlist_order(uuid, text[])                   to authenticated;
grant execute on function public.get_my_playlists()                                 to authenticated;
grant execute on function public.get_playlist(uuid)                                 to authenticated;
-- Artist follows
grant execute on function public.follow_artist(text, text)                          to authenticated;
grant execute on function public.unfollow_artist(text)                              to authenticated;
grant execute on function public.get_my_follows()                                   to authenticated;
-- Content reports
grant execute on function public.submit_report(text, text, text)                    to authenticated;
