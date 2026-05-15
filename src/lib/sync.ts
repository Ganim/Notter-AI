import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { upsertUserRows } from '@/lib/synced-store';
import type { Project } from '@/types';

export interface SubjectVersionRecord {
  id: string;
  subjectId: string;
  userId: string;
  contentMarkdown: string;
  parentVersionId: string | null;
  source: 'user' | 'ai' | 'import';
  sourceActor: string | null;
  label: string | null;
  createdAt: string;
}

export interface SubjectCommentRecord {
  id: string;
  subjectId: string;
  versionId: string;
  userId: string;
  authorUserId: string;
  authorDisplayName: string | null;
  body: string;
  resolved: boolean;
  archived: boolean;
  /** Selected snippet of subject markdown the comment points at; null = legacy "general" comment. */
  anchorQuote: string | null;
  /** Up to 32 chars before the quote — disambiguator. */
  anchorPrefix: string | null;
  /** Up to 32 chars after the quote — disambiguator. */
  anchorSuffix: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserPreferences {
  darkMode: boolean;
  language: string;
}

export async function fetchPreferences(userId: string): Promise<UserPreferences | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('*')
      .eq('user_id', userId)
      .single();
    if (error || !data) return null;
    return {
      darkMode: data.dark_mode,
      language: data.language,
    };
  } catch {
    return null;
  }
}

export async function pushPreferences(userId: string, prefs: UserPreferences): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    // terminal_* columns still exist in the table (per the "leave Supabase
    // schema intact" decision) but we don't write them anymore; they'll keep
    // their previous values.
    await supabase.from('user_preferences').upsert({
      user_id: userId,
      dark_mode: prefs.darkMode,
      language: prefs.language,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Failed to push preferences:', e);
  }
}

// ── Projects ──────────────────────────────────────────────────────────

export async function fetchProjects(userId: string, workspaceId?: string): Promise<Project[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    let q = supabase.from('projects').select('*').eq('user_id', userId);
    if (workspaceId) q = q.eq('workspace_id', workspaceId);
    const { data, error } = await q;
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => ({ name: row.name, path: row.path, workspaceId: row.workspace_id }));
  } catch {
    return null;
  }
}

export async function pushProjects(userId: string, projects: Project[]): Promise<void> {
  await upsertUserRows('projects', userId, projects, (p) => ({
    id: p.name,
    user_id: userId,
    name: p.name,
    path: p.path,
    workspace_id: p.workspaceId,
    updated_at: new Date().toISOString(),
  }));
}

// ── Subjects (markdown notes) ─────────────────────────────────────────

export interface SubjectRecord {
  id: string;
  projectName: string;
  fileName: string;
  content: string;
  currentVersionId: string | null;
}

export async function fetchSubjects(userId: string): Promise<SubjectRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('subjects')
      .select('*')
      .eq('user_id', userId);
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => ({
      id: row.id,
      projectName: row.project_name,
      fileName: row.file_name,
      content: row.content,
      currentVersionId: row.current_version_id ?? null,
    }));
  } catch {
    return null;
  }
}

/**
 * Atomically commit a new version of a subject. Inserts a `subject_versions`
 * row AND moves `subjects.content` + `subjects.current_version_id` to match,
 * inside a single Postgres function (`commit_subject_version`).
 *
 * Coalescing: when `coalesceWindowSecs > 0` and the most recent version for
 * this subject is within that window AND has the same `source` and
 * `sourceActor`, the RPC updates that row's `content_markdown` in place
 * instead of inserting a new one. Use for autosave (e.g. 60s) so a typing
 * session collapses into one version row. Pass `0` for explicit checkpoints
 * (manual save, AI revision, import, adopt) where a fresh row is always
 * desired.
 *
 * Returns the version id that now holds the content, or `null` on failure.
 */
