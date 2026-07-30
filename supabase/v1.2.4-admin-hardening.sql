-- ============================================================================
-- SK Music 1.2.4 — admin boundary hardening
--
-- Run AFTER v1.2.2-admin.sql and v1.2.3-analytics-identity.sql.
-- Idempotent, but see the LOCKOUT GUARD note before running.
--
-- Three fixes from a security review of the new admin console. None was
-- exploitable at the time of review; each removes a single point of failure that
-- was one dashboard toggle or one stray policy away from full compromise.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Key admin on auth.uid(), not on the email claim.
--
-- is_zemer_admin() matched `auth.jwt() ->> 'email'`. Email is the ONE identity
-- attribute a user can ask GoTrue to change. It is not forgeable today only
-- because the project has "Confirm email" enabled — an unversioned dashboard
-- setting that nothing in this repo enforces. Turn it off to reduce signup
-- friction and the whole admin boundary silently falls: change your email to an
-- admin's, refresh the token, and is_zemer_admin() returns true.
--
-- auth.uid() comes from the `sub` claim, which a user can never influence.
--
-- (Checking email_confirmed_at instead is NOT sufficient: under autoconfirm
-- GoTrue stamps email_confirmed_at as part of the same immediate change.)
--
-- LOCKOUT GUARD: the backfill below matches existing zemer_admin rows to
-- auth.users by email. If ANY row has no matching user, this script raises and
-- rolls back WITHOUT swapping the function — so a half-applied migration can
-- never lock every admin out. Create the missing auth user, then re-run.
-- ---------------------------------------------------------------------------
alter table public.zemer_admin add column if not exists user_id uuid;

update public.zemer_admin za
   set user_id = au.id
  from auth.users au
 where au.email = za.email
   and za.user_id is null;

do $$
declare n int;
begin
  select count(*) into n from public.zemer_admin where user_id is null;
  if n > 0 then
    raise exception
      'zemer_admin has % row(s) with no matching auth.users row. Create those users in Authentication -> Users first, then re-run — refusing to switch is_zemer_admin() while any admin would lose access.', n;
  end if;
end $$;

create unique index if not exists idx_zemer_admin_user on public.zemer_admin (user_id);

create or replace function public.is_zemer_admin()
returns boolean
language sql security definer set search_path = '' stable
as $$
  select exists (select 1 from public.zemer_admin where user_id = auth.uid());
$$;

-- The dashboard confirms its own membership by reading its row; scope that to
-- the same immutable identity rather than to the email.
drop policy if exists "read own admin row" on public.zemer_admin;
create policy "read own admin row" on public.zemer_admin
  for select to authenticated
  using (user_id = auth.uid());


-- ---------------------------------------------------------------------------
-- 2. Strip the residual default grants.
--
-- These tables had RLS enabled but never had the default table privileges
-- revoked. RLS default-deny was therefore the ONLY barrier — one accidental
-- `create policy ... for all` or `disable row level security` away from
-- disaster. Proof it was privilege-not-policy: inserting into zemer_admin as
-- authenticated returned "new row violates row-level security policy" rather
-- than "permission denied for table", and Postgres only reaches the RLS check
-- after the table privilege check passes.
--
-- NOTE the deliberate exception for zemer_analytics: the Worker posts the
-- beacon with the ANON key (schema.sql: "Anyone (the anon key the Worker uses)
-- may INSERT analytics rows"), so INSERT for anon is load-bearing and must
-- survive. Everything else on that table goes.
-- ---------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger
  on public.zemer_admin from anon, authenticated;
revoke all on public.zemer_admin from anon;   -- anon has no business reading the allowlist

revoke all on public.zemer_user  from anon;   -- anon held SELECT on every column, pin_hash included
revoke all on public.zemer_like  from anon;

revoke select, update, delete, truncate, references, trigger
  on public.zemer_analytics from anon;        -- INSERT deliberately retained (the beacon)


-- ---------------------------------------------------------------------------
-- 3. admin_guard() — Supabase grants EXECUTE to `authenticated` by default at
-- creation time; only public/anon were revoked. Harmless (it raises or returns
-- void, telling a caller only what they already know) but tidy it up.
-- ---------------------------------------------------------------------------
revoke all on function public.admin_guard() from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- Verify (run these by hand after applying):
--
--   -- every admin row is now uid-keyed:
--   select email, user_id from public.zemer_admin;
--
--   -- you can still see your own row and the console still loads:
--   select public.is_zemer_admin();
--
--   -- the beacon still works — this must stay non-zero and climbing:
--   select count(*) from public.zemer_analytics where created_at > now() - interval '10 minutes';
-- ---------------------------------------------------------------------------
