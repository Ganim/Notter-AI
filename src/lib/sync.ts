import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { upsertUserRows } from '@/lib/synced-store';
import type { AgentProfile, Project } from '@/types';
import type { Action } from '@/types/actions';

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
  body: string;
  resolved: boolean;
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

export async function fetchAgentProfiles(userId: string): Promise<AgentProfile[]> {
  if (!isSupabaseConfigured) return [];
  try {
    const { data, error } = await supabase
      .from('agent_profiles')
      .select('*')
      .eq('user_id', userId);
    if (error || !data || data.length === 0) return [];
    return data.map((row: any) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      model: row.model || '',
      apiKey: row.api_key || '',
      systemPrompt: row.system_prompt || '',
      autonomous: row.autonomous || false,
    }));
  } catch {
    return [];
  }
}

export async function pushAgentProfiles(userId: string, profiles: AgentProfile[]): Promise<void> {
  await upsertUserRows('agent_profiles', userId, profiles, (p) => ({
    id: p.id,
    user_id: userId,
    name: p.name,
    provider: p.provider,
    model: p.model,
    api_key: p.apiKey,
    system_prompt: p.systemPrompt,
    autonomous: p.autonomous,
    updated_at: new Date().toISOString(),
  }));
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
 * Update the `current_version_id` pointer on a subject row. Used by the
 * "Adopt version" flow in the subject-versions store. Idempotent: writing the
 * same value is a no-op.
 */
export async function updateSubjectCurrentVersion(
  userId: string,
  subjectId: string,
  versionId: string,
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    const { error } = await supabase
      .from('subjects')
      .update({
        current_version_id: versionId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', subjectId)
      .eq('user_id', userId);
    if (error) console.error('[sync] updateSubjectCurrentVersion failed:', error);
  } catch (e) {
    console.error('[sync] updateSubjectCurrentVersion threw:', e);
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

// ── Actions ───────────────────────────────────────────────────────────

export async function fetchActions(userId: string): Promise<Action[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('actions')
      .select('*')
      .eq('user_id', userId);
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => row.data as Action);
  } catch {
    return null;
  }
}

export async function pushActions(userId: string, actions: Action[]): Promise<void> {
  await upsertUserRows('actions', userId, actions, (a) => ({
    id: a.id,
    user_id: userId,
    data: a,
    updated_at: new Date().toISOString(),
  }));
}

// ── Workspaces ────────────────────────────────────────────────────────

export interface WorkspaceRecord {
  id: string;
  userId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function fetchWorkspaces(userId: string): Promise<WorkspaceRecord[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('workspaces')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
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
  workspace: Omit<WorkspaceRecord, 'createdAt' | 'updatedAt'>,
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

/**
 * Insert a single subject_version row. Uses a direct Supabase insert (not
 * upsertUserRows) because subject_versions are append-only — never updated.
 * The trigger set_user_id_on_subject_versions fills user_id server-side from
 * the parent subjects row, so the caller does NOT pass user_id.
 */
export async function pushSubjectVersion(
  version: Omit<SubjectVersionRecord, 'userId' | 'createdAt'>,
): Promise<{ id: string } | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('subject_versions')
      .insert({
        id: version.id,
        subject_id: version.subjectId,
        content_markdown: version.contentMarkdown,
        parent_version_id: version.parentVersionId ?? null,
        source: version.source,
        source_actor: version.sourceActor ?? null,
        label: version.label ?? null,
      })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[sync] pushSubjectVersion failed:', error);
      return null;
    }
    return { id: data.id };
  } catch (e) {
    console.error('[sync] pushSubjectVersion threw:', e);
    return null;
  }
}

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
      body: row.body,
      resolved: row.resolved,
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
      body: comment.body,
      resolved: comment.resolved,
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
