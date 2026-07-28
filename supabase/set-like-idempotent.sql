-- Idempotent like RPC — deploy this in the Supabase SQL editor, THEN switch the client to it.
--
-- WHY: the existing `toggle_like(video_id)` is a non-idempotent FLIP (delete-if-present-else-insert).
-- The signed-out → signed-in like merge, and any per-toggle sync, rely on the local and server flips
-- staying in lockstep. Two flips that both observe a song as absent (two devices' first login at once;
-- a tap racing the login merge) net to the song being DELETED, and a dropped unlike resurrects on the
-- next merge. An RPC that sets an ABSOLUTE state removes every one of those races at the source.
--
-- ORDER OF OPERATIONS (important — do not switch the client before this is live):
--   1. Run this file in Supabase (adds set_like alongside the existing toggle_like; nothing breaks yet).
--   2. Only then deploy the client change that calls set_like(video_id, liked) instead of toggle_like.
--      Until step 2 the client keeps using toggle_like and behaves exactly as today.
--
-- set_like(video_id, liked) — push an absolute like state. Safe to call any number of times:
--   liked = true  → INSERT ... ON CONFLICT DO NOTHING   (idempotent add)
--   liked = false → DELETE                              (idempotent remove)
-- Returns the resulting state (always equals p_liked).

create or replace function public.set_like(
  p_video_id text,
  p_liked boolean,
  p_title text default null,
  p_artist text default null
)
returns boolean
language plpgsql security invoker as $$
begin
  if p_liked then
    insert into public.zemer_like (user_id, video_id, title, artist)
      values (auth.uid(), p_video_id, p_title, p_artist)
      on conflict (user_id, video_id) do nothing;
    return true;
  else
    delete from public.zemer_like where user_id = auth.uid() and video_id = p_video_id;
    return false;
  end if;
end $$;

-- Grant to the same roles the other user RPCs use (match toggle_like's grants in schema.sql).
grant execute on function public.set_like(text, boolean, text, text) to authenticated;
