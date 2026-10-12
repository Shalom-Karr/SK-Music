-- ============================================================================
-- SK Music — signed-out limits: one more security event kind (database side).
--
-- WHY
--   The Worker now limits visitors without an account (engine/security.mjs, docs/anon-limits.md): 5 detail
--   pages and 1 song start per 7 minutes per client, and no search dataset. Each refusal is logged as a
--   `signin_required` security event (detail: {kind: "detail"|"play"|"search", via: "ip"|"xff"|"device"}),
--   batched and deduped like every other event. security_log only accepts the kinds it lists, so without this
--   file those events are silently dropped (the limits themselves work either way — they need no database).
--
-- WHAT
--   security_log: re-created with the kind `signin_required` added to the list from catalog-gate.sql.
--   Nothing else changes; no table, column or grant is added.
--
-- APPLY (order matters)
--   Run AFTER supabase/security.sql and supabase/catalog-gate.sql (refuses to run, changing nothing, if
--   either is missing). SQL Editor -> paste -> Run. Idempotent: safe to re-run.
--   Re-running security.sql or catalog-gate.sql later restores their shorter kind list — re-run this file
--   after either.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.security_require_token(text)') is null
     or to_regprocedure('public.security_norm_ip(text)') is null
     or to_regclass('public.security_events') is null then
    raise exception 'anon-limits.sql requires supabase/security.sql — run it first, then re-run this file.';
  end if;
  if to_regprocedure('public.catalog_state(text)') is null then
    raise exception 'anon-limits.sql requires supabase/catalog-gate.sql — run it first, then re-run this file.';
  end if;
end $$;

-- Same body as catalog-gate.sql, plus the kind `signin_required`.
create or replace function public.security_log(p_token text, p_events jsonb)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int := 0;
begin
  perform public.security_require_token(p_token);
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return 0;
  end if;

  insert into public.security_events (kind, ip, user_id, email, asn, as_org, path, ua, detail)
  select e->>'kind',
         public.security_norm_ip(e->>'ip'),
         case when (e->>'user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (e->>'user_id')::uuid end,
         left(nullif(lower(btrim(e->>'email')), ''), 320),
         case when (e->>'asn') ~ '^\d{1,9}$' then (e->>'asn')::int end,
         left(e->>'as_org', 200),
         left(e->>'path', 512),
         left(e->>'ua', 512),
         case when jsonb_typeof(e->'detail') in ('object', 'array') and length((e->'detail')::text) <= 4000
              then e->'detail' end
  from jsonb_array_elements(p_events) with ordinality as t(e, ord)
  where t.ord <= 50
    and jsonb_typeof(e) = 'object'
    and e->>'kind' in ('rate_limited', 'datacenter_block', 'banned_hit', 'auto_ban', 'account_required', 'quota_exceeded',
                       'signin_required');
  get diagnostics n = row_count;

  -- Retention: opportunistic, ~1 in 200 calls.
  if random() < 0.005 then
    delete from public.security_events where created_at < now() - interval '90 days';
  end if;
  return n;
end $$;

revoke all on function public.security_log(text, jsonb) from public, anon, authenticated;
grant execute on function public.security_log(text, jsonb) to anon;
