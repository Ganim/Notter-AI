import { create } from 'zustand';
import { BaseDirectory, readDir, mkdir, readTextFile, writeTextFile, exists, remove, rename } from '@tauri-apps/plugin-fs';
import type { EditorTheme, Project } from '@/types';
import {
  pushProjects, pushSubject, deleteRemoteSubject,
  deleteRemoteSubjectsByProject, renameRemoteSubjectsProject,
  commitSubjectVersion, renameSubjectInPlace,
  type SubjectRecord,
} from '@/lib/sync';
import { deleteUserRow, makeDebouncedSync } from '@/lib/synced-store';
import { useAuthStore } from './auth-store';
import { useSubjectVersionsStore } from './subject-versions-store';
import { useWorkspacesStore } from './workspaces-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { accountScopedPath, tryAccountScopedPath } from '@/lib/accounts/account-paths';
import { safeFsName, unsafeFsName } from '@/lib/accounts/safe-fs-name';

// Filesystem path helpers. Names may contain characters that Windows (and to
// a lesser extent macOS/Linux) reject in paths — `: < > " | ? * \ /`. Any
// name produced by the MCP server or another device may legally carry these.
// We percent-encode at the disk boundary and decode when reading back so the
// logical name in the UI/store stays intact.
function projectFsPath(projectName: string): string {
  return accountScopedPath(`NotterProjects/${safeFsName(projectName)}`);
}
function subjectFsPath(projectName: string, fileName: string): string {
  return accountScopedPath(`NotterProjects/${safeFsName(projectName)}/${safeFsName(fileName)}`);
}

/**
 * Autosave coalescing window. The commit_subject_version RPC folds
 * consecutive same-source writes within this window into one row instead of
 * inserting a new version per keystroke debounce. 60s collapses a typing
 * session into a single version; a >60s pause starts a new one.
 */
const AUTOSAVE_COALESCE_SECS = 60;

const BG_COLORS: EditorTheme[] = [
  { name: 'Zinc',  value: 'bg-zinc-50 dark:bg-zinc-900',     light: { hex: '#fafafa', base: 'vs' },      dark: { hex: '#18181b', base: 'vs-dark' } },
  { name: 'Taupe', value: 'bg-stone-50 dark:bg-stone-900/10', light: { hex: '#fafaf9', base: 'vs' },      dark: { hex: '#131211', base: 'vs-dark' } },
  { name: 'Mist',  value: 'bg-sky-50 dark:bg-sky-950/10',    light: { hex: '#f0f9ff', base: 'vs' },      dark: { hex: '#0a1219', base: 'vs-dark' } },
  { name: 'Mauve', value: 'bg-purple-50 dark:bg-purple-950/10', light: { hex: '#faf5ff', base: 'vs' },   dark: { hex: '#0e0a15', base: 'vs-dark' } },
  { name: 'Olive', value: 'bg-lime-50 dark:bg-lime-950/10',  light: { hex: '#f7fee7', base: 'vs' },      dark: { hex: '#0d1209', base: 'vs-dark' } },
  { name: 'Dark',  value: 'bg-background',                    light: { hex: '#09090b', base: 'vs-dark' }, dark: { hex: '#09090b', base: 'vs-dark' } },
];

function getProjectsFile(): string {
  return accountScopedPath('NotterProjects/projects.json');
}

const projectsSync = makeDebouncedSync<Project[]>(pushProjects, 1000);

/**
 * Debounced autosave for the active subject. Replaces the previous
 * pushSubject debouncer that wrote raw content directly. Every payload now
 * goes through `commit_subject_version` so each save creates (or coalesces
 * into) a version row AND updates `subjects.content` + `current_version_id`
 * atomically — keeping the invariant
 *   subjects.content == current_version.content_markdown
 * intact at every step. `parentVersionId` is snapshotted at schedule time;
 * the RPC ignores it on a coalesce hit and uses it only on a fresh-row
 * miss.
 */
