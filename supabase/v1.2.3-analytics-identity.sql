-- ============================================================================
-- SK Music 1.2.3 — attach account identity to analytics events
--
-- Run AFTER v1.2.2-admin.sql. Idempotent: safe to re-run.
--
-- WHAT CHANGES: zemer_analytics gains a nullable user_id. Signed-in clients send
-- their id with the beacon; anonymous ones send nothing and the column stays
-- NULL. That single column is what turns the admin console's "recently played"
-- into a real per-song history, and what makes signed-in vs anonymous a
-- measurable split on the analytics dashboard.
--
-- TRUST MODEL — important, and deliberately narrow:
--   The beacon is UNAUTHENTICATED. The Worker takes the id from the request body
--   and does not verify it against a JWT (it has only the anon key, not the
--   project's JWT secret, so it cannot check a signature; resolving the token
--   against /auth/v1/user would mean a round trip per event). A hostile client
--   can therefore write events tagged with someone else's id.
--
--   That is acceptable ONLY because user_id here is analytics attribution and
--   NOTHING else: it grants no access, gates no content, and is never read to
--   make an authorization decision. It is displayed to admins as observed
--   history, which is exactly as trustworthy as the rest of the analytics
--   stream (ip, user agent and session are equally client-influenced).
--
--   Do NOT extend this column into any access-control path. If per-user history
--   ever needs to be trustworthy, the beacon has to carry a verified token.
-- ============================================================================

alter table public.zemer_analytics
  add column if not exists user_id uuid;

-- Deliberately NOT a foreign key to auth.users: analytics is append-only and
-- must never fail an insert (or cascade-delete history) because of an account's
-- lifecycle. A deleted user's rows simply keep an id that no longer resolves.

-- The admin console's per-user history is "this user's plays, newest first".
create index if not exists idx_za_user_created
  on public.zemer_analytics (user_id, created_at desc)
  where user_id is not null;

-- The dashboard's signed-in vs anonymous split scans by day over the window.
create index if not exists idx_za_created_user
  on public.zemer_analytics (created_at desc, user_id);


-- ---------------------------------------------------------------------------
-- admin_user_history — the real per-song play history for one user.
-- Admin-gated exactly like the rest of the admin_* family.
-- ---------------------------------------------------------------------------
create or replace function public.admin_user_history(
  p_user  uuid,
  p_days  int default 90,
  p_limit int default 300
)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare
  v_rows jsonb;
  v_lim  int := least(greatest(coalesce(p_limit, 300), 1), 1000);
  v_days int := least(greatest(coalesce(p_days, 90), 1), 3650);
begin
  perform public.admin_guard();

  select coalesce(jsonb_agg(jsonb_build_object(
           'at',      a.created_at,
           'event',   a.event,
           'videoId', a.meta ->> 'v',
           'title',   a.meta ->> 'title',
           'artist',  a.meta ->> 'artist',
           'seconds', a.meta ->> 'seconds',
           'source',  a.meta ->> 'source'
         ) order by a.created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select created_at, event, meta
    from public.zemer_analytics
    where user_id = p_user
      and event = 'play'
      and created_at >= now() - make_interval(days => v_days)
    order by created_at desc
    limit v_lim
  ) a;

  return jsonb_build_object('days', v_days, 'plays', v_rows);
end;
$$;

revoke all on function public.admin_user_history(uuid, int, int) from public, anon;
grant execute on function public.admin_user_history(uuid, int, int) to authenticated;


-- ---------------------------------------------------------------------------
-- identity_split — signed-in vs anonymous, for the dashboard card.
-- Counts DISTINCT people, not events: an account is one person however many
-- times they play something, and an anonymous visitor is counted by their
-- per-visitor id (meta->>'vid'), falling back to session so older rows still
-- register. Event counts are returned alongside because the two tell different
-- stories (accounts tend to play far more per head).
--
-- Readable by anyone: it returns only two integers and leaks nothing about who.
-- ---------------------------------------------------------------------------
create or replace function public.identity_split(days int default 7)
returns jsonb
language sql security definer set search_path = public stable as $$
  with w as (
    select user_id, meta ->> 'vid' as vid, session
    from public.zemer_analytics
    where created_at >= now() - make_interval(days => greatest(least(days, 3650), 1))
  )
  select jsonb_build_object(
    'days',          greatest(least(days, 3650), 1),
    'users_account', (select count(distinct user_id) from w where user_id is not null),
    'users_anon',    (select count(distinct coalesce(vid, session)) from w
                        where user_id is null and coalesce(vid, session) is not null),
    'events_account',(select count(*) from w where user_id is not null),
    'events_anon',   (select count(*) from w where user_id is null)
  );
$$;

grant execute on function public.identity_split(int) to anon, authenticated;
