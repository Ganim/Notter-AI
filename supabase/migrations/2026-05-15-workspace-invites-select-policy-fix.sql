-- Hotfix: invites_select_members_or_invitee originally read auth.users via
-- subquery, but the `authenticated` role has no SELECT on auth.users → RLS
-- evaluation failed with `permission denied for table users` (SQLSTATE 42501),
-- which made any INSERT into workspace_invites return 403 via PostgREST
-- (.insert().select() requires SELECT on the inserted row to return it).
--
-- Fix: read the email from the JWT claim (auth.jwt() ->> 'email') instead of
-- subquerying auth.users. The JWT is always present for `authenticated` callers
-- and contains the email claim; no extra privilege needed.

DROP POLICY IF EXISTS "invites_select_members_or_invitee" ON workspace_invites;
CREATE POLICY "invites_select_members_or_invitee" ON workspace_invites
  FOR SELECT USING (
    is_workspace_member(workspace_id)
    OR lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