type SubjectCommitPayload = {
  subjectId: string;
  content: string;
  parentVersionId: string | null;
};
const subjectCommitSync = makeDebouncedSync<SubjectCommitPayload>(
  async (_uid, p) => {
    const versionId = await commitSubjectVersion({
      subjectId: p.subjectId,
      content: p.content,
      source: 'user',
      sourceActor: null,
      label: null,
      parentVersionId: p.parentVersionId,
      coalesceWindowSecs: AUTOSAVE_COALESCE_SECS,
    });
    if (!versionId) return;
    // Optimistic reflect: move the "atual" marker on subjectRows so the
    // History dropdown updates without waiting for the realtime UPDATE.
    usePlannerStore.getState().markSubjectCurrentVersion(p.subjectId, versionId);
    // If the user is still looking at this subject's history, refresh the
    // versions slice so the new (or coalesced) row appears in the panel.
    const vs = useSubjectVersionsStore.getState();
    if (vs.currentSubjectId === p.subjectId) {
      const { fetchSubjectVersions } = await import('@/lib/sync');
      const fresh = await fetchSubjectVersions(p.subjectId);
      if (fresh && useSubjectVersionsStore.getState().currentSubjectId === p.subjectId) {
        useSubjectVersionsStore.getState().applyRemoteVersions(fresh);
      }
    }
  },
  1000,
);

/**
 * Recompute the workspace-filtered view of projects from the canonical
 * `allProjects` slice. Reads `currentWorkspaceId` from `useWorkspacesStore`.
 * When no workspace is active (pre-bootstrap), falls back to the full list so
 * the UI doesn't briefly flicker to empty during sign-in.
 */
function recomputeProjects(allProjects: Project[]): Project[] {
  const currentWsId = useWorkspacesStore.getState().currentWorkspaceId;
  return currentWsId
    ? allProjects.filter((p) => p.workspaceId === currentWsId)
    : allProjects;
}

interface PlannerState {
  // Projects (formerly "subjects/assuntos")
  /**
   * Canonical full list of projects across all workspaces for the active
   * account. Mutations write here first; `projects` is a derived view filtered
   * by `useWorkspacesStore.currentWorkspaceId`.
   */
  allProjects: Project[];
  /**
   * Derived view of `allProjects` filtered by `currentWorkspaceId`. Kept as a
   * state field (not a getter) so Zustand subscribers — including all
   * `usePlannerStore((s) => s.projects)` selectors across the codebase —
   * re-render on workspace switch. Updated by:
   *   1. Every mutation that touches `allProjects` (via `recomputeProjects`).
   *   2. The `useWorkspacesStore` subscription registered at the bottom of
   *      this file, which fires on `currentWorkspaceId` changes.
   */
  projects: Project[];
  selectedProject: Project | null;

  // Subjects/notes (formerly "tasks/tarefas")
  subjects: string[];
  selectedSubject: string | null;
  /**
   * Full subject rows from Supabase (id, currentVersionId, etc) — keyed by
   * (projectName, fileName). Populated by `applyRemoteSubjects` and on
   * sign-in. Local-only subjects (offline mode) won't appear here until they
   * sync, which is fine: the version-history UI hides itself when no row is
   * found via `selectedSubjectRow()`.
   */
  subjectRows: SubjectRecord[];

  // Editor
  subjectContent: string;
  isViewing: boolean;
  editorBgClass: string;
  editorTheme: string;
  bgColors: EditorTheme[];
  _activeTheme: EditorTheme | null;

  // Project actions
  setSelectedProject: (project: Project | null) => void;
  initFilesystem: () => Promise<void>;
  createProject: (name: string, path: string) => Promise<void>;
  renameProject: (oldName: string, newName: string) => Promise<void>;
  updateProjectPath: (name: string, newPath: string) => Promise<void>;
  deleteProject: (name: string) => Promise<void>;
  /**
   * Re-target a project to a different workspace. Used by Phase L's "Move to
   * workspace" menu. Updates `allProjects` locally, re-derives `projects`, and
   * pushes the new `workspace_id` to Supabase. Subjects/versions/comments
   * travel with the project through the FK chain — no client-side cascade.
   */
  moveProjectToWorkspace: (projectName: string, targetWorkspaceId: string) => Promise<void>;
  /**
   * Optimistically reflect a `subjects.current_version_id` change in the
   * local subjectRows slice. Realtime UPDATE events for the subjects table
   * are RLS-protected and frequently lag (same root cause as the workspaces
   * bug fixes f248994 / 697ac90), so callers (preview-banner Adopt, force-
   * create button) patch the slice directly after a successful Supabase
   * update so the "current" marker in the History dropdown moves.
   */
  markSubjectCurrentVersion: (subjectId: string, versionId: string) => void;