export async function commitSubjectVersion(args: {
  subjectId: string;
  content: string;
  source: 'user' | 'ai' | 'import';
  sourceActor?: string | null;
  label?: string | null;
  parentVersionId?: string | null;
  coalesceWindowSecs?: number;
}): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase.rpc('commit_subject_version', {
      p_subject_id: args.subjectId,
      p_content: args.content,
      p_source: args.source,
      p_source_actor: args.sourceActor ?? null,
      p_label: args.label ?? null,
      p_parent_version_id: args.parentVersionId ?? null,
      p_coalesce_window_secs: args.coalesceWindowSecs ?? 0,
    });
    if (error) {
      console.error('[sync] commitSubjectVersion failed:', error);
      return null;
    }
    return (data as string | null) ?? null;
  } catch (e) {
    console.error('[sync] commitSubjectVersion threw:', e);
    return null;
  }
}

/**
 * In-place rename of a subject's file_name. Replaces the previous
 * delete-then-insert dance, which cascaded into subject_versions /
 * subject_comments and silently destroyed history. Returns ok:false with
 * code 'duplicate_name' when another file in the same project already uses
 * the target name (Postgres 23505).
 */
export async function renameSubjectInPlace(
  subjectId: string,
  newFileName: string,
): Promise<{ ok: true } | { ok: false; code: 'duplicate_name' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase.rpc('rename_subject', {
      p_subject_id: subjectId,
      p_new_file_name: newFileName,
    });
    if (error) {
      if ((error as any).code === '23505') {
        return { ok: false, code: 'duplicate_name', message: error.message };
      }
      console.error('[sync] renameSubjectInPlace failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] renameSubjectInPlace threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

export async function pushSubject(
  userId: string,
  projectName: string,
  fileName: string,
  content: string,
  id?: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const row: Record<string, unknown> = {
      user_id: userId,
      project_name: projectName,
      file_name: fileName,
      content,
      updated_at: new Date().toISOString(),
    };
    // Pass an explicit id when the caller needs to reference it (e.g. to
    // create an initial subject_versions row in the same flow). Otherwise
    // let the DB generate one via the gen_random_uuid() default.
    if (id) row.id = id;
    await supabase.from('subjects').upsert(row);
  } catch (e) {
    console.error('Failed to push subject:', e);
  }
}

export async function deleteRemoteSubject(
  userId: string,
  projectName: string,
  fileName: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabase
      .from('subjects')
      .delete()
      .eq('user_id', userId)
      .eq('project_name', projectName)
      .eq('file_name', fileName);
  } catch (e) {
    console.error('Failed to delete remote subject:', e);
  }
}

export async function deleteRemoteSubjectsByProject(
  userId: string,
  projectName: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabase
      .from('subjects')
      .delete()
      .eq('user_id', userId)
      .eq('project_name', projectName);
  } catch (e) {
    console.error('Failed to delete remote subjects for project:', e);
  }
}

export async function renameRemoteSubjectsProject(
  userId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabase
      .from('subjects')
      .update({ project_name: newName, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('project_name', oldName);
  } catch (e) {
    console.error('Failed to rename remote subjects project:', e);
  }
}

// ── Workspaces ────────────────────────────────────────────────────────

export interface WorkspaceRecord {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** Caller's role in this workspace. 'owner' for any workspace the caller created (every workspace, in Plan 1). */
  currentRole: 'owner' | 'editor' | 'viewer';
  /** Total members in this workspace. Always 1 in Plan 1. */
  memberCount: number;
}

export async function fetchWorkspaces(userId: string): Promise<WorkspaceRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  // userId is kept in the signature so call sites don't change, but the RPC
  // reads auth.uid() server-side — we don't pass it. A PostgREST embed
  // (`workspaces?select=*,workspace_members(role,count)` + an .eq filter)
  // was considered first but is unsound: .eq('workspace_members.user_id',
  // ...) filters BOTH embeds by table name, leaking the user filter into
  // the unfiltered members_count and yielding 1 per workspace. The RPC
  // encapsulates the join + scalar subquery and is immune to that.
  void userId;
  try {
    const { data, error } = await supabase.rpc('get_my_workspaces');
    if (error) {
      console.error('[sync] fetchWorkspaces failed:', error);
      return null;
    }
    return (data ?? []).map((row: any) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      isDefault: row.is_default,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      currentRole: row.my_role as 'owner' | 'editor' | 'viewer',
      memberCount: Number(row.member_count),
    }));
  } catch (e) {
    console.error('[sync] fetchWorkspaces threw:', e);
    return null;
  }
}

