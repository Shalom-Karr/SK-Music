-- ============================================================================
-- Ensure a CORRECT PIN resets the failed-attempt counter to 0 (and clears any
-- lockout). This is already part of parental-hardlock.sql; re-apply it here to
-- GUARANTEE your database has this version. IDEMPOTENT (CREATE OR REPLACE).
-- Run once in the Supabase SQL Editor (project jxttqcouabdptftlvfnd).
-- ============================================================================
create or replace function public.pc_check_pin(p_pin text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare u public.zemer_user;
begin
  select * into u from public.zemer_user where id = auth.uid();
  if u.id is null then return false; end if;
  if u.pin_hash is null then return true; end if;                          -- no PIN set → open
  if u.pin_locked_until is not null and u.pin_locked_until > now() then
    raise exception 'PIN locked — too many attempts. Try again later.';
  end if;
  if u.pin_hash = extensions.crypt(coalesce(p_pin, ''), u.pin_hash) then    -- CORRECT → reset counter + clear lockout
    update public.zemer_user set pin_fails = 0, pin_locked_until = null where id = u.id and pin_fails <> 0;
    return true;
  end if;
  update public.zemer_user                                                  -- wrong → count; lock after 5, escalating
     set pin_fails = pin_fails + 1,
         pin_locked_until = case when pin_fails + 1 >= 5
           then now() + make_interval(secs => least(900, (30 * power(2, pin_fails + 1 - 5))::int))
           else pin_locked_until end
   where id = u.id;
  return false;
end $$;
revoke execute on function public.pc_check_pin(text) from public, anon, authenticated;
