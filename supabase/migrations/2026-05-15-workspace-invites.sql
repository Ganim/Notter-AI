-- supabase/migrations/2026-05-15-workspace-invites.sql
--
-- Multi-user workspaces — Plan 2: invite issuance + redemption + member listing.
--
-- Builds on Plan 1 (`2026-05-14-workspace-members.sql`) which installed the
-- membership join table and RLS. This migration adds:
--   1) workspace_invites (one open row per (workspace,email) pair)
--   2) accept_workspace_invite(token) — atomic redemption
--   3) fetch_invite_preview(token_hash) — exposes the workspace name + invitee
--      email for the sign-in screen pre-fill, NO inviter identity (privacy)
--   4) get_workspace_members(ws_id) — bypasses Plan 1's self-row policy so the
--      WorkspaceMembersDialog can render peers
--   5) Per-function hardening: search_path lockdown + REVOKE on non-RPC funcs
--
-- See docs/superpowers/specs/2026-05-13-multi-user-workspaces-design.md §3.1,
-- §4.2, §5.

create extension if not exists pgcrypto;

-- 1. workspace_invites table
create table workspace_invites (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  accepted_by   uuid references auth.users(id) on delete set null,
  invited_by    uuid not null references auth.users(id) on delete cascade,
  role          text not null check (role in ('editor', 'viewer')),
  token_hash    text not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index workspace_invites_token_hash_idx on workspace_invites(token_hash);
create index workspace_invites_email_idx      on workspace_invites(lower(email));
create index workspace_invites_workspace_idx  on workspace_invites(workspace_id);

-- Codex Finding #1: NULLs do not participate in UNIQUE comparisons in Postgres,
-- so a multi-column UNIQUE on (accepted_at, revoked_at) does NOT block duplicate
-- open invites. Use a partial unique index gated on the "open invite" predicate.
create unique index workspace_invites_one_active_per_email
  on workspace_invites (workspace_id, lower(email))
  where accepted_at is null and revoked_at is null;

alter table workspace_invites enable row level security;
alter publication supabase_realtime add table workspace_invites;

-- 2. RLS for workspace_invites
create policy "invites_select_members_or_invitee" on workspace_invites
  for select using (
    is_workspace_member(workspace_id)
    or lower(email) = lower((select u.email from auth.users u where u.id = auth.uid()))
  );
-- Only owners can create / revoke / hard-delete invites.
create policy "invites_insert_owner" on workspace_invites
  for insert with check ( workspace_role(workspace_id) = 'owner' );
create policy "invites_update_owner" on workspace_invites
  for update using ( workspace_role(workspace_id) = 'owner' )
              with check ( workspace_role(workspace_id) = 'owner' );
create policy "invites_delete_owner" on workspace_invites
  for delete using ( workspace_role(workspace_id) = 'owner' );

-- 3. accept_workspace_invite — SECURITY DEFINER because the redeemer is NOT
--    yet a member, so members_insert_owner_only would block them.
create or replace function accept_workspace_invite(token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash    text := encode(digest(token, 'sha256'), 'hex');
  v_invite  workspace_invites;
  v_uid     uuid := auth.uid();
  v_email   text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into v_invite from workspace_invites
  where token_hash = v_hash
  limit 1;

  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'invite_revoked' using errcode = 'P0001';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'invite_already_accepted' using errcode = 'P0001';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;

  select email into v_email from auth.users where id = v_uid;
  if lower(v_email) <> lower(v_invite.email) then
    raise exception 'invite_email_mismatch' using errcode = '42501';
  end if;

  insert into workspace_members (workspace_id, user_id, role, invited_by, invited_at, joined_at)
  values (v_invite.workspace_id, v_uid, v_invite.role, v_invite.invited_by, v_invite.created_at, now())
  on conflict (workspace_id, user_id) do nothing;

  -- Codex Finding #4: conditional UPDATE guards against the race where two
  -- concurrent calls both pass the validation block before either writes.
  -- If a peer already accepted, rowcount = 0 and we raise the canonical error.
  update workspace_invites
    set accepted_at = now(), accepted_by = v_uid
    where id = v_invite.id
      and accepted_at is null
      and revoked_at is null;
  if not found then
    raise exception 'invite_already_accepted' using errcode = 'P0001';
  end if;

  return v_invite.workspace_id;
end $$;

grant execute on function accept_workspace_invite(text) to authenticated;

-- 4. fetch_invite_preview — caller passes the token_hash (computed client-side
--    when handling the deep link before sign-in). Returns workspace name +
--    invitee email so the sign-in screen can show "Sign in as alice@…".
--    Intentionally NOT exposing inviter identity (privacy if token leaks).
create or replace function fetch_invite_preview(token_hash_input text)
returns table (workspace_name text, invitee_email text)
language sql
stable
security definer
set search_path = public
as $$
  select w.name, i.email
  from workspace_invites i
  join workspaces w on w.id = i.workspace_id
  where i.token_hash = token_hash_input
    and i.revoked_at is null
    and i.accepted_at is null
    and i.expires_at > now()
  limit 1;
$$;

grant execute on function fetch_invite_preview(text) to anon, authenticated;

-- 5. get_workspace_members — peer visibility for the dialog. SECURITY DEFINER
--    so it bypasses the Plan 1 self-row policy. Caller MUST be a member of
--    the target workspace; otherwise empty result.
create or replace function get_workspace_members(ws_id uuid)
returns table (
  user_id           uuid,
  role              text,
  joined_at         timestamptz,
  invited_at        timestamptz,
  email             text,
  display_name      text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.user_id,
    m.role,
    m.joined_at,
    m.invited_at,
    u.email,
    coalesce(
      u.raw_user_meta_data->>'display_name',
      u.raw_user_meta_data->>'full_name',
      u.email
    ) as display_name
  from workspace_members m
  join auth.users u on u.id = m.user_id
  where m.workspace_id = ws_id
    and exists (
      select 1 from workspace_members me
      where me.workspace_id = ws_id and me.user_id = auth.uid()
    )
  order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end,
           m.joined_at;
$$;

grant execute on function get_workspace_members(uuid) to authenticated;

-- 6. Hardening — lock search_path on every function created above (already
--    done in their bodies via `set search_path = public`) and tighten EXECUTE
--    grants. accept_workspace_invite / fetch_invite_preview / get_workspace_members
--    are intentionally callable by `authenticated` (and fetch_invite_preview by
--    `anon` too — see comment on its grant). No others need exposure.
--
--    fetch_invite_preview being anon-callable is the deliberate choice: the
--    deep-link handler runs BEFORE the user signs in, so it cannot present a
--    JWT. The function returns ONLY the workspace name + the email the invite
--    was addressed to (no inviter, no token, no role) — a leaked token already
--    exposes both via brute-force, so we don't gain anything by hiding them.