/**
 * Insert a single workspace row. The caller chooses the id (crypto.randomUUID).
 * Direct insert, not upsertUserRows, because `add` is a single-row write and
 * the `(user_id, name)` UNIQUE constraint requires error reporting rather
 * than silent merge.
 */
export async function pushWorkspace(
  workspace: Omit<WorkspaceRecord, 'createdAt' | 'updatedAt' | 'currentRole' | 'memberCount'>,
): Promise<{ ok: true } | { ok: false; code: 'duplicate_name' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase.from('workspaces').insert({
      id: workspace.id,
      user_id: workspace.userId,
      name: workspace.name,
      is_default: workspace.isDefault,
    });
    if (error) {
      // Postgres unique-violation code is 23505.
      if ((error as any).code === '23505') {
        return { ok: false, code: 'duplicate_name', message: error.message };
      }
      console.error('[sync] pushWorkspace failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] pushWorkspace threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

/**
 * Atomically create a workspace + its owner-member row via SECURITY DEFINER
 * RPC. Returns the inserted workspace row.
 *
 * Used instead of `pushWorkspace` for new workspace creation. The RPC handles
 * the is_default partial-unique-index dance internally (clears the previous
 * default in the same transaction).
 */
export async function createWorkspaceWithOwner(
  workspace: Omit<WorkspaceRecord, 'createdAt' | 'updatedAt' | 'currentRole' | 'memberCount'>,
): Promise<{ ok: true } | { ok: false; code: 'duplicate_name' | 'not_authenticated' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase.rpc('create_workspace_with_owner', {
      ws_id: workspace.id,
      ws_name: workspace.name,
      ws_is_default: workspace.isDefault,
    });
    if (error) {
      if ((error as any).code === '23505') {
        return { ok: false, code: 'duplicate_name', message: error.message };
      }
      if ((error as any).code === '42501' || /not_authenticated/.test(error.message)) {
        return { ok: false, code: 'not_authenticated', message: error.message };
      }
      console.error('[sync] createWorkspaceWithOwner failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] createWorkspaceWithOwner threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

export async function renameWorkspace(
  workspaceId: string,
  userId: string,
  newName: string,
): Promise<{ ok: true } | { ok: false; code: 'duplicate_name' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase
      .from('workspaces')
      .update({ name: newName, updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (error) {
      if ((error as any).code === '23505') {
        return { ok: false, code: 'duplicate_name', message: error.message };
      }
      console.error('[sync] renameWorkspace failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] renameWorkspace threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

/**
 * Set `workspaceId` as the default for `userId`. Issues two updates so the
 * partial-unique-default index is never violated:
 *   1. Clear `is_default` on the current default (where `is_default = true`).
 *   2. Set `is_default = true` on the target.
 * Sequential is fine — Supabase serializes our writes per request.
 */
export async function setWorkspaceDefault(
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    // Step 1: clear the existing default.
    await supabase
      .from('workspaces')
      .update({ is_default: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('is_default', true);
    // Step 2: set the new one.
    const { error } = await supabase
      .from('workspaces')
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (error) console.error('[sync] setWorkspaceDefault step 2 failed:', error);
  } catch (e) {
    console.error('[sync] setWorkspaceDefault threw:', e);
  }
}

/**
 * Delete a workspace. Caller is responsible for resolving children FIRST
 * (move or purge). The `ON DELETE RESTRICT` on projects.workspace_id will
 * cause this to fail with 23503 if any project still references the workspace
 * — that's the safety net the spec relies on (§4.2).
 *
 * Returns ok:false on the 23503 path so the UI can show a specific toast.
 */
export async function deleteWorkspace(
  workspaceId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; code: 'has_projects' | 'unknown'; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, code: 'unknown', message: 'supabase not configured' };
  try {
    const { error } = await supabase
      .from('workspaces')
      .delete()
      .eq('id', workspaceId)
      .eq('user_id', userId);
    if (error) {
      if ((error as any).code === '23503') {
        return { ok: false, code: 'has_projects', message: error.message };
      }
      console.error('[sync] deleteWorkspace failed:', error);
      return { ok: false, code: 'unknown', message: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    console.error('[sync] deleteWorkspace threw:', e);
    return { ok: false, code: 'unknown', message: e?.message ?? String(e) };
  }
}

/**
 * Re-target a single project to a different workspace. Used by the "Move to
 * workspace" UI affordance. Subjects/versions/comments travel with the
 * project automatically — they're scoped via the FK chain, not via a
 * denormalized workspace_id of their own.
 */
export async function updateProjectWorkspace(
  userId: string,
  projectName: string,
  targetWorkspaceId: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase
      .from('projects')
      .update({ workspace_id: targetWorkspaceId, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('name', projectName);
    if (error) console.error('[sync] updateProjectWorkspace failed:', error);
  } catch (e) {
    console.error('[sync] updateProjectWorkspace threw:', e);
  }
}

/**
 * Move every project from `fromWorkspaceId` to `toWorkspaceId` for the
 * given user. Used by the "move-then-delete" flow in WorkspaceDeleteDialog.
 * Returns the number of rows affected so the UI can verify before issuing
 * the workspace delete.
 */
export async function moveProjectsBetweenWorkspaces(
  userId: string,
  fromWorkspaceId: string,
  toWorkspaceId: string,
): Promise<{ ok: true; movedCount: number } | { ok: false; message: string }> {
  if (!isSupabaseConfigured) return { ok: false, message: 'supabase not configured' };
  try {
    const { data, error, count } = await supabase
      .from('projects')
      .update({ workspace_id: toWorkspaceId, updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('user_id', userId)
      .eq('workspace_id', fromWorkspaceId)
      .select('name');
    if (error) {
      console.error('[sync] moveProjectsBetweenWorkspaces failed:', error);
      return { ok: false, message: error.message };
    }
    return { ok: true, movedCount: count ?? data?.length ?? 0 };
  } catch (e: any) {
    console.error('[sync] moveProjectsBetweenWorkspaces threw:', e);
    return { ok: false, message: e?.message ?? String(e) };
  }
}

// ── Subject Versions ──────────────────────────────────────────────────

export async function fetchSubjectVersions(
  subjectId: string,
): Promise<SubjectVersionRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('subject_versions')
      .select('*')
      .eq('subject_id', subjectId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[sync] fetchSubjectVersions failed:', error);
      return null;
    }
    return (data ?? []).map((row: any) => ({
      id: row.id,
      subjectId: row.subject_id,
      userId: row.user_id,
      contentMarkdown: row.content_markdown,
      parentVersionId: row.parent_version_id ?? null,
      source: row.source as 'user' | 'ai' | 'import',
      sourceActor: row.source_actor ?? null,
      label: row.label ?? null,
      createdAt: row.created_at,
    }));
  } catch (e) {
    console.error('[sync] fetchSubjectVersions threw:', e);
    return null;
  }
}

// pushSubjectVersion and updateSubjectCurrentVersion were removed in the
// 2026-05-14 versioning overhaul. Every write now goes through the atomic
// `commit_subject_version` RPC — see `commitSubjectVersion` above. Direct
// inserts on subject_versions are no longer safe because they would leave
// `subjects.content` and `subjects.current_version_id` out of sync.

// ── Subject Comments ──────────────────────────────────────────────────

export async function fetchSubjectComments(
  subjectId: string,
): Promise<SubjectCommentRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('subject_comments')
      .select('*')
      .eq('subject_id', subjectId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[sync] fetchSubjectComments failed:', error);
      return null;
    }
    return (data ?? []).map((row: any) => ({
      id: row.id,
      subjectId: row.subject_id,
      versionId: row.version_id,
      userId: row.user_id,
      authorUserId: row.author_user_id,
      authorDisplayName: row.author_display_name ?? null,
      body: row.body,
      resolved: row.resolved,
      archived: row.archived ?? false,
      anchorQuote: row.anchor_quote ?? null,
      anchorPrefix: row.anchor_prefix ?? null,
      anchorSuffix: row.anchor_suffix ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  } catch (e) {
    console.error('[sync] fetchSubjectComments threw:', e);
    return null;
  }
}

/**
 * Upsert a single subject_comment row (covers create + resolve-toggle + edit).
 * The trigger set_user_id_on_subject_comments fills user_id server-side on
 * INSERT from the parent subjects row. On UPDATE (resolve toggle / edit) the
 * existing user_id stays put because we don't pass it.
 */
export async function pushSubjectComment(
  comment: Omit<SubjectCommentRecord, 'userId' | 'createdAt'> & { userId?: string },
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase.from('subject_comments').upsert({
      id: comment.id,
      subject_id: comment.subjectId,
      version_id: comment.versionId,
      author_user_id: comment.authorUserId,
      author_display_name: comment.authorDisplayName,
      body: comment.body,
      resolved: comment.resolved,
      archived: comment.archived,
      anchor_quote: comment.anchorQuote,
      anchor_prefix: comment.anchorPrefix,
      anchor_suffix: comment.anchorSuffix,
      updated_at: comment.updatedAt ?? new Date().toISOString(),
    });
    if (error) console.error('[sync] pushSubjectComment failed:', error);
  } catch (e) {
    console.error('[sync] pushSubjectComment threw:', e);
  }
}

export async function deleteSubjectComment(commentId: string, userId: string): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase
      .from('subject_comments')
      .delete()
      .eq('id', commentId)
      .eq('user_id', userId);
    if (error) console.error('[sync] deleteSubjectComment failed:', error);
  } catch (e) {
    console.error('[sync] deleteSubjectComment threw:', e);
  }
}

// ── Workspace invites + members ───────────────────────────────────────

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
 * The Postgres side uses `encode(digest(token, 'sha256'), 'hex')` which
 * produces the same hex string for the same UTF-8 token.
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
    const userId = (await supabase.auth.getUser()).data.user?.id;
    const { data, error } = await supabase
      .from('workspace_invites')
      .insert({
        workspace_id: args.workspaceId,
        email: args.email.trim().toLowerCase(),
        role: args.role,
        token_hash: args.tokenHash,
        expires_at: args.expiresAtIso,
        invited_by: userId,
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
      const code: 'not_authenticated' | 'invite_not_found' | 'invite_revoked'
        | 'invite_already_accepted' | 'invite_expired' | 'invite_email_mismatch'
        | 'unknown' =
        msg.includes('not_authenticated')       ? 'not_authenticated' :
        msg.includes('invite_not_found')        ? 'invite_not_found' :
        msg.includes('invite_revoked')          ? 'invite_revoked' :
        msg.includes('invite_already_accepted') ? 'invite_already_accepted' :
        msg.includes('invite_expired')          ? 'invite_expired' :
        msg.includes('invite_email_mismatch')   ? 'invite_email_mismatch' :
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
 * Fetch the pending (open) invites for a workspace. Owner-callable via the
 * existing RLS (`invites_select_members_or_invitee` covers it via membership).
 */
export async function fetchPendingInvites(workspaceId: string): Promise<WorkspaceInvite[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('workspace_invites')
      .select('*')
      .eq('workspace_id', workspaceId)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[sync] fetchPendingInvites failed:', error);
      return null;
    }
    return (data ?? []).map((row: any) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      email: row.email,
      invitedBy: row.invited_by,
      role: row.role,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      acceptedAt: row.accepted_at,
      acceptedBy: row.accepted_by,
      createdAt: row.created_at,
    }));
  } catch (e) {
    console.error('[sync] fetchPendingInvites threw:', e);
    return null;
  }
}

/**
 * The caller leaves a workspace. RLS policy admits the caller deleting their
 * own row; the last-owner trigger prevents an owner from doing this (owners
 * must transfer first, not yet supported in v1).
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
 * a successful createWorkspaceInvite. The Edge Function re-validates every
 * payload field against the DB before sending the email (Codex Finding #2).
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