  // Subject actions
  setSelectedSubject: (subject: string | null) => void;
  /**
   * Returns the SubjectRecord for the active (selectedProject, selectedSubject)
   * pair, or null if no row exists yet (offline-only subject, or pre-sync).
   * Read by SnapshotPanel / CommentsPanel / PlannerTab to find the live
   * `current_version_id` and the stable `subjects.id` for FK writes.
   */
  selectedSubjectRow: () => SubjectRecord | null;
  loadSubjects: (projectName: string) => Promise<void>;
  loadSubjectContent: (projectName: string, subject: string) => Promise<void>;
  setSubjectContent: (content: string) => void;
  saveSubjectContent: (projectName: string, subject: string, content: string) => Promise<void>;
  /** Disk-only write; use when remote already has the content (adopt flow). */
  writeSubjectFileOnly: (projectName: string, subject: string, content: string) => Promise<void>;
  /**
   * Create a subject + its initial version. When `initialVersionMeta` is
   * supplied (e.g. by the import flow), those fields override the defaults
   * (`source='user'`, `sourceActor='initial'`, `label='Versão inicial'`) so
   * the very first version carries accurate provenance.
   */
  createSubject: (
    projectName: string,
    name: string,
    initialContent?: string,
    initialVersionMeta?: {
      source: 'user' | 'ai' | 'import';
      sourceActor?: string | null;
      label?: string | null;
    },
  ) => Promise<void>;
  renameSubject: (projectName: string, oldName: string, newName: string) => Promise<void>;
  deleteSubject: (projectName: string, subject: string) => Promise<void>;

  // Editor actions
  setIsViewing: (viewing: boolean) => void;
  setEditorTheme: (theme: EditorTheme) => void;
  refreshEditorTheme: () => void;

  // Sync actions
  applyRemoteProjects: (projects: Project[]) => void;
  applyRemoteSubjects: (subjects: SubjectRecord[]) => Promise<void>;
  pushAllSubjects: (userId: string) => Promise<void>;
  flush(): Promise<void>;
  reset(): void;
}

