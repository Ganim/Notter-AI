# Multi-User Workspaces — Plan 2 (Invites + Members Dialog + Role-Aware UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the user-facing half of multi-user workspaces on top of Plan 1's RLS substrate — invites with email + deep-link redemption, the members management dialog, and role-aware UI that hides/disables actions a viewer cannot take.

**Architecture:** Backend adds `workspace_invites` table plus three SECURITY DEFINER RPCs (`accept_workspace_invite`, `fetch_invite_preview`, `get_workspace_members`) and a Supabase Edge Function `send-workspace-invite` that calls Resend. Frontend adds `WorkspaceMembersDialog` (standalone, opened from `WorkspaceSwitcher`), an invite-acceptor module wired into the existing OAuth deep-link handler for `notterai://invite/<token>`, and role-aware gating in `PlannerTab` + `CommentsPanel` driven by `useWorkspacesStore.currentRole` (already populated by Plan 1).

**Tech Stack:** PostgreSQL 15 (Supabase) · pgcrypto · Supabase Edge Functions (Deno) · Resend API · Supabase JS · Zustand · Vitest · @tauri-apps/plugin-deep-link · React 19.

**Spec reference:** `docs/superpowers/specs/2026-05-13-multi-user-workspaces-design.md` §3, §5, §7, §8, §9, §11.2–§11.4. Plan 1 (`docs/superpowers/plans/2026-05-14-multi-user-workspaces-migration-a.md`) shipped the schema substrate; this plan ships everything visible to the user.

