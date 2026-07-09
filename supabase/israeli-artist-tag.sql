-- ============================================================================
-- Israeli-artist tagging — a shared table the tagger tool
-- (israeli-artist-tagger.html) reads and writes so multiple contributors can
-- collaborate. Run ONCE in the Supabase SQL Editor (project jxttqcouabdptftlvfnd).
-- IDEMPOTENT: safe to re-run.
--
-- No RLS: the table is open to the publishable anon key (low-value curation
-- data, attributed by `contributor`). Access is governed purely by the GRANTs
-- below. Supabase will flag it as "public / RLS disabled" — that's intended.
-- ============================================================================

create table if not exists public.israeli_artist_tag (
  channel_id  text primary key,          -- the artist's YouTube channel id (UC…)
  name        text,                       -- artist name (convenience copy)
  is_israeli  boolean not null,
  contributor text,                       -- who set it (a name/handle from the tool)
  updated_at  timestamptz not null default now()
);
create index if not exists idx_iat_updated on public.israeli_artist_tag (updated_at desc);

-- keep updated_at fresh on every insert/update (so it also advances on upsert)
create or replace function public.iat_touch() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists iat_touch on public.israeli_artist_tag;
create trigger iat_touch before insert or update on public.israeli_artist_tag
  for each row execute function public.iat_touch();

-- Open access (no row-level security), governed by grants only.
alter table public.israeli_artist_tag disable row level security;
grant select, insert, update, delete on public.israeli_artist_tag to anon, authenticated;
