-- ============================================================================
-- SK Music 1.2.8 — merge duplicate artists
--
-- Run AFTER v1.2.5-admin-detail.sql. Idempotent: safe to re-run.
--
-- WHY THIS EXISTS
--   The catalog is keyed on YouTube channel ids, and one person can have several.
--   As of 2026-08-03 that is 47 names spread across 95 channel ids (5.8% of
--   1,625 artists) — Abie Rotenberg has three, and "Aaron Ben Soussan" appears
--   twice with a byte-identical avatar. Browse, search and the artist rails all
--   show them separately, which reads as a bug to anyone using the app.
--
-- HOW IT IS APPLIED
--   Nothing here runs at request time. engine/build-static.mjs reads this table
--   with the anon key at BAKE time and folds the alias into the canonical: the
--   alias disappears from artists.json, and the canonical's per-artist detail
--   file gains the alias's songs, videos, albums, singles and playlists. So a
--   merge costs zero Worker requests and zero client latency, and takes effect
--   on the next deploy.
--
-- WHY THE TABLE IS PUBLICLY READABLE
--   It holds two channel ids and two public artist names. Nothing private. The
--   build needs to read it with the anon key, and there is no version of this
--   data that is worth protecting. Writes are a different matter and go only
--   through the admin_* functions below, which re-check is_zemer_admin().
--
-- NO CHAINS, BY CONSTRUCTION
--   admin_merge_artists resolves the canonical to ITS canonical before writing,
--   and re-points anything already folded into the alias. So the table is always
--   exactly one level deep and the build never has to walk a chain or guard
--   against a cycle. That invariant is enforced here, not assumed there.
-- ============================================================================


create table if not exists public.zemer_artist_merge (
  alias_id       text primary key,        -- the duplicate channel id, which disappears from the catalog
  canonical_id   text not null,           -- the channel id it folds into
  alias_name     text,                    -- names are snapshots for the console; the catalog is the source of truth
  canonical_name text,
  merged_by      text not null,
  merged_at      timestamptz not null default now(),
  constraint zam_not_self check (alias_id <> canonical_id)
);
create index if not exists idx_zam_canonical on public.zemer_artist_merge (canonical_id);

alter table public.zemer_artist_merge enable row level security;

drop policy if exists "merges are public" on public.zemer_artist_merge;
create policy "merges are public" on public.zemer_artist_merge for select using (true);

grant select on public.zemer_artist_merge to anon, authenticated;
-- Writes are RPC-only. Without this revoke, RLS with no INSERT policy would already
-- block them, but being explicit means a future permissive policy can't quietly open it.
revoke insert, update, delete on public.zemer_artist_merge from anon, authenticated;


-- ---------------------------------------------------------------------------
-- admin_merge_artists — fold p_alias into p_canonical.
--
-- Returns the canonical actually used, which may NOT be the one passed in: if
-- the caller picked a channel that is itself already an alias, the merge follows
-- through to the real canonical rather than creating a chain.
-- ---------------------------------------------------------------------------
create or replace function public.admin_merge_artists(
  p_alias          text,
  p_canonical      text,
  p_alias_name     text default null,
  p_canonical_name text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_canon text;
  v_moved int := 0;
  v_who   text;
begin
  perform public.admin_guard();

  if coalesce(p_alias, '') = '' or coalesce(p_canonical, '') = '' then
    raise exception 'both channel ids are required';
  end if;
  if p_alias = p_canonical then
    raise exception 'an artist cannot be merged into itself';
  end if;

  -- Follow the target to its own canonical, so the table stays one level deep.
  select m.canonical_id into v_canon
  from public.zemer_artist_merge m where m.alias_id = p_canonical;
  v_canon := coalesce(v_canon, p_canonical);

  if v_canon = p_alias then
    raise exception 'that would create a loop: % is already the canonical for %', p_alias, p_canonical;
  end if;

  -- Anything previously folded into the alias has to follow it to the new home,
  -- or it would be left pointing at an id the build no longer emits.
  update public.zemer_artist_merge set canonical_id = v_canon where canonical_id = p_alias;
  get diagnostics v_moved = row_count;

  v_who := coalesce(auth.jwt() ->> 'email', auth.uid()::text, 'admin');

  insert into public.zemer_artist_merge
    (alias_id, canonical_id, alias_name, canonical_name, merged_by)
  values (p_alias, v_canon, p_alias_name, p_canonical_name, v_who)
  on conflict (alias_id) do update set
    canonical_id   = excluded.canonical_id,
    alias_name     = excluded.alias_name,
    canonical_name = excluded.canonical_name,
    merged_by      = excluded.merged_by,
    merged_at      = now();

  return jsonb_build_object('alias', p_alias, 'canonical', v_canon, 'repointed', v_moved);
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_unmerge_artist — undo one merge. The artist reappears on the next build.
-- ---------------------------------------------------------------------------
create or replace function public.admin_unmerge_artist(p_alias text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  perform public.admin_guard();
  delete from public.zemer_artist_merge where alias_id = p_alias;
  get diagnostics v_n = row_count;
  return jsonb_build_object('alias', p_alias, 'removed', v_n);
end;
$$;


-- ---------------------------------------------------------------------------
-- admin_list_merges — everything currently merged, newest first.
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_merges()
returns jsonb
language plpgsql security definer set search_path = '' stable as $$
declare v_out jsonb;
begin
  perform public.admin_guard();
  select coalesce(jsonb_agg(jsonb_build_object(
           'alias_id',       m.alias_id,
           'canonical_id',   m.canonical_id,
           'alias_name',     m.alias_name,
           'canonical_name', m.canonical_name,
           'merged_by',      m.merged_by,
           'merged_at',      m.merged_at
         ) order by m.merged_at desc), '[]'::jsonb)
  into v_out from public.zemer_artist_merge m;
  return jsonb_build_object('merges', v_out);
end;
$$;


revoke all on function public.admin_merge_artists(text, text, text, text) from public, anon;
revoke all on function public.admin_unmerge_artist(text)                  from public, anon;
revoke all on function public.admin_list_merges()                         from public, anon;
grant execute on function public.admin_merge_artists(text, text, text, text) to authenticated;
grant execute on function public.admin_unmerge_artist(text)                  to authenticated;
grant execute on function public.admin_list_merges()                         to authenticated;