**Plan 2 scoping decisions (locked 2026-05-14):**
- WorkspaceMembersDialog: **standalone**, opened from `WorkspaceSwitcher`.
- Member-count badge in switcher: **show only when count > 1** (no clutter for single-user).
- "Leave workspace" button: **inside `WorkspaceMembersDialog`** (non-owner only).
- Peer-member visibility: **new SECURITY DEFINER RPC `get_workspace_members(ws_id)`** gated by `is_workspace_member(ws_id)`. The Plan 1 `members_read_self` policy is kept; the RPC bypasses RLS in a controlled, audited way.
- Email service: **Resend** (locked in Plan 1's spec-§12 review).
- Viewers CAN comment (own-only resolve/edit); `sharing_policy = 'disabled'` retroactively kills share-links — but those are Plan 3.

**Out of scope (deliberately deferred):**
- `sharing_policy` enum/column + UI (Plan 3).
- Ownership transfer (v2, per spec §2). UI exposes "Leave workspace" only to non-owners.
- Per-project ACLs inside a workspace.
- Branded Postmark templates (using Resend with a single transactional template).
- Membership-change rebuild debounce was a Plan-1 carry-over flag; this plan implements it as part of Task 7.

---

## File Structure

**Create:**
- `supabase/migrations/2026-05-15-workspace-invites.sql` — `workspace_invites` table, 3 SECURITY DEFINER RPCs, pgcrypto extension, hardening (search_path + revokes).
- `supabase/functions/send-workspace-invite/index.ts` — Deno edge function calling Resend.
- `supabase/functions/send-workspace-invite/deno.json` — Deno config for the function.
- `src/lib/workspaces/invite-acceptor.ts` — token → preview → accept → switch flow. No Tauri imports (web-shell ready).
- `src/components/WorkspaceMembersDialog.tsx` — standalone dialog (members list, pending invites, invite form, leave button).
- `src/lib/__tests__/sync-invites.test.ts` — vitest for the new RPC wrappers.
- `src/lib/workspaces/__tests__/invite-acceptor.test.ts` — vitest for the redemption flow.
- `src/stores/__tests__/workspaces-store-members.test.ts` — vitest for the members/invites slices.

**Modify:**
- `src/lib/sync.ts` — add `createWorkspaceInvite`, `revokeWorkspaceInvite`, `acceptWorkspaceInvite`, `fetchInvitePreview`, `fetchWorkspaceMembers`, `leaveWorkspace`. Also: fix the `upsertUserRows` time-bomb (`pushProjects` writes `user_id = caller`, not the workspace owner's id).
- `src/lib/synced-store.ts` — debounce `subscribeWorkspaceTable` rebuild on rapid membership changes (Plan 1 carry-over).
- `src/lib/realtime.ts` — subscribe to `workspace_invites` filtered by caller email so a logged-in user sees in-app invite notifications.
- `src/stores/workspaces-store.ts` — add `members: Record<string, WorkspaceMember[]>`, `pendingInvites: Record<string, WorkspaceInvite[]>`, reducers + derived getters.
- `src/lib/accounts/oauth-deep-link.ts` (or wherever the existing OAuth deep-link handler lives) — route `notterai://invite/<token>` to `invite-acceptor`.
- `src/components/WorkspaceSwitcher.tsx` — add "Members & invites" menu entry + conditional member-count chip.
- `src/components/PlannerTab.tsx` — read `currentRole` from store; mark Monaco `readOnly: true` and disable save/new-version toolbar when viewer.
- `src/components/plans/CommentsPanel.tsx` — keep compose enabled for viewers; hide resolve on others' comments for viewers.
- `src/i18n/locales/en.json` + `src/i18n/locales/pt-BR.json` — invite / members / leave strings.

---

## Phase 1 — Backend (Tasks 1–3)

## Task 1: Write the invites migration SQL

**Files:**
- Create: `supabase/migrations/2026-05-15-workspace-invites.sql`

- [ ] **Step 1: Create the migration file with the full body**

```sql
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
```

- [ ] **Step 2: Static lint pass**

Run: `git diff --check supabase/migrations/2026-05-15-workspace-invites.sql`
Expected: no whitespace warnings.

Read end-to-end. Verify:
- pgcrypto is created `if not exists` (idempotent).
- Every SECURITY DEFINER function has `set search_path = public`.
- Every `references` clause targets an existing table.
- Policy names are unique within `workspace_invites`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-05-15-workspace-invites.sql
git commit -m "$(cat <<'EOF'
feat(workspaces): migration B — workspace_invites + accept/preview/members RPCs

Plan 2, Task 1. Builds the invite issuance + redemption surface plus the
peer-member RPC the WorkspaceMembersDialog needs (Plan 1's self-row policy
on workspace_members can't show peers).

Spec: docs/superpowers/specs/2026-05-13-multi-user-workspaces-design.md §3.1,
§4.2, §5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Dry-run smoke + apply to prod

**Files:** none changed (operates via Supabase MCP against prod).

Plan 1 established the pattern: branch creation requires Pro plan, so we use `execute_sql` wrapped in `BEGIN; … ROLLBACK;` for dry-run, then `apply_migration` for the real deploy.

- [ ] **Step 1: Dry-run on prod via `execute_sql`**

Wrap the full Task 1 SQL in `BEGIN;` / `ROLLBACK;` and append a verification DO block:

```sql
do $$
declare
  v_policies int;
  v_funcs int;
  v_pgcrypto_present int;
begin
  -- workspace_invites policies present
  select count(*) into v_policies from pg_policies where tablename = 'workspace_invites';
  if v_policies <> 4 then raise exception 'expected 4 policies, found %', v_policies; end if;

  -- new functions all created
  select count(*) into v_funcs from pg_proc
    where proname in ('accept_workspace_invite','fetch_invite_preview','get_workspace_members');
  if v_funcs <> 3 then raise exception 'expected 3 RPCs, found %', v_funcs; end if;

  -- pgcrypto loaded
  select count(*) into v_pgcrypto_present from pg_extension where extname = 'pgcrypto';
  if v_pgcrypto_present <> 1 then raise exception 'pgcrypto missing'; end if;

  raise notice 'DRY RUN OK';
end $$;
```

Use `mcp__plugin_supabase_supabase__execute_sql` against `xeltsdrlopkfjnowpics`. Expected: empty result `[]`. Any error → fix the SQL.

- [ ] **Step 2: Verify rollback was clean**

```sql
select
  (select count(*)::int from pg_tables where tablename = 'workspace_invites') as wi_persisted,
  (select count(*)::int from pg_proc where proname = 'accept_workspace_invite') as rpc_persisted;
```
Expected: both 0.

- [ ] **Step 3: Apply to prod**

Use `mcp__plugin_supabase_supabase__apply_migration`, name `2026_05_15_workspace_invites`, query is the Task 1 Step 1 body verbatim.

Expected: `{"success":true}`.

- [ ] **Step 4: Verify migration landed**

```sql
select tablename, policyname from pg_policies where tablename = 'workspace_invites' order by policyname;
```
Expected 4 rows: `invites_delete_owner`, `invites_insert_owner`, `invites_select_members_or_invitee`, `invites_update_owner`.

```sql
select proname, prosecdef from pg_proc
where proname in ('accept_workspace_invite','fetch_invite_preview','get_workspace_members');
```
Expected 3 rows, all `prosecdef=t`.

- [ ] **Step 5: Run advisors**

`mcp__plugin_supabase_supabase__get_advisors` with `type: 'security'`. Expected: no new ERROR-level findings. The 3 new functions will likely add `authenticated_security_definer_function_executable` WARN entries — these are intentional (the functions are designed to be RPC-callable). Document and move on.

---

## Task 3: Resend Edge Function

**Files:**
- Create: `supabase/functions/send-workspace-invite/index.ts`
- Create: `supabase/functions/send-workspace-invite/deno.json`

The function is called by the client immediately after a successful invite INSERT (rather than relying on a database webhook), per spec §5.3. The raw token is passed in by the client (so the function never reads it back from DB and the token_hash stored there stays the only persistent reference).

- [ ] **Step 1: Create `deno.json`**

```json
{
  "imports": {
    "@supabase/supabase-js": "jsr:@supabase/supabase-js@^2"
  }
}
```

- [ ] **Step 2: Create `index.ts`**

```ts
// supabase/functions/send-workspace-invite/index.ts
//
// Sends a workspace invite email via Resend. Called by the client AFTER it
// has successfully inserted into workspace_invites. The token is supplied by
// the client (it's the raw value used for the URL) — the DB only stores the
// SHA-256 hash, so the function never round-trips through workspace_invites
// to fetch the token.
//
// Auth: callers must be authenticated. The function verifies that the caller
// is the owner of the workspace (matches the workspace_invites RLS guard).
//
// Env:
//   RESEND_API_KEY   — Resend API key (Supabase secret)
//   RESEND_FROM      — Verified Resend sender, e.g. "Notter <invites@notter.ai>"
//   APP_DEEP_LINK    — Defaults to "notterai://invite". Override per environment.

import { createClient } from '@supabase/supabase-js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface InvitePayload {
  invite_id: string;
  workspace_id: string;
  invitee_email: string;
  role: 'editor' | 'viewer';
  token: string; // raw, NOT hash
  inviter_display_name: string;
  workspace_name: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  const RESEND_FROM    = Deno.env.get('RESEND_FROM') ?? 'Notter <onboarding@resend.dev>';
  const APP_DEEP_LINK  = Deno.env.get('APP_DEEP_LINK') ?? 'notterai://invite';
  if (!RESEND_API_KEY) return json({ error: 'resend_not_configured' }, 500);

  // Verify caller's auth + ownership.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'unauthenticated' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const payload = (await req.json().catch(() => null)) as InvitePayload | null;
  if (!payload) return json({ error: 'invalid_payload' }, 400);

  // workspace_role() executes as the caller; verifies they're owner of this ws.
  const { data: role, error: roleErr } = await supabase.rpc('workspace_role', {
    ws_id: payload.workspace_id,
  });
  if (roleErr || role !== 'owner') return json({ error: 'forbidden' }, 403);

  // Codex Finding #2: the owner-of-workspace check is necessary but not
  // sufficient — without binding the payload to a real workspace_invites row,
  // an owner could send arbitrary (email, role, token) tuples. Re-fetch the
  // invite by id (scoped to the workspace) and verify every payload field
  // before composing the email. token is hashed and compared to token_hash.
  const tokenHashBuf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(payload.token),
  );
  const tokenHashHex = Array.from(new Uint8Array(tokenHashBuf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const { data: inviteRow, error: inviteErr } = await supabase
    .from('workspace_invites')
    .select('email, role, token_hash, accepted_at, revoked_at')
    .eq('id', payload.invite_id)
    .eq('workspace_id', payload.workspace_id)
    .maybeSingle();
  if (inviteErr || !inviteRow) return json({ error: 'invite_not_found' }, 404);
  if (inviteRow.accepted_at || inviteRow.revoked_at) return json({ error: 'invite_not_open' }, 409);
  if (inviteRow.token_hash !== tokenHashHex)        return json({ error: 'token_mismatch' }, 400);
  if (inviteRow.email.toLowerCase() !== payload.invitee_email.toLowerCase()) {
    return json({ error: 'email_mismatch' }, 400);
  }
  if (inviteRow.role !== payload.role) return json({ error: 'role_mismatch' }, 400);

  const link = `${APP_DEEP_LINK}/${payload.token}`;
  const safeName = escapeHtml(payload.workspace_name);
  const safeInviter = escapeHtml(payload.inviter_display_name);

  // Codex Finding #3: strip CRLF from subject-line interpolations to prevent
  // header injection into the Resend API call. HTML body is already escaped.
  const cleanPart = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const subject = `${cleanPart(payload.inviter_display_name)} convidou você para o workspace ${cleanPart(payload.workspace_name)}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 16px;font-size:18px">Convite para um workspace no Notter</h2>
      <p>${safeInviter} adicionou você como <b>${payload.role}</b> no workspace <b>${safeName}</b>.</p>
      <p style="margin:24px 0">
        <a href="${link}" style="background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">
          Abrir convite no Notter
        </a>
      </p>
      <p style="color:#666;font-size:13px">
        Se o botão não funcionar, copie o link:<br>
        <code>${link}</code>
      </p>
      <p style="color:#999;font-size:12px;margin-top:32px">
        Este convite expira em 7 dias. Se você não reconhece o remetente, ignore este email.
      </p>
    </div>
  `;

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [payload.invitee_email],
      subject,
      html,
    }),
  });

  if (!resendRes.ok) {
    const detail = await resendRes.text().catch(() => '');
    return json({ error: 'resend_failed', detail, status: resendRes.status }, 502);
  }

  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
```

- [ ] **Step 3: Configure Resend API key as Supabase secret**

User-driven step (no agent action). Tell the user:
> Set the `RESEND_API_KEY` secret on the Supabase project via dashboard → Edge Functions → Secrets, OR via `supabase secrets set RESEND_API_KEY=<key>` if Supabase CLI is installed. Also set `RESEND_FROM` to your verified sender (default `onboarding@resend.dev` works only for the Resend test account).

- [ ] **Step 4: Deploy the function**

Use `mcp__plugin_supabase_supabase__deploy_edge_function` with project `xeltsdrlopkfjnowpics`, name `send-workspace-invite`, files = the two files above.

Expected: success.

- [ ] **Step 5: Verify deployment**

```bash
# Quick health check — get_edge_function should now list it
```
Use `mcp__plugin_supabase_supabase__list_edge_functions` against `xeltsdrlopkfjnowpics`. Expect `send-workspace-invite` in the response.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/send-workspace-invite/
git commit -m "$(cat <<'EOF'
feat(workspaces): send-workspace-invite Edge Function (Resend)

Plan 2, Task 3. Deno-based edge function called by the client right after a
successful invite INSERT. Verifies the caller is the workspace owner via
workspace_role() RPC, then POSTs to Resend with a transactional template
carrying the notterai://invite/<token> deep link.

Requires Supabase secrets RESEND_API_KEY (mandatory) and RESEND_FROM
(optional; defaults to Resend's onboarding sender).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — TS sync layer (Tasks 4–7)

## Task 4: sync.ts — invite/member/leave RPC wrappers

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 1: Add the new types and wrappers at the end of `sync.ts`**

```ts
// ── Workspace invites ────────────────────────────────────────────────

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  email: string;
  invitedBy: string;
  role: 'editor' | 'viewer';
  expiresAt: string;
  revokedAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: string;
  invitedAt: string | null;
  email: string;
  displayName: string;
}

/**
 * Generate a 32-byte URL-safe token + its SHA-256 hash. Token goes in the
 * invite URL + email; hash is what's stored in workspace_invites.token_hash.
 *
 * crypto.subtle.digest is async + browser-native; works in Tauri's WebView.
 */
export async function generateInviteToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return { token, tokenHash };
}

/**
 * INSERT into workspace_invites under the caller's RLS (owner-only). Returns
 * the row id on success. The CALLER is responsible for then invoking the
 * send-workspace-invite Edge Function with the raw token.
 */
export async function createWorkspaceInvite(args: {
  workspaceId: string;
  email: string;
  role: 'editor' | 'viewer';
  tokenHash: string;
  expiresAtIso: string;
}): Promise<
  | { ok: true; id: string }
  | { ok: false; code: 'duplicate_open_invite' | 'forbidden' | 'unknown'; message: string }
> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { data, error } = await supabase
      .from('workspace_invites')
      .insert({
        workspace_id: args.workspaceId,
        email: args.email.trim().toLowerCase(),
        role: args.role,
        token_hash: args.tokenHash,
        expires_at: args.expiresAtIso,
        invited_by: (await supabase.auth.getUser()).data.user?.id,
      })
      .select('id')
      .single();
    if (error) {
      if ((error as any).code === '23505') {
        return { ok: false, code: 'duplicate_open_invite', message: error.message };
      }
      if ((error as any).code === '42501') {
        return { ok: false, code: 'forbidden', message: error.message };
      }
      console.error('[sync] createWorkspaceInvite failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true, id: data.id };
  } catch (e: any) {
    console.error('[sync] createWorkspaceInvite threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

/**
 * Soft-delete an open invite via UPDATE workspace_invites SET revoked_at = now().
 * Owner-only (RLS-policed).
 */
export async function revokeWorkspaceInvite(inviteId: string): Promise<{ ok: boolean; message?: string }> {
  if (!isSupabaseConfigured) return { ok: false, message: 'supabase not configured' };
  try {
    const { error } = await supabase
      .from('workspace_invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', inviteId);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}

/**
 * Call the accept_workspace_invite(token) RPC. Returns the workspace_id of
 * the newly-joined workspace on success, or a structured error.
 */
export async function acceptWorkspaceInvite(token: string): Promise<
  | { ok: true; workspaceId: string }
  | {
      ok: false;
      code:
        | 'not_authenticated' | 'invite_not_found' | 'invite_revoked'
        | 'invite_already_accepted' | 'invite_expired' | 'invite_email_mismatch'
        | 'unknown';
      message: string;
    }
> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { data, error } = await supabase.rpc('accept_workspace_invite', { token });
    if (error) {
      const msg = error.message ?? '';
      const code =
        msg.includes('not_authenticated')         ? 'not_authenticated' :
        msg.includes('invite_not_found')          ? 'invite_not_found' :
        msg.includes('invite_revoked')            ? 'invite_revoked' :
        msg.includes('invite_already_accepted')   ? 'invite_already_accepted' :
        msg.includes('invite_expired')            ? 'invite_expired' :
        msg.includes('invite_email_mismatch')     ? 'invite_email_mismatch' :
        'unknown';
      return { ok: false, code, message: msg };
    }
    return { ok: true, workspaceId: data as string };
  } catch (e: any) {
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

/**
 * Call fetch_invite_preview before sign-in. Returns workspace name + invitee
 * email (the address the invite was sent to) so the auth screen can pre-fill.
 */
export async function fetchInvitePreview(tokenHash: string): Promise<
  | { ok: true; workspaceName: string; inviteeEmail: string }
  | { ok: false; message: string }
> {
  if (!isSupabaseConfigured) return { ok: false, message: 'supabase not configured' };
  try {
    const { data, error } = await supabase.rpc('fetch_invite_preview', { token_hash_input: tokenHash });
    if (error) return { ok: false, message: error.message };
    const row = (data as Array<{ workspace_name: string; invitee_email: string }>)?.[0];
    if (!row) return { ok: false, message: 'invite_not_found' };
    return { ok: true, workspaceName: row.workspace_name, inviteeEmail: row.invitee_email };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}

/**
 * Call get_workspace_members(ws_id). Returns the full peer-member list via
 * SECURITY DEFINER RPC (Plan 1's self-row RLS would otherwise hide peers).
 */
export async function fetchWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase.rpc('get_workspace_members', { ws_id: workspaceId });
    if (error) {
      console.error('[sync] fetchWorkspaceMembers failed:', error);
      return null;
    }
    return (data ?? []).map((row: any) => ({
      userId: row.user_id,
      role: row.role,
      joinedAt: row.joined_at,
      invitedAt: row.invited_at,
      email: row.email,
      displayName: row.display_name,
    }));
  } catch (e) {
    console.error('[sync] fetchWorkspaceMembers threw:', e);
    return null;
  }
}

/**
 * The caller leaves a workspace. RLS policy members_delete_self_or_owner
 * admits the caller deleting their own row; the last-owner trigger prevents
 * an owner from doing this (which is correct — owners must transfer first,
 * not yet supported in v1).
 */
export async function leaveWorkspace(workspaceId: string): Promise<{ ok: boolean; message?: string }> {
  if (!isSupabaseConfigured) return { ok: false, message: 'supabase not configured' };
  try {
    const userId = (await supabase.auth.getUser()).data.user?.id;
    if (!userId) return { ok: false, message: 'not_authenticated' };
    const { error } = await supabase
      .from('workspace_members')
      .delete()
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}

/**
 * Trigger the send-workspace-invite Edge Function. Called immediately after
 * a successful createWorkspaceInvite.
 */
export async function sendInviteEmail(args: {
  inviteId: string;
  workspaceId: string;
  workspaceName: string;
  inviteeEmail: string;
  role: 'editor' | 'viewer';
  token: string;
  inviterDisplayName: string;
}): Promise<{ ok: boolean; message?: string }> {
  if (!isSupabaseConfigured) return { ok: false, message: 'supabase not configured' };
  try {
    const { error } = await supabase.functions.invoke('send-workspace-invite', {
      body: {
        invite_id: args.inviteId,
        workspace_id: args.workspaceId,
        workspace_name: args.workspaceName,
        invitee_email: args.inviteeEmail,
        role: args.role,
        token: args.token,
        inviter_display_name: args.inviterDisplayName,
      },
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  }
}
```

- [ ] **Step 2: Fix the `upsertUserRows` time-bomb (Plan 1 carry-over)**

Currently `pushProjects` (lines 92-101) sets `user_id: userId` on every upsert — that's the writer's id, NOT the workspace owner's. The `upsertUserRows` assertion `r.user_id !== userId` will pass because we control the value at the call site. This is already the case in `sync.ts`, but the assertion in `synced-store.ts:21` still hardcodes "row must match caller". Verify by re-reading the assertion and confirming it works for non-owner editors who push projects.

Action: Read `src/lib/synced-store.ts` lines 11-35 and check whether the assertion currently semantically matches "row.user_id = the writer (caller)". If yes, no change required — the time-bomb is already defused by `pushProjects` writing `userId` not the workspace owner's id. If no, modify the assertion message to make the new semantics explicit and add a code comment pointing at this analysis.

The most likely outcome: **no code change needed**, only add a comment in `pushProjects` clarifying the semantic shift.

- [ ] **Step 3: Run `npm run build`**

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sync.ts
git commit -m "$(cat <<'EOF'
feat(workspaces): sync.ts — invite + member + leave RPC wrappers

Plan 2, Task 4. Six new exports cover the Plan 2 surface:
  - createWorkspaceInvite / revokeWorkspaceInvite (workspace_invites CRUD)
  - acceptWorkspaceInvite / fetchInvitePreview (token redemption flow)
  - fetchWorkspaceMembers (peer visibility via SECURITY DEFINER RPC)
  - leaveWorkspace (self-delete from workspace_members)
  - sendInviteEmail (Edge Function trigger)
  - generateInviteToken (32-byte URL-safe + SHA-256 hash helper)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: workspaces-store.ts — members + pendingInvites slices

**Files:**
- Modify: `src/stores/workspaces-store.ts`
- Create: `src/stores/__tests__/workspaces-store-members.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/stores/__tests__/workspaces-store-members.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import type { WorkspaceMember, WorkspaceInvite } from '@/lib/sync';

const member = (over: Partial<WorkspaceMember>): WorkspaceMember => ({
  userId: 'u1', role: 'owner', joinedAt: '2026-05-15T00:00:00Z', invitedAt: null,
  email: 'u1@ex.com', displayName: 'U1', ...over,
});
const invite = (over: Partial<WorkspaceInvite>): WorkspaceInvite => ({
  id: 'i1', workspaceId: 'w1', email: 'newby@ex.com',
  invitedBy: 'u1', role: 'editor', expiresAt: '2026-05-22T00:00:00Z',
  revokedAt: null, acceptedAt: null, acceptedBy: null,
  createdAt: '2026-05-15T00:00:00Z', ...over,
});

describe('workspaces-store members + pendingInvites', () => {
  beforeEach(() => { useWorkspacesStore.getState().reset(); });

  it('setWorkspaceMembers stores by workspace id', () => {
    useWorkspacesStore.getState().setWorkspaceMembers('w1', [member({})]);
    expect(useWorkspacesStore.getState().members['w1']).toHaveLength(1);
    expect(useWorkspacesStore.getState().members['w2']).toBeUndefined();
  });

  it('setPendingInvites stores by workspace id', () => {
    useWorkspacesStore.getState().setPendingInvites('w1', [invite({})]);
    expect(useWorkspacesStore.getState().pendingInvites['w1']).toHaveLength(1);
  });

  it('reset clears members and pendingInvites', () => {
    useWorkspacesStore.getState().setWorkspaceMembers('w1', [member({})]);
    useWorkspacesStore.getState().setPendingInvites('w1', [invite({})]);
    useWorkspacesStore.getState().reset();
    expect(useWorkspacesStore.getState().members).toEqual({});
    expect(useWorkspacesStore.getState().pendingInvites).toEqual({});
  });
});
```

- [ ] **Step 2: Run, confirm fails**

Run: `npm test -- src/stores/__tests__/workspaces-store-members.test.ts`
Expected: 3 cases fail with "setWorkspaceMembers / setPendingInvites is not a function".

- [ ] **Step 3: Extend the store**

Replace `src/stores/workspaces-store.ts` to add the new slices:

```ts
import { create } from 'zustand';
import type { WorkspaceRecord, WorkspaceMember, WorkspaceInvite } from '@/lib/sync';
import { registerResettableStore } from '@/lib/accounts/store-registry';

type Role = 'owner' | 'editor' | 'viewer';

interface WorkspacesState {
  workspaces: WorkspaceRecord[];
  currentWorkspaceId: string | null;
  currentRole: Role | null;
  memberCounts: Record<string, number>;
  /** workspace id → full peer list, populated by fetchWorkspaceMembers. */
  members: Record<string, WorkspaceMember[]>;
  /** workspace id → open invites, populated by realtime + initial fetch. */
  pendingInvites: Record<string, WorkspaceInvite[]>;
  loading: boolean;

  setCurrentWorkspaceId: (id: string | null) => void;
  applyRemoteWorkspaces: (rows: WorkspaceRecord[]) => void;
  setWorkspaceMembers: (workspaceId: string, members: WorkspaceMember[]) => void;
  setPendingInvites: (workspaceId: string, invites: WorkspaceInvite[]) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

const INITIAL = {
  workspaces: [] as WorkspaceRecord[],
  currentWorkspaceId: null as string | null,
  currentRole: null as Role | null,
  memberCounts: {} as Record<string, number>,
  members: {} as Record<string, WorkspaceMember[]>,
  pendingInvites: {} as Record<string, WorkspaceInvite[]>,
  loading: false,
};

function deriveRole(rows: WorkspaceRecord[], currentId: string | null): Role | null {
  if (!currentId) return null;
  return rows.find((w) => w.id === currentId)?.currentRole ?? null;
}

function deriveCounts(rows: WorkspaceRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of rows) out[w.id] = w.memberCount;
  return out;
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  ...INITIAL,
  setCurrentWorkspaceId: (id) => {
    set({ currentWorkspaceId: id, currentRole: deriveRole(get().workspaces, id) });
  },
  applyRemoteWorkspaces: (rows) => {
    set({
      workspaces: rows,
      currentRole: deriveRole(rows, get().currentWorkspaceId),
      memberCounts: deriveCounts(rows),
    });
  },
  setWorkspaceMembers: (workspaceId, members) => {
    set({ members: { ...get().members, [workspaceId]: members } });
  },
  setPendingInvites: (workspaceId, invites) => {
    set({ pendingInvites: { ...get().pendingInvites, [workspaceId]: invites } });
  },
  setLoading: (loading) => set({ loading }),
  reset: () => set(INITIAL),
}));

registerResettableStore(() => useWorkspacesStore.getState().reset());
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: previous 169 + 3 new = 172, all pass.

- [ ] **Step 5: Commit**

```bash
git add src/stores/workspaces-store.ts src/stores/__tests__/workspaces-store-members.test.ts
git commit -m "feat(workspaces): members + pendingInvites slices in workspaces-store

Plan 2, Task 5. Two new keyed-by-workspace-id maps:
  - members: WorkspaceMember[] hydrated by fetchWorkspaceMembers RPC
  - pendingInvites: WorkspaceInvite[] hydrated by initial fetch + realtime

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: invite-acceptor.ts + deep-link wiring

**Files:**
- Create: `src/lib/workspaces/invite-acceptor.ts`
- Create: `src/lib/workspaces/__tests__/invite-acceptor.test.ts`
- Modify: the existing OAuth deep-link handler (locate via Grep on `notterai://`)

- [ ] **Step 1: Locate the existing deep-link handler**

Run: `Grep` for `notterai://` in `src/` and `src-tauri/`. Identify where the OAuth callback URL is parsed (likely `src/lib/accounts/` or `src/lib/auth/`). The new `invite` route must hook into the same listener.

If the handler lives in a `oauth-deep-link.ts`-style file with a `switch (urlPath)` block, add a new case. Otherwise add a sibling listener registered via `@tauri-apps/plugin-deep-link`'s `onOpenUrl`.

- [ ] **Step 2: Create `invite-acceptor.ts`**

```ts
// src/lib/workspaces/invite-acceptor.ts
//
// Handles the notterai://invite/<token> deep link. Pure TS (no Tauri imports)
// so the same module works in a future web shell — the Tauri-side handler
// just parses the URL and calls into here.
import { acceptWorkspaceInvite, fetchInvitePreview } from '@/lib/sync';
import { useAuthStore } from '@/stores/auth-store';
import { getWorkspaceManager } from '@/lib/workspaces/workspace-manager';
import { useWorkspacesStore } from '@/stores/workspaces-store';

export interface PendingInvite {
  token: string;
  tokenHash: string;
  workspaceName: string;
  inviteeEmail: string;
}

let pendingInvite: PendingInvite | null = null;

/**
 * Compute SHA-256 of the raw token. Browser-native; works in Tauri WebView.
 */
async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getPendingInvite(): PendingInvite | null {
  return pendingInvite;
}

export function clearPendingInvite(): void {
  pendingInvite = null;
}

/**
 * Entry point for the Tauri deep-link handler.
 *   notterai://invite/<token>
 */
export async function handleInviteDeepLink(token: string): Promise<
  | { kind: 'signin_required'; preview: PendingInvite }
  | { kind: 'redeemed'; workspaceId: string; workspaceName: string }
  | { kind: 'error'; message: string }
> {
  const tokenHash = await hashToken(token);
  const previewRes = await fetchInvitePreview(tokenHash);
  if (!previewRes.ok) {
    return { kind: 'error', message: previewRes.message };
  }
  const preview: PendingInvite = {
    token, tokenHash,
    workspaceName: previewRes.workspaceName,
    inviteeEmail: previewRes.inviteeEmail,
  };

  const user = useAuthStore.getState().user;
  if (!user) {
    pendingInvite = preview;
    return { kind: 'signin_required', preview };
  }

  if (user.email?.toLowerCase() !== preview.inviteeEmail.toLowerCase()) {
    return {
      kind: 'error',
      message: `Este convite é para ${preview.inviteeEmail}. Saia da conta atual e entre como ${preview.inviteeEmail}.`,
    };
  }

  const acceptRes = await acceptWorkspaceInvite(token);
  if (!acceptRes.ok) {
    return { kind: 'error', message: acceptRes.code };
  }

  // Refresh workspaces + switch to the joined one.
  await getWorkspaceManager().bootstrap();
  await getWorkspaceManager().switchWorkspace(acceptRes.workspaceId);
  useWorkspacesStore.getState().setCurrentWorkspaceId(acceptRes.workspaceId);

  return { kind: 'redeemed', workspaceId: acceptRes.workspaceId, workspaceName: preview.workspaceName };
}

/**
 * After successful sign-in, the auth flow calls this to redeem any pending
 * invite captured by `handleInviteDeepLink` while the user was signed out.
 */
export async function redeemPendingInviteAfterSignIn(): Promise<void> {
  if (!pendingInvite) return;
  const token = pendingInvite.token;
  pendingInvite = null;
  await handleInviteDeepLink(token);
}
```

- [ ] **Step 3: Write the test**

```ts
// src/lib/workspaces/__tests__/invite-acceptor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: { rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));

const fetchInvitePreviewMock = vi.fn();
const acceptWorkspaceInviteMock = vi.fn();
vi.mock('@/lib/sync', () => ({
  fetchInvitePreview: (...a: any[]) => fetchInvitePreviewMock(...a),
  acceptWorkspaceInvite: (...a: any[]) => acceptWorkspaceInviteMock(...a),
}));

const authUser = { getState: () => ({ user: null as any }) };
vi.mock('@/stores/auth-store', () => ({ useAuthStore: authUser }));

const bootstrapMock = vi.fn().mockResolvedValue(undefined);
const switchMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/workspaces/workspace-manager', () => ({
  getWorkspaceManager: () => ({ bootstrap: bootstrapMock, switchWorkspace: switchMock }),
}));

const setCurrentMock = vi.fn();
vi.mock('@/stores/workspaces-store', () => ({
  useWorkspacesStore: { getState: () => ({ setCurrentWorkspaceId: setCurrentMock }) },
}));

describe('handleInviteDeepLink', () => {
  beforeEach(() => {
    fetchInvitePreviewMock.mockReset();
    acceptWorkspaceInviteMock.mockReset();
    bootstrapMock.mockClear();
    switchMock.mockClear();
    setCurrentMock.mockClear();
    authUser.getState = () => ({ user: null });
  });

  it('returns signin_required when no user is signed in', async () => {
    fetchInvitePreviewMock.mockResolvedValue({ ok: true, workspaceName: 'Apollo', inviteeEmail: 'a@x.com' });
    const { handleInviteDeepLink } = await import('@/lib/workspaces/invite-acceptor');
    const r = await handleInviteDeepLink('rawtoken');
    expect(r.kind).toBe('signin_required');
  });

  it('returns error when signed-in email mismatches', async () => {
    fetchInvitePreviewMock.mockResolvedValue({ ok: true, workspaceName: 'Apollo', inviteeEmail: 'a@x.com' });
    authUser.getState = () => ({ user: { email: 'b@x.com' } });
    const { handleInviteDeepLink } = await import('@/lib/workspaces/invite-acceptor');
    const r = await handleInviteDeepLink('rawtoken');
    expect(r.kind).toBe('error');
  });

  it('redeems and switches when email matches', async () => {
    fetchInvitePreviewMock.mockResolvedValue({ ok: true, workspaceName: 'Apollo', inviteeEmail: 'a@x.com' });
    authUser.getState = () => ({ user: { email: 'a@x.com' } });
    acceptWorkspaceInviteMock.mockResolvedValue({ ok: true, workspaceId: 'w1' });
    const { handleInviteDeepLink } = await import('@/lib/workspaces/invite-acceptor');
    const r = await handleInviteDeepLink('rawtoken');
    expect(r.kind).toBe('redeemed');
    expect(switchMock).toHaveBeenCalledWith('w1');
    expect(setCurrentMock).toHaveBeenCalledWith('w1');
  });

  it('returns error when fetch_invite_preview fails', async () => {
    fetchInvitePreviewMock.mockResolvedValue({ ok: false, message: 'invite_not_found' });
    const { handleInviteDeepLink } = await import('@/lib/workspaces/invite-acceptor');
    const r = await handleInviteDeepLink('rawtoken');
    expect(r.kind).toBe('error');
  });
});
```

- [ ] **Step 4: Wire the deep-link handler**

Locate the file identified in Step 1. Add an `invite` route that pulls the token from the URL segment and calls `handleInviteDeepLink(token)`. Surface the result to UI via toast — `redeemed` → success toast with workspace name; `signin_required` → toast "Sign in as <email> to accept"; `error` → toast with message.

Example sketch (adapt to the actual existing handler shape):

```ts
import { handleInviteDeepLink } from '@/lib/workspaces/invite-acceptor';
import { toast } from 'sonner';

// inside the existing onOpenUrl listener:
if (url.startsWith('notterai://invite/')) {
  const token = url.slice('notterai://invite/'.length);
  const result = await handleInviteDeepLink(token);
  if (result.kind === 'redeemed') {
    toast.success(`Você entrou no workspace ${result.workspaceName}`);
  } else if (result.kind === 'signin_required') {
    toast(`Entre como ${result.preview.inviteeEmail} para aceitar o convite`);
    // Auth flow proceeds; after sign-in, call redeemPendingInviteAfterSignIn()
  } else {
    toast.error(`Não foi possível aceitar o convite: ${result.message}`);
  }
  return;
}
```

- [ ] **Step 5: Wire `redeemPendingInviteAfterSignIn` into the auth post-signin flow**

In `src/stores/auth-store.ts`'s `syncOnLogin` (or equivalent), after the user object is set, call `redeemPendingInviteAfterSignIn()` from invite-acceptor. This handles the "user wasn't logged in when they clicked the email → signs up → invite redeems automatically" path.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: 172 + 4 = 176, all pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workspaces/invite-acceptor.ts \
        src/lib/workspaces/__tests__/invite-acceptor.test.ts \
        src/lib/accounts/oauth-deep-link.ts \
        src/stores/auth-store.ts
git commit -m "feat(workspaces): invite-acceptor + deep-link route notterai://invite/<token>

Plan 2, Task 6. Pure-TS acceptor module (web-shell ready). Three exit
states: signin_required (token captured, redeems after auth),
redeemed (worker switched), error (mismatch/expired/revoked/etc).

Wired into the existing OAuth deep-link listener and auth-store
post-signin hook.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: synced-store debounce + realtime invites subscription

**Files:**
- Modify: `src/lib/synced-store.ts`
- Modify: `src/lib/realtime.ts`

- [ ] **Step 1: Debounce the membership rebuild trigger**

Plan 1 carry-over: `rebuildRealtimeOnMembershipChange` in `realtime.ts` runs synchronously per event. If the user accepts N invites in quick succession, the channel tears down and rebuilds N times. Add a 300ms debounce.

In `realtime.ts`, replace the bare `void rebuildRealtimeOnMembershipChange(userId);` invocation with a `setTimeout`-based debounce stored in module scope:

```ts
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedRebuild(userId: string) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void rebuildRealtimeOnMembershipChange(userId);
  }, 300);
}
```

Use `debouncedRebuild(userId)` in the workspace_members postgres_changes listener instead of the direct call.

- [ ] **Step 2: Subscribe to workspace_invites filtered by caller email**

Modify `realtime.ts` `startRealtimeSync` to add a subscription to `workspace_invites` filtered by `email=eq.<userEmail>`. On any event, re-fetch pending invites for the user's email and surface as in-app notification. The filter assumes the user's email is available in `useAuthStore`.

The subscription:

```ts
const userEmail = useAuthStore.getState().user?.email;
if (userEmail) {
  ch = ch.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'workspace_invites', filter: `email=eq.${userEmail.toLowerCase()}` },
    () => {
      // The invitee just got/lost an invite. Surface in UI as a notification.
      // For now: just log; UI surfacing lives in Task 9 (the dialog opens on
      // the next switcher click and shows current state).
      console.debug('[realtime] workspace_invites event for', userEmail);
    },
  );
}
```

In-app notification UI is intentionally minimal — the dialog will show pending invites on next open. A toast/badge can land in a follow-up.

- [ ] **Step 3: Run tests + build**

Run: `npm test` and `npm run build`. Expected: no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/lib/realtime.ts src/lib/synced-store.ts
git commit -m "feat(workspaces): debounce membership rebuild + subscribe to invites by email

Plan 2, Task 7. Two Plan-1 carry-overs resolved:
  - rebuildRealtimeOnMembershipChange now debounces 300ms (bulk-accept
    no longer thrashes the realtime channel)
  - workspace_invites subscription filtered by caller email so the
    invitee sees in-app updates when an invite is issued/revoked

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — UI (Tasks 8–11)

## Task 8: WorkspaceMembersDialog (TDD)

**Files:**
- Create: `src/components/WorkspaceMembersDialog.tsx`
- Create: `src/components/__tests__/WorkspaceMembersDialog.test.tsx`

The dialog has 3 sections + a footer. Owner sees all; editor/viewer sees the members list + leave button only.

- [ ] **Step 1: Write the failing test (component shape)**

```tsx
// src/components/__tests__/WorkspaceMembersDialog.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkspaceMembersDialog } from '@/components/WorkspaceMembersDialog';
import { useWorkspacesStore } from '@/stores/workspaces-store';

vi.mock('@/lib/sync', () => ({
  fetchWorkspaceMembers: vi.fn().mockResolvedValue([
    { userId: 'u1', role: 'owner', joinedAt: '2026-05-15T00:00:00Z', invitedAt: null, email: 'me@x.com', displayName: 'Me' },
    { userId: 'u2', role: 'editor', joinedAt: '2026-05-15T00:00:00Z', invitedAt: null, email: 'them@x.com', displayName: 'Them' },
  ]),
  createWorkspaceInvite: vi.fn(),
  revokeWorkspaceInvite: vi.fn(),
  leaveWorkspace: vi.fn(),
  generateInviteToken: vi.fn(),
  sendInviteEmail: vi.fn(),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'u1', email: 'me@x.com' } }) },
}));

beforeEach(() => {
  useWorkspacesStore.getState().reset();
  useWorkspacesStore.getState().applyRemoteWorkspaces([
    { id: 'w1', userId: 'u1', name: 'Apollo', isDefault: true,
      createdAt: '', updatedAt: '', currentRole: 'owner', memberCount: 2 },
  ]);
  useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
});

describe('WorkspaceMembersDialog', () => {
  it('renders members list when opened', async () => {
    render(<WorkspaceMembersDialog open={true} onOpenChange={() => {}} />);
    expect(await screen.findByText('Me')).toBeInTheDocument();
    expect(await screen.findByText('Them')).toBeInTheDocument();
  });

  it('shows invite form for owner', async () => {
    render(<WorkspaceMembersDialog open={true} onOpenChange={() => {}} />);
    expect(await screen.findByPlaceholderText(/email/i)).toBeInTheDocument();
  });

  it('hides invite form when caller is viewer', async () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([
      { id: 'w1', userId: 'other', name: 'Apollo', isDefault: false,
        createdAt: '', updatedAt: '', currentRole: 'viewer', memberCount: 2 },
    ]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    render(<WorkspaceMembersDialog open={true} onOpenChange={() => {}} />);
    expect(screen.queryByPlaceholderText(/email/i)).not.toBeInTheDocument();
  });

  it('shows leave button for non-owners', async () => {
    useWorkspacesStore.getState().applyRemoteWorkspaces([
      { id: 'w1', userId: 'other', name: 'Apollo', isDefault: false,
        createdAt: '', updatedAt: '', currentRole: 'editor', memberCount: 2 },
    ]);
    useWorkspacesStore.getState().setCurrentWorkspaceId('w1');
    render(<WorkspaceMembersDialog open={true} onOpenChange={() => {}} />);
    expect(await screen.findByRole('button', { name: /leave/i })).toBeInTheDocument();
  });

  it('hides leave button for owner', async () => {
    render(<WorkspaceMembersDialog open={true} onOpenChange={() => {}} />);
    await screen.findByText('Me');
    expect(screen.queryByRole('button', { name: /leave/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Confirm tests fail**

Run: `npm test -- src/components/__tests__/WorkspaceMembersDialog.test.tsx`
Expected: 5 cases fail with "Cannot find module 'WorkspaceMembersDialog'".

- [ ] **Step 3: Implement `WorkspaceMembersDialog.tsx`**

```tsx
// src/components/WorkspaceMembersDialog.tsx
//
// Standalone dialog (opened from WorkspaceSwitcher). Three sections:
//   1. Members list (everyone sees)
//   2. Pending invites (owner only)
//   3. Invite form (owner only)
// Plus a footer with "Leave workspace" for non-owners.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useWorkspacesStore } from '@/stores/workspaces-store';
import { useAuthStore } from '@/stores/auth-store';
import {
  fetchWorkspaceMembers, createWorkspaceInvite, revokeWorkspaceInvite,
  leaveWorkspace, generateInviteToken, sendInviteEmail,
  type WorkspaceMember, type WorkspaceInvite,
} from '@/lib/sync';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WorkspaceMembersDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const currentRole = useWorkspacesStore((s) => s.currentRole);
  const members = useWorkspacesStore((s) => (currentWorkspaceId ? s.members[currentWorkspaceId] ?? [] : []));
  const pendingInvites = useWorkspacesStore((s) => (currentWorkspaceId ? s.pendingInvites[currentWorkspaceId] ?? [] : []));
  const setMembers = useWorkspacesStore((s) => s.setWorkspaceMembers);
  const setInvites = useWorkspacesStore((s) => s.setPendingInvites);
  const user = useAuthStore((s) => s.user);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [submitting, setSubmitting] = useState(false);

  const isOwner = currentRole === 'owner';
  const currentWs = workspaces.find((w) => w.id === currentWorkspaceId);

  useEffect(() => {
    if (!open || !currentWorkspaceId) return;
    void (async () => {
      const m = await fetchWorkspaceMembers(currentWorkspaceId);
      if (m) setMembers(currentWorkspaceId, m);
    })();
  }, [open, currentWorkspaceId, setMembers]);

  if (!open) return null;
  if (!currentWorkspaceId || !currentWs) return null;

  const submitInvite = async () => {
    if (!inviteEmail.trim()) return;
    setSubmitting(true);
    try {
      const { token, tokenHash } = await generateInviteToken();
      const expiresAtIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const res = await createWorkspaceInvite({
        workspaceId: currentWorkspaceId,
        email: inviteEmail,
        role: inviteRole,
        tokenHash,
        expiresAtIso,
      });
      if (!res.ok) {
        toast.error(t(`workspaces.invite_error.${res.code}`, { defaultValue: res.message }));
        return;
      }
      // Fire-and-forget email; toast both branches but don't block the UI.
      const emailRes = await sendInviteEmail({
        inviteId: res.id,
        workspaceId: currentWorkspaceId,
        workspaceName: currentWs.name,
        inviteeEmail: inviteEmail.trim().toLowerCase(),
        role: inviteRole,
        token,
        inviterDisplayName: user?.email ?? 'Notter',
      });
      if (!emailRes.ok) {
        toast.warning(t('workspaces.invite_email_failed', { defaultValue: 'Invite created but email failed; copy the link manually' }));
      } else {
        toast.success(t('workspaces.invite_sent', { defaultValue: 'Convite enviado' }));
      }
      setInviteEmail('');
    } finally {
      setSubmitting(false);
    }
  };

  const onRevoke = async (id: string) => {
    const r = await revokeWorkspaceInvite(id);
    if (!r.ok) toast.error(r.message ?? 'revoke failed');
    else setInvites(currentWorkspaceId, pendingInvites.filter((i) => i.id !== id));
  };

  const onLeave = async () => {
    if (!currentWs) return;
    const r = await leaveWorkspace(currentWs.id);
    if (!r.ok) {
      toast.error(r.message ?? 'leave failed');
      return;
    }
    toast.success(t('workspaces.left', { defaultValue: 'Você saiu do workspace' }));
    onOpenChange(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => onOpenChange(false)}>
      <div className="bg-background rounded-lg shadow-lg max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">
          {t('workspaces.members_title', { defaultValue: 'Membros de {{name}}', replace: { name: currentWs.name } })}
        </h2>

        {/* Members list */}
        <ul className="space-y-2 mb-6">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 text-sm">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs">{m.displayName[0]?.toUpperCase()}</div>
              <div className="flex-1">
                <div>{m.displayName}{m.userId === user?.id ? ` (${t('workspaces.you', { defaultValue: 'você' })})` : ''}</div>
                <div className="text-xs text-muted-foreground">{m.email}</div>
              </div>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">{m.role}</span>
            </li>
          ))}
        </ul>

        {/* Pending invites (owner only) */}
        {isOwner && pendingInvites.length > 0 && (
          <>
            <h3 className="text-sm font-semibold mb-2">{t('workspaces.pending_invites', { defaultValue: 'Convites pendentes' })}</h3>
            <ul className="space-y-2 mb-6">
              {pendingInvites.map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 text-sm">
                  <div className="flex-1">{inv.email} <span className="text-xs text-muted-foreground">({inv.role})</span></div>
                  <button onClick={() => onRevoke(inv.id)} className="text-xs text-destructive hover:underline">
                    {t('workspaces.revoke', { defaultValue: 'Revogar' })}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* Invite form (owner only) */}
        {isOwner && (
          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold mb-2">{t('workspaces.invite_member', { defaultValue: 'Convidar membro' })}</h3>
            <div className="flex gap-2">
              <input
                type="email"
                placeholder={t('workspaces.email_placeholder', { defaultValue: 'email@exemplo.com' })}
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="flex-1 rounded-md border px-2 py-1 text-sm"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as 'editor' | 'viewer')}
                className="rounded-md border px-2 py-1 text-sm"
              >
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
              <button
                onClick={submitInvite}
                disabled={submitting || !inviteEmail.trim()}
                className="rounded-md bg-primary text-primary-foreground px-3 py-1 text-sm disabled:opacity-50"
              >
                {submitting ? '…' : t('workspaces.send_invite', { defaultValue: 'Enviar' })}
              </button>
            </div>
          </div>
        )}

        {/* Leave (non-owners) */}
        {!isOwner && (
          <div className="border-t pt-4">
            <button
              onClick={onLeave}
              className="text-sm text-destructive hover:underline"
            >
              {t('workspaces.leave_button', { defaultValue: 'Leave workspace' })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- src/components/__tests__/WorkspaceMembersDialog.test.tsx`
Expected: 5/5 pass.

- [ ] **Step 5: Full suite check**

Run: `npm test`
Expected: still all green.

- [ ] **Step 6: Commit**

```bash
git add src/components/WorkspaceMembersDialog.tsx src/components/__tests__/WorkspaceMembersDialog.test.tsx
git commit -m "feat(workspaces): WorkspaceMembersDialog with TDD shape

Plan 2, Task 8. Standalone dialog: members list (all), pending invites
(owner), invite form (owner), leave button (non-owner). RBAC visible
in the UI; backend RLS already enforces it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: WorkspaceSwitcher edits

**Files:**
- Modify: `src/components/WorkspaceSwitcher.tsx`

Add: (a) member-count chip when count > 1, (b) "Members & invites" menu entry.

- [ ] **Step 1: Edit the switcher**

In `WorkspaceSwitcher.tsx`, between the workspaces list and the "Add workspace" / "Manage workspaces" buttons, add a "Members & invites" button that opens the new dialog. Also, on each workspace row in the dropdown, append a member-count chip when count > 1.

Specific edits:

1. Add a new piece of state for the members dialog:
```ts
const [membersDialogOpen, setMembersDialogOpen] = useState(false);
```

2. Import the new dialog:
```ts
import { WorkspaceMembersDialog } from '@/components/WorkspaceMembersDialog';
```

3. Read member counts from the store:
```ts
const memberCounts = useWorkspacesStore((s) => s.memberCounts);
```

4. In the per-workspace row, append after the existing `{ws.isDefault && <span ...>{badge}</span>}`:
```tsx
{(memberCounts[ws.id] ?? 1) > 1 && (
  <span className="text-[10px] text-muted-foreground">
    {memberCounts[ws.id]} {t('workspaces.members_short', { defaultValue: 'members' })}
  </span>
)}
```

5. Add a new "Members & invites" button right before the existing "Add workspace" button:
```tsx
<button
  onClick={() => { setOpen(false); setMembersDialogOpen(true); }}
  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted"
>
  <Users size={12} />
  {t('workspaces.members_entry', { defaultValue: 'Membros e convites' })}
</button>
```

(Import `Users` from `lucide-react`.)

6. Render the new dialog at the end (right after `<WorkspaceManagerDialog ... />`):
```tsx
<WorkspaceMembersDialog
  open={membersDialogOpen}
  onOpenChange={setMembersDialogOpen}
/>
```

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/WorkspaceSwitcher.tsx
git commit -m "feat(workspaces): switcher gains members entry + member-count chip

Plan 2, Task 9. Member count shown only when > 1 (zero clutter for
single-user). New 'Members & invites' menu entry opens
WorkspaceMembersDialog.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Role-aware PlannerTab + CommentsPanel

**Files:**
- Modify: `src/components/PlannerTab.tsx`
- Modify: `src/components/plans/CommentsPanel.tsx`

- [ ] **Step 1: PlannerTab — readOnly when viewer**

In `PlannerTab.tsx`, read `currentRole`:
```ts
const currentRole = useWorkspacesStore((s) => s.currentRole);
const isViewer = currentRole === 'viewer';
```

Then:
- Pass `readOnly={isViewer}` to the Monaco editor mount.
- Disable the Save / New version buttons in the toolbar: `disabled={isViewer || …existingCondition}`.
- Add a tooltip on the disabled save: `title={isViewer ? t('plans.viewer_readonly_tooltip') : undefined}`.

Exact line-level edits depend on the current shape of the file. Read it first; apply minimally.

- [ ] **Step 2: CommentsPanel — gate resolve**

In `CommentsPanel.tsx`:
- Compose box stays enabled for viewers (spec §3.2).
- The "Resolve" button on a comment is shown only when:
  - `currentRole !== 'viewer'` (owners + editors resolve any), OR
  - `comment.authorUserId === currentUserId` (viewer resolves own).

Implementation:
```ts
const currentRole = useWorkspacesStore((s) => s.currentRole);
const currentUserId = useAuthStore((s) => s.user?.id);

const canResolve = (c: SubjectComment) =>
  currentRole !== 'viewer' || c.authorUserId === currentUserId;
```

Then in the comment render: `{canResolve(comment) && <ResolveButton .../>}`.

- [ ] **Step 3: Hide project create / delete for viewers**

Find the sidebar's "New project" + "Delete project" affordances (probably in `Sidebar.tsx` or wherever project CRUD lives — Grep for "newProject" or "createProject"). Wrap them in `{currentRole !== 'viewer' && …}`. For "Delete project" specifically: hide for viewer; disabled-with-tooltip for editor (since DELETE is owner-only per Plan 1 RLS). Tooltip: "Only the workspace owner can delete projects".

- [ ] **Step 4: Run build + tests**

Run: `npm test` and `npm run build`. Expected: still green.

- [ ] **Step 5: Commit**

```bash
git add src/components/PlannerTab.tsx src/components/plans/CommentsPanel.tsx \
        src/components/Sidebar.tsx
git commit -m "feat(workspaces): role-aware UI in planner + comments + sidebar

Plan 2, Task 10. Viewer cannot edit subjects, cannot create or delete
projects, but CAN comment and resolve their own comments. Editor cannot
delete projects (owner-only) but can do everything else. Hide vs
disable: hide where the action is unavailable; disable-with-tooltip
where higher role could unlock.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: i18n strings

**Files:**
- Modify: `src/i18n/locales/pt-BR.json`
- Modify: `src/i18n/locales/en.json` (if it exists)

- [ ] **Step 1: Add keys to pt-BR**

Open `src/i18n/locales/pt-BR.json`, find or create the `workspaces` namespace, and add:

```json
{
  "workspaces": {
    "members_title": "Membros de {{name}}",
    "members_entry": "Membros e convites",
    "members_short": "membros",
    "you": "você",
    "pending_invites": "Convites pendentes",
    "invite_member": "Convidar membro",
    "send_invite": "Enviar",
    "email_placeholder": "email@exemplo.com",
    "revoke": "Revogar",
    "leave_button": "Sair do workspace",
    "left": "Você saiu do workspace",
    "invite_sent": "Convite enviado",
    "invite_email_failed": "Convite criado mas email falhou; copie o link manualmente",
    "invite_error": {
      "duplicate_open_invite": "Já existe um convite aberto para este email",
      "forbidden": "Apenas o dono do workspace pode convidar",
      "unknown": "Falha ao enviar convite"
    },
    "viewer_readonly_tooltip": "Você é viewer; não pode editar"
  }
}
```

- [ ] **Step 2: Mirror to en.json (if it exists)**

Same structure, English copy. If en.json doesn't exist, skip.

- [ ] **Step 3: Run build**

Run: `npm run build`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/locales/
git commit -m "feat(i18n): Plan-2 workspace strings (pt-BR + en)"
```

---

## Phase 4 — Ship (Tasks 12–13)

## Task 12: Full test + build checkpoint

- [ ] **Step 1: `npm test`** — expected: all green.
- [ ] **Step 2: `npm run build`** — expected: clean.
- [ ] **Step 3: If any failure** — fix at root cause, do not skip tests.

No commit if both green; proceed to Task 13.

---

## Task 13: E2E smoke + memory update

User-driven smoke. The agent runs SQL verifications via MCP; the user runs the UI checks.

- [ ] **Step 1: Restart Tauri dev**

`npm run tauri dev`. Wait for Vite + cargo to finish.

- [ ] **Step 2: User smoke checklist (provide to user)**

1. Sign in to your account.
2. Open the workspace switcher → click "Members & invites" → dialog opens, lists you as owner.
3. In the invite form, type a SECOND email you own (different from your account email), pick "editor", submit → toast "Convite enviado" + pending invite appears in the list.
4. Check that email's inbox (or Resend logs) → invite email arrives with the `notterai://invite/<token>` link.
5. Click the link → Tauri receives it → toast tells you to sign in as the invitee email.
6. Sign out, sign in as the invitee → invite auto-redeems → workspace switcher now shows BOTH workspaces; current switched to the joined one.
7. As the editor account: verify you can edit subjects + comment + create projects, but cannot delete projects (tooltip "Only the workspace owner can delete").
8. Open Members dialog as editor → see Leave button. Owner doesn't see Leave.
9. As editor, click Leave → confirmed → switched back to your own workspace; the shared one disappears.
10. As owner, open Members dialog → confirm the editor row is gone (member count back to 1, badge hidden in switcher).

- [ ] **Step 3: SQL verifications via MCP**

```sql
-- An invite that's now accepted has accepted_at + accepted_by set
SELECT id, email, role, accepted_at, accepted_by FROM workspace_invites
ORDER BY created_at DESC LIMIT 5;

-- The accepted member exists in workspace_members
SELECT workspace_id, user_id, role, joined_at FROM workspace_members
ORDER BY joined_at DESC LIMIT 5;
```

Expected: invite row has `accepted_at`/`accepted_by` populated; corresponding workspace_members row exists with the editor role.

- [ ] **Step 4: Update memory**

Save `C:\Users\Guilherme\.claude\projects\C--Users-Guilherme-Code-Projetos-Notter-AI\memory\project_multi_user_plan2_shipped.md`:

```markdown
---
name: multi-user-plan2-shipped
description: "Plan 2 (invites + WorkspaceMembersDialog + role-aware UI + Resend Edge Function) — shipped 2026-05-XX. Plan 3 (sharing policy) is next."
metadata:
  type: project
---

Plan 2 shipped 2026-05-XX. Build on Plan 1 (workspace_members RLS substrate).

Live in prod:
- workspace_invites table + 3 RPCs (accept_workspace_invite, fetch_invite_preview, get_workspace_members)
- send-workspace-invite Edge Function (Deno + Resend)
- WorkspaceMembersDialog standalone; member-count chip in switcher
- Role-aware UI: viewer can comment + resolve own; editor cannot delete projects
- Invite acceptor + deep-link route notterai://invite/<token>
- Membership rebuild now debounces 300ms

Not shipped (Plan 3):
- workspace.sharing_policy enum + dropdown

Spec: docs/superpowers/specs/2026-05-13-multi-user-workspaces-design.md §3.1, §4.2, §5, §7
Plan: docs/superpowers/plans/2026-05-14-multi-user-workspaces-plan-2-invites-ui.md
```

Update `MEMORY.md` index with a one-liner pointing here.

- [ ] **Step 5: Final commit + push**

```bash
git add C:/Users/Guilherme/.claude/projects/C--Users-Guilherme-Code-Projetos-Notter-AI/memory/
git commit --allow-empty -m "docs(memory): Plan 2 ship status"
git push origin main
```

---

## Risk register

| Scenario | Detection | Recovery |
|---|---|---|
| Resend secret missing in Supabase | Edge function returns 500 with `resend_not_configured` | Set the secret via dashboard; no code change needed |
| Deep-link doesn't fire on Windows | User clicks link, nothing opens | Verify `notterai://` scheme registered in Tauri (`tauri.conf.json`); fallback: paste link in-app via "Have an invite?" affordance (future polish) |
| Invite email arrives but link expired | RPC returns `invite_expired` | Toast suggests asking owner to re-invite; owner revokes-and-creates fresh |
| Invitee already a member when they redeem | accept RPC's `on conflict do nothing` makes redeem a no-op | UI toast "Você já é membro deste workspace" handled by acceptor module |
| get_workspace_members called by non-member | RPC's EXISTS guard returns empty result | Dialog shows empty list; not a leak |
| Realtime `email=eq.<...>` filter URL-encodes plus signs | Some emails contain `+` (e.g. gmail filters) | Use `lowercase + URL-encode` before constructing the filter; alternative: filter by workspace_id and ignore email-level routing |

---

## Self-review notes

- **Spec coverage:** §3.1 (workspace_invites table) → Task 1. §4.2 (RPCs + RLS) → Task 1. §5 (invite flow + transport + email service) → Tasks 1+3+4+6. §7.1 (switcher edits) → Task 9. §7.2 (members dialog) → Task 8. §7.4 (role-aware UI) → Task 10. §8.3 (rebuild on membership change debounce) → Task 7. §9 cases #1–#16 → covered by RPC behavior + UI handlers + risk register.
- **Placeholder scan:** Step 1 of Task 6 says "locate via Grep" — that's a process step, not a placeholder; the implementer searches a specific pattern and finds the file. Acceptable. No "TODO" / "TBD" / fill-later patterns.
- **Type consistency:** `WorkspaceMember.userId` (not `user_id`), `role: 'owner' | 'editor' | 'viewer'`, `WorkspaceInvite.workspaceId` (camelCase). Consistent across sync.ts, store, dialog.
- **The RPCs are the load-bearing pieces.** Codex should focus there in review.
- **Plan 1 carry-overs addressed:** debounce (Task 7), `upsertUserRows` assertion confirmation (Task 4 Step 2). Peer-member visibility solved via SECURITY DEFINER RPC.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-14-multi-user-workspaces-plan-2-invites-ui.md`. Three execution options:

**1. Codex review first (recommended given Plan 1's experience)** — the migration + RPCs are the load-bearing pieces; Codex caught a real bug in Plan 1's SQL (`current_role` reserved word). Same workflow here.

**2. Subagent-Driven (after Codex)** — 13 tasks dispatched fresh, two-stage review per task.

**3. Inline execution** — Implement in this session with checkpoints. Slower but fewer subagent invocations.

**Which approach?**
