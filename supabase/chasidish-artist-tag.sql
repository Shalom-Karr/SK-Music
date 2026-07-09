-- ============================================================================
-- Chasidish-artist tagging — a shared table the tagger tool (/chasidish-tagger)
-- reads and writes so multiple contributors can collaborate. Run ONCE in the
-- Supabase SQL Editor (project jxttqcouabdptftlvfnd). IDEMPOTENT: safe to re-run.
--
-- No RLS: open to the publishable anon key (low-value curation data, attributed
-- by `contributor`). Access is governed purely by the GRANTs below. Supabase will
-- flag it as "public / RLS disabled" — that's intended (same as israeli_artist_tag).
-- ============================================================================

create table if not exists public.chasidish_artist_tag (
  channel_id    text primary key,          -- the artist's YouTube channel id (UC…)
  name          text,                       -- artist name (convenience copy)
  is_chasidish  boolean not null,
  contributor   text,                       -- who set it (a name/handle from the tool)
  updated_at    timestamptz not null default now()
);
create index if not exists idx_cat_updated on public.chasidish_artist_tag (updated_at desc);

-- keep updated_at fresh on every insert/update (so it also advances on upsert)
create or replace function public.cat_touch() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists cat_touch on public.chasidish_artist_tag;
create trigger cat_touch before insert or update on public.chasidish_artist_tag
  for each row execute function public.cat_touch();

-- Open access (no row-level security), governed by grants only.
alter table public.chasidish_artist_tag disable row level security;
grant select, insert, update, delete on public.chasidish_artist_tag to anon, authenticated;
