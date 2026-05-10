import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { upsertUserRows } from '@/lib/synced-store';
import type { AgentProfile, Project, BoardTask } from '@/types';
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
  terminalTheme: string;
  terminalFont: string;
  terminalFontSize: number;
  terminalLigatures: boolean;
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
      terminalTheme: data.terminal_theme,
      terminalFont: data.terminal_font,
      terminalFontSize: data.terminal_font_size,
      terminalLigatures: data.terminal_ligatures,
    };
  } catch {
    return null;
  }
}

export async function pushPreferences(userId: string, prefs: UserPreferences): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabase.from('user_preferences').upsert({
      user_id: userId,
      dark_mode: prefs.darkMode,
      language: prefs.language,
      terminal_theme: prefs.terminalTheme,
      terminal_font: prefs.terminalFont,
      terminal_font_size: prefs.terminalFontSize,
      terminal_ligatures: prefs.terminalLigatures,
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

export async function fetchProjects(userId: string): Promise<Project[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', userId);
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => ({ name: row.name, path: row.path }));
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
): Promise<void> {
  if (!isSupabaseConfigured) return;
  try {
    await supabase.from('subjects').upsert({
      user_id: userId,
      project_name: projectName,
      file_name: fileName,
      content,
      updated_at: new Date().toISOString(),
    });
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

// ── Board Tasks ───────────────────────────────────────────────────────

export async function fetchBoardTasks(userId: string): Promise<BoardTask[] | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data, error } = await supabase
      .from('board_tasks')
      .select('*')
      .eq('user_id', userId);
    if (error || !data || data.length === 0) return null;
    return data.map((row: any) => ({
      id: row.id,
      projectName: row.project_name,
      subjectName: row.subject_name,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: row.messages ?? [],
    }));
  } catch {
    return null;
  }
}

export async function pushBoardTasks(userId: string, tasks: BoardTask[]): Promise<void> {
  await upsertUserRows('board_tasks', userId, tasks, (t) => ({
    id: t.id,
    user_id: userId,
    project_name: t.projectName,
    subject_name: t.subjectName,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    created_at: t.createdAt,
    updated_at: new Date().toISOString(),
    messages: t.messages,
  }));
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