export const usePlannerStore = create<PlannerState>((set, get) => ({
  allProjects: [],
  projects: [],
  selectedProject: null,
  subjects: [],
  selectedSubject: null,
  subjectRows: [],
  subjectContent: '# Nova Anotação',
  isViewing: false,
  editorBgClass: BG_COLORS[0].value,
  editorTheme: `theme-${BG_COLORS[0].name}-light`,
  bgColors: BG_COLORS,
  _activeTheme: BG_COLORS[0],

  // --- Projects ---

  setSelectedProject: (project) => {
    set({ selectedProject: project, selectedSubject: null, subjects: [] });
    // Clearing the subject also tears down the per-subject versions/comments
    // store so its slices don't leak into the next subject's view.
    useSubjectVersionsStore.getState().clearSubject();
    if (project) get().loadSubjects(project.name);
  },

  initFilesystem: async () => {
    if (tryAccountScopedPath('NotterProjects') === null) return;
    try {
      const notterProjectsPath = accountScopedPath('NotterProjects');
      const hasDir = await exists(notterProjectsPath, { baseDir: BaseDirectory.AppLocalData });
      if (!hasDir) await mkdir(notterProjectsPath, { baseDir: BaseDirectory.AppLocalData, recursive: true });

      const projectsFile = getProjectsFile();
      if (await exists(projectsFile, { baseDir: BaseDirectory.AppLocalData })) {
        const contents = await readTextFile(projectsFile, { baseDir: BaseDirectory.AppLocalData });
        const parsed: Project[] = JSON.parse(contents);
        set({ allProjects: parsed, projects: recomputeProjects(parsed) });
      } else {
        await writeTextFile(projectsFile, '[]', { baseDir: BaseDirectory.AppLocalData });
      }
    } catch (e) {
      console.error('Failed to init planner filesystem:', e);
    }
  },

  createProject: async (name, path) => {
    // Phase E: stamp the project with the active workspace id. Pre-bootstrap
    // (no workspace yet) we bail rather than persist a project with an empty
    // workspaceId — the UI gates the "+ New project" button on a workspace
    // existing, so this branch should never fire in normal flows.
    const wsId = useWorkspacesStore.getState().currentWorkspaceId;
    if (!wsId) {
      console.error('[planner] createProject: no active workspace; aborting');
      return;
    }
    await mkdir(projectFsPath(name), { baseDir: BaseDirectory.AppLocalData, recursive: true });
    const newProject: Project = { name, path, workspaceId: wsId, tag: '', nextSubjectSeq: 1, archivedAt: null };
    const newAll = [...get().allProjects, newProject];
    set({ allProjects: newAll, projects: recomputeProjects(newAll) });
    await writeTextFile(getProjectsFile(), JSON.stringify(newAll, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newAll);
  },

  renameProject: async (oldName, newName) => {
    await rename(projectFsPath(oldName), projectFsPath(newName), { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
    const newAll = get().allProjects.map((p) => (p.name === oldName ? { ...p, name: newName } : p));
    set({
      allProjects: newAll,
      projects: recomputeProjects(newAll),
      selectedProject: get().selectedProject?.name === oldName ? { ...get().selectedProject!, name: newName } : get().selectedProject,
    });
    await writeTextFile(getProjectsFile(), JSON.stringify(newAll, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newAll);
    const userId = useAuthStore.getState().user?.id;
    if (userId) deleteUserRow('projects', userId, oldName).catch((e) => console.error(e));
    if (userId) renameRemoteSubjectsProject(userId, oldName, newName);
  },

  updateProjectPath: async (name, newPath) => {
    const newAll = get().allProjects.map((p) => (p.name === name ? { ...p, path: newPath } : p));
    set({
      allProjects: newAll,
      projects: recomputeProjects(newAll),
      selectedProject: get().selectedProject?.name === name ? { ...get().selectedProject!, path: newPath } : get().selectedProject,
    });
    await writeTextFile(getProjectsFile(), JSON.stringify(newAll, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newAll);
  },

  deleteProject: async (name) => {
    await remove(projectFsPath(name), { baseDir: BaseDirectory.AppLocalData, recursive: true });
    const newAll = get().allProjects.filter((p) => p.name !== name);
    set({
      allProjects: newAll,
      projects: recomputeProjects(newAll),
      selectedProject: get().selectedProject?.name === name ? null : get().selectedProject,
      selectedSubject: get().selectedProject?.name === name ? null : get().selectedSubject,
    });
    await writeTextFile(getProjectsFile(), JSON.stringify(newAll, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newAll);
    const userId = useAuthStore.getState().user?.id;
    if (userId) deleteUserRow('projects', userId, name).catch((e) => console.error(e));
    if (userId) deleteRemoteSubjectsByProject(userId, name);
  },

  moveProjectToWorkspace: async (projectName, targetWorkspaceId) => {
    const newAll = get().allProjects.map((p) =>
      p.name === projectName ? { ...p, workspaceId: targetWorkspaceId } : p
    );
    const newProjects = recomputeProjects(newAll);
    // If the moved project was the active selection and no longer belongs to
    // the current workspace, clear it so the planner UI doesn't render a
    // phantom. The Phase E workspace-switch subscription does the same thing
    // for workspace changes; this handles project-level moves.
    const wasSelected = get().selectedProject?.name === projectName;
    const stillVisible = newProjects.some((p) => p.name === projectName);
    set({
      allProjects: newAll,
      projects: newProjects,
      selectedProject: wasSelected && !stillVisible ? null : get().selectedProject,
      selectedSubject: wasSelected && !stillVisible ? null : get().selectedSubject,
      subjects: wasSelected && !stillVisible ? [] : get().subjects,
    });
    await writeTextFile(getProjectsFile(), JSON.stringify(newAll, null, 2), { baseDir: BaseDirectory.AppLocalData });
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;
    const { updateProjectWorkspace } = await import('@/lib/sync');
    await updateProjectWorkspace(userId, projectName, targetWorkspaceId);
  },

  markSubjectCurrentVersion: (subjectId, versionId) => {
    set((s) => ({
      subjectRows: s.subjectRows.map((r) =>
        r.id === subjectId ? { ...r, currentVersionId: versionId } : r,
      ),
    }));
  },

  // --- Subjects (notes) ---

  setSelectedSubject: (subject) => {
    set({ selectedSubject: subject });
    const project = get().selectedProject;
    if (project && subject) {
      get().loadSubjectContent(project.name, subject);
      // Pivot the subject-versions store onto the new subject. If we don't
      // know the row's stable id yet (offline-only / pre-sync), clear so the
      // panels stay empty rather than showing the previous subject's data.
      const row = get().subjectRows.find(
        (r) => r.projectName === project.name && r.fileName === subject,
      );
      if (row) {
        useSubjectVersionsStore.getState().loadForSubject(row.id);
      } else {
        useSubjectVersionsStore.getState().clearSubject();
      }
    } else {
      useSubjectVersionsStore.getState().clearSubject();
    }
  },

  selectedSubjectRow: () => {
    const { selectedProject, selectedSubject, subjectRows } = get();
    if (!selectedProject || !selectedSubject) return null;
    return (
      subjectRows.find(
        (r) =>
          r.projectName === selectedProject.name &&
          r.fileName === selectedSubject,
      ) ?? null
    );
  },

  loadSubjects: async (projectName) => {
    try {
      const entries = await readDir(projectFsPath(projectName), { baseDir: BaseDirectory.AppLocalData });
      // The on-disk filename is percent-encoded; decode back to the logical
      // name so the UI displays "Texto aleatório 13:39:12.md" not the
      // "...%3A39%3A12.md" form that lives on Windows.
      const files = entries.filter((e) => e.isFile && e.name.endsWith('.md')).map((e) => unsafeFsName(e.name));
      set({ subjects: files });
    } catch (e) {
      console.error('Failed to load subjects:', e);
    }
  },

  loadSubjectContent: async (projectName, subject) => {
    try {
      const content = await readTextFile(subjectFsPath(projectName, subject), { baseDir: BaseDirectory.AppLocalData });
      set({ subjectContent: content });
    } catch (e) {
      set({ subjectContent: '# Erro ao carregar' });
    }
  },

  setSubjectContent: (content) => set({ subjectContent: content }),

  saveSubjectContent: async (projectName, subject, content) => {
    try {
      await writeTextFile(subjectFsPath(projectName, subject), content, { baseDir: BaseDirectory.AppLocalData });
      // Resolve the remote row so we can commit a version. Offline / pre-sync
      // subjects have no row yet — disk save is enough; the next sync will
      // catch up via createSubject's path or a manual force-sync.
      const row = get().subjectRows.find(
        (r) => r.projectName === projectName && r.fileName === subject,
      );
      if (!row) return;
      subjectCommitSync.schedule({
        subjectId: row.id,
        content,
        parentVersionId: row.currentVersionId ?? null,
      });
    } catch (e) {
      console.error('Failed to save subject content:', e);
    }
  },

  /**
   * Disk-only write for callers that have ALREADY persisted content remotely
   * via a different path (e.g. the Adopt button calls commit_subject_version
   * directly; it just needs the local file to mirror that). Skips the
   * autosave debouncer, so no second redundant version row is created.
   */
  writeSubjectFileOnly: async (projectName: string, subject: string, content: string) => {
    try {
      await writeTextFile(
        subjectFsPath(projectName, subject),
        content,
        { baseDir: BaseDirectory.AppLocalData },
      );
    } catch (e) {
      console.error('Failed to write subject file:', e);
    }
  },

  createSubject: async (projectName, name, initialContent, initialVersionMeta) => {
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const content = initialContent ?? '# Nova Anotação\n\nDescreva o assunto...';
    await writeTextFile(
      subjectFsPath(projectName, fileName),
      content,
      { baseDir: BaseDirectory.AppLocalData }
    );
    set((state) => ({ subjects: [...state.subjects, fileName], selectedSubject: fileName }));
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;

    // Pin down the subject id client-side so the version commit can reference
    // it in the same flow without a refetch round-trip. Every subject must
    // have at least one version row from creation onward — no orphans.
    const subjectId = crypto.randomUUID();
    try {
      // 1. Insert the subjects row (without current_version_id; the RPC
      //    sets it in step 2). The RPC's ownership check needs the row to
      //    exist, so we cannot collapse these two writes.
      await pushSubject(userId, projectName, fileName, content, subjectId);

      // 2. Commit the initial version atomically: inserts subject_versions
      //    AND moves subjects.content + current_version_id. No coalesce
      //    window — first version is always an explicit checkpoint.
      const initialSource = initialVersionMeta?.source ?? 'user';
      const initialSourceActor =
        initialVersionMeta?.sourceActor !== undefined
          ? initialVersionMeta.sourceActor
          : 'initial';
      const initialLabel =
        initialVersionMeta?.label !== undefined
          ? initialVersionMeta.label
          : 'Versão inicial';
      const newVersionId = await commitSubjectVersion({
        subjectId,
        content,
        source: initialSource,
        sourceActor: initialSourceActor,
        label: initialLabel,
        parentVersionId: null,
        coalesceWindowSecs: 0,
      });
      if (!newVersionId) {
        console.error('[planner] createSubject: initial version commit failed');
        return;
      }

      // Optimistic subjectRows update so SnapshotPanel renders the new
      // subject immediately, without waiting for the realtime UPDATE to
      // round-trip back.
      set((s) => ({
        subjectRows: [
          ...s.subjectRows,
          {
            id: subjectId,
            projectName,
            fileName,
            content,
            currentVersionId: newVersionId,
            seq: 1,
            archivedAt: null,
          },
        ],
      }));
      await useSubjectVersionsStore.getState().loadForSubject(subjectId);
    } catch (e) {
      console.error('[planner] createSubject (initial version) failed:', e);
    }
  },

  renameSubject: async (projectName, oldName, newName) => {
    const newFileName = newName.endsWith('.md') ? newName : `${newName}.md`;
    // Locate the remote row BEFORE renaming so we can call the in-place RPC.
    // The previous implementation did DELETE+INSERT, which cascaded into
    // subject_versions/subject_comments and destroyed the entire history of
    // the renamed file. Now we UPDATE in place and the FK chain is preserved.
    const row = get().subjectRows.find(
      (r) => r.projectName === projectName && r.fileName === oldName,
    );

    await rename(
      subjectFsPath(projectName, oldName),
      subjectFsPath(projectName, newFileName),
      { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData },
    );
    set((state) => ({
      subjects: state.subjects.map((s) => (s === oldName ? newFileName : s)),
      selectedSubject: state.selectedSubject === oldName ? newFileName : state.selectedSubject,
      subjectRows: state.subjectRows.map((r) =>
        r.projectName === projectName && r.fileName === oldName
          ? { ...r, fileName: newFileName }
          : r,
      ),
    }));

    if (!row) return;  // Local-only subject; nothing to sync.
    const result = await renameSubjectInPlace(row.id, newFileName);
    if (!result.ok) {
      console.error(`[planner] renameSubject(${oldName} -> ${newFileName}) failed:`, result.message);
      // Roll back local state on failure so UI matches remote truth.
      set((state) => ({
        subjects: state.subjects.map((s) => (s === newFileName ? oldName : s)),
        selectedSubject: state.selectedSubject === newFileName ? oldName : state.selectedSubject,
        subjectRows: state.subjectRows.map((r) =>
          r.projectName === projectName && r.fileName === newFileName
            ? { ...r, fileName: oldName }
            : r,
        ),
      }));
      try {
        await rename(
          subjectFsPath(projectName, newFileName),
          subjectFsPath(projectName, oldName),
          { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData },
        );
      } catch (e) {
        console.error('[planner] renameSubject rollback failed:', e);
      }
      throw new Error(result.code === 'duplicate_name' ? 'duplicate_name' : result.message);
    }
  },

  deleteSubject: async (projectName, subject) => {
    await remove(subjectFsPath(projectName, subject), { baseDir: BaseDirectory.AppLocalData });
    set((state) => ({
      subjects: state.subjects.filter((s) => s !== subject),
      selectedSubject: state.selectedSubject === subject ? null : state.selectedSubject,
      subjectContent: state.selectedSubject === subject ? '' : state.subjectContent,
    }));
    const userId = useAuthStore.getState().user?.id;
    if (userId) deleteRemoteSubject(userId, projectName, subject);
  },

  // --- Editor ---

  setIsViewing: (viewing) => set({ isViewing: viewing }),

  setEditorTheme: (theme) => {
    const isDark = document.documentElement.classList.contains('dark');
    set({
      editorBgClass: theme.value,
      editorTheme: `theme-${theme.name}-${isDark ? 'dark' : 'light'}`,
      _activeTheme: theme,
    });
  },

  refreshEditorTheme: () => {
    const theme = get()._activeTheme;
    if (!theme) return;
    const isDark = document.documentElement.classList.contains('dark');
    set({
      editorTheme: `theme-${theme.name}-${isDark ? 'dark' : 'light'}`,
    });
  },

  // --- Sync ---

  applyRemoteProjects: (projects) => {
    if (tryAccountScopedPath('NotterProjects') === null) return;
    // Phase E: realtime hands us the canonical full list (all workspaces).
    // Write it to `allProjects` and derive the filtered `projects` view.
    set({ allProjects: projects, projects: recomputeProjects(projects) });
    writeTextFile(getProjectsFile(), JSON.stringify(projects, null, 2), { baseDir: BaseDirectory.AppLocalData }).catch(() => {});
    // Ensure local directories exist for each remote project (across all
    // workspaces — directories are workspace-agnostic on disk).
    for (const p of projects) {
      mkdir(projectFsPath(p.name), { baseDir: BaseDirectory.AppLocalData, recursive: true }).catch(() => {});
    }
  },

  applyRemoteSubjects: async (subjects) => {
    // ──────────────────────────────────────────────────────────────────────
    // Disk-write policy (2026-05-15 MCP-driven updates):
    //   The 2026-05-14 overhaul (when the writer was strictly the local
    //   editor) gated disk writes behind "file doesn't exist yet" so the
    //   realtime echo back from supabase wouldn't clobber the user's
    //   freshly-typed local content during the 1s autosave debounce
    //   window. That broke when MCP started driving writes too: a stub
    //   row (INSERT with content='') created an empty file; a later
    //   UPDATE with the real content was then SKIPPED because the file
    //   already existed.
    //
    //   Current policy:
    //     - Always update the in-memory slice (cheap, race-free).
    //     - Ensure project directories exist (idempotent mkdir).
    //     - Skip the active subject's file: the editor + autosave own it.
    //     - For non-active subjects, write to disk when EITHER (a) the
    //       file doesn't exist yet (first hydration) OR (b) the remote
    //       content actually changed vs. our last seen state. Steady-
    //       state echoes (where prior.content === s.content) are still
    //       skipped, so this doesn't undo the 2026-05-14 fix.
    // ──────────────────────────────────────────────────────────────────────
    const selected = get().selectedProject;
    const selectedSubject = get().selectedSubject;
    const priorById = new Map(get().subjectRows.map((r) => [r.id, r]));

    for (const s of subjects) {
      try {
        await mkdir(
          projectFsPath(s.projectName),
          { baseDir: BaseDirectory.AppLocalData, recursive: true },
        );
        const isActiveFile =
          selected?.name === s.projectName && selectedSubject === s.fileName;
        if (isActiveFile) continue;
        const filePath = subjectFsPath(s.projectName, s.fileName);
        const fileExists = await exists(filePath, { baseDir: BaseDirectory.AppLocalData });
        const prior = priorById.get(s.id);
        if (!fileExists) {
          await writeTextFile(filePath, s.content, { baseDir: BaseDirectory.AppLocalData });
          continue;
        }
        // File exists. Three reasons we'd want to overwrite anyway:
        //   1. Remote content changed since our prior in-memory snapshot
        //      (MCP write, another device, etc.).
        //   2. Cold start (prior === undefined) and disk is empty but
        //      remote has content — repairs the "INSERT-with-empty,
        //      UPDATE-skipped" stale stub from the previous policy.
        const remoteChanged = prior !== undefined && prior.content !== s.content;
        if (remoteChanged) {
          await writeTextFile(filePath, s.content, { baseDir: BaseDirectory.AppLocalData });
          continue;
        }
        if (prior === undefined && s.content.length > 0) {
          try {
            const onDisk = await readTextFile(filePath, { baseDir: BaseDirectory.AppLocalData });
            if (onDisk.length === 0) {
              await writeTextFile(filePath, s.content, { baseDir: BaseDirectory.AppLocalData });
            }
          } catch { /* unreadable; leave it for the user/editor to handle */ }
        }
      } catch (e) {
        console.error(`Failed to hydrate remote subject ${s.projectName}/${s.fileName}:`, e);
      }
    }

    set({ subjectRows: subjects });
    if (selected) get().loadSubjects(selected.name);

    // Sync race: if the row for the currently-open subject arrived AFTER the
    // user picked it, point the versions store at the now-known id.
    if (selected && selectedSubject) {
      const row = subjects.find(
        (r) => r.projectName === selected.name && r.fileName === selectedSubject,
      );
      if (row && useSubjectVersionsStore.getState().currentSubjectId !== row.id) {
        useSubjectVersionsStore.getState().loadForSubject(row.id);
      }
    }
  },

  pushAllSubjects: async (_userId) => {
    // Force-sync: for each known subject row, read the local file and commit
    // its content as a new version. Coalesces into the existing autosave
    // version when within window, so this is a no-op for subjects the user
    // already saved recently. Local-only subjects (no row) are skipped —
    // they would have been created via createSubject which already issues
    // the initial commit; if that flow failed, the user can re-create.
    const rows = get().subjectRows;
    for (const row of rows) {
      try {
        const content = await readTextFile(
          subjectFsPath(row.projectName, row.fileName),
          { baseDir: BaseDirectory.AppLocalData },
        );
        await commitSubjectVersion({
          subjectId: row.id,
          content,
          source: 'user',
          sourceActor: null,
          label: null,
          parentVersionId: row.currentVersionId ?? null,
          coalesceWindowSecs: AUTOSAVE_COALESCE_SECS,
        });
      } catch { /* skip unreadable subjects */ }
    }
  },

  flush: async () => {
    await projectsSync.flush();
    await subjectCommitSync.flush();
  },

  reset() {
    set({
      allProjects: [],
      projects: [],
      selectedProject: null,
      subjects: [],
      selectedSubject: null,
      subjectRows: [],
      subjectContent: '# Nova Anotação',
      isViewing: false,
    });
  },
}));

registerResettableStore(() => usePlannerStore.getState().reset());

// ── Workspace-switch reaction ───────────────────────────────────────────────
// Whenever the active workspace id changes, recompute the filtered `projects`
// view from the canonical `allProjects` slice. If the currently-selected
// project no longer belongs to the active workspace, clear it (plus its
// subjects/selected subject) so the planner UI doesn't render a phantom.
//
// Registered at module scope — fires once for the lifetime of the app. We
// only react when the id actually changes (Zustand sends every state update,
// not just diffs on this field).
let _prevWorkspaceId: string | null = useWorkspacesStore.getState().currentWorkspaceId;
useWorkspacesStore.subscribe((state) => {
  if (state.currentWorkspaceId === _prevWorkspaceId) return;
  _prevWorkspaceId = state.currentWorkspaceId;

  const planner = usePlannerStore.getState();
  const filtered = state.currentWorkspaceId
    ? planner.allProjects.filter((p) => p.workspaceId === state.currentWorkspaceId)
    : planner.allProjects;

  const selected = planner.selectedProject;
  const stillSelected = selected && filtered.some((p) => p.name === selected.name)
    ? selected
    : null;

  usePlannerStore.setState({
    projects: filtered,
    selectedProject: stillSelected,
    selectedSubject: stillSelected ? planner.selectedSubject : null,
    subjects: stillSelected ? planner.subjects : [],
  });
});
