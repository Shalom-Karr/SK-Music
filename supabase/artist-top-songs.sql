-- Per-artist trending: one artist's most-played songs over the last N days.
-- Feeds the Worker's /artist-trending route (the "Trending Songs" rail at the top of an artist page),
-- which blends these web plays with the Zemer app's plays for the same artist.
--
-- Same rules as public.top_songs (qualified plays only, titled rows only), scoped to one artist.
-- Web plays are recorded under the catalog artist name, so the match is on that name (case- and
-- whitespace-insensitive). Idempotent: safe to re-run. Run once in the Supabase SQL editor.

create or replace function public.artist_top_songs(p_artist text, days int default 30, lim int default 24)
returns table (video_id text, title text, artist text, plays bigint)
language sql security definer set search_path = public stable as $$
  select meta->>'v' as video_id,
    (array_agg(meta->>'title'  order by created_at desc))[1] as title,
    (array_agg(meta->>'artist' order by created_at desc))[1] as artist,
    count(*)::bigint as plays
  from public.zemer_analytics
  where event = 'play'
    and created_at >= now() - (greatest(1, least(365, days)) * interval '1 day')
    and coalesce(meta->>'qualified', 'true') <> 'false'
    and coalesce(meta->>'v', '') <> '' and coalesce(meta->>'title', '') <> ''
    and lower(regexp_replace(trim(meta->>'artist'), '\s+', ' ', 'g'))
        = lower(regexp_replace(trim(coalesce(p_artist, '')), '\s+', ' ', 'g'))
  group by meta->>'v'
  order by plays desc, max(created_at) desc
  limit greatest(1, least(100, lim));
$$;

grant execute on function public.artist_top_songs(text, int, int) to anon, authenticated;
