import { create } from 'zustand';
import { BaseDirectory, readDir, mkdir, readTextFile, writeTextFile, exists, remove, rename } from '@tauri-apps/plugin-fs';
import type { EditorTheme, Project } from '@/types';
import { useBoardStore } from './board-store';
import {
  pushProjects, pushSubject, deleteRemoteSubject,
  deleteRemoteSubjectsByProject, renameRemoteSubjectsProject,
  type SubjectRecord,
} from '@/lib/sync';
import { deleteUserRow, makeDebouncedSync } from '@/lib/synced-store';
import { useAuthStore } from './auth-store';
import { useSubjectVersionsStore } from './subject-versions-store';
import { useWorkspacesStore } from './workspaces-store';
import { registerResettableStore } from '@/lib/accounts/store-registry';
import { accountScopedPath, tryAccountScopedPath } from '@/lib/accounts/account-paths';

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
type SubjectPayload = { projectName: string; fileName: string; content: string };
const subjectSync = makeDebouncedSync<SubjectPayload>(
  (uid, p) => pushSubject(uid, p.projectName, p.fileName, p.content),
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
  createSubject: (projectName: string, name: string) => Promise<void>;
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
    await mkdir(accountScopedPath(`NotterProjects/${name}`), { baseDir: BaseDirectory.AppLocalData, recursive: true });
    const newProject: Project = { name, path, workspaceId: wsId };
    const newAll = [...get().allProjects, newProject];
    set({ allProjects: newAll, projects: recomputeProjects(newAll) });
    await writeTextFile(getProjectsFile(), JSON.stringify(newAll, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newAll);
  },

  renameProject: async (oldName, newName) => {
    await rename(accountScopedPath(`NotterProjects/${oldName}`), accountScopedPath(`NotterProjects/${newName}`), { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
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
    useBoardStore.getState().onProjectRenamed(oldName, newName);
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
    await remove(accountScopedPath(`NotterProjects/${name}`), { baseDir: BaseDirectory.AppLocalData, recursive: true });
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
    useBoardStore.getState().onProjectDeleted(name);
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
      const entries = await readDir(accountScopedPath(`NotterProjects/${projectName}`), { baseDir: BaseDirectory.AppLocalData });
      const files = entries.filter((e) => e.isFile && e.name.endsWith('.md')).map((e) => e.name);
      set({ subjects: files });
    } catch (e) {
      console.error('Failed to load subjects:', e);
    }
  },

  loadSubjectContent: async (projectName, subject) => {
    try {
      const content = await readTextFile(accountScopedPath(`NotterProjects/${projectName}/${subject}`), { baseDir: BaseDirectory.AppLocalData });
      set({ subjectContent: content });
    } catch (e) {
      set({ subjectContent: '# Erro ao carregar' });
    }
  },

  setSubjectContent: (content) => set({ subjectContent: content }),

  saveSubjectContent: async (projectName, subject, content) => {
    try {
      await writeTextFile(accountScopedPath(`NotterProjects/${projectName}/${subject}`), content, { baseDir: BaseDirectory.AppLocalData });
      subjectSync.schedule({ projectName, fileName: subject, content });
    } catch (e) {
      console.error('Failed to save subject content:', e);
    }
  },

  createSubject: async (projectName, name) => {
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const content = '# Nova Anotação\n\nDescreva o assunto...';
    await writeTextFile(
      accountScopedPath(`NotterProjects/${projectName}/${fileName}`),
      content,
      { baseDir: BaseDirectory.AppLocalData }
    );
    set((state) => ({ subjects: [...state.subjects, fileName], selectedSubject: fileName }));
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;

    // Generate ids client-side so the subject + its initial version can be
    // written in one flow without an intermediate fetch to recover server-
    // generated ids. Every subject MUST have at least one version row from
    // the moment of creation — no orphan subjects.
    const subjectId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    try {
      await pushSubject(userId, projectName, fileName, content, subjectId);
      const { pushSubjectVersion, updateSubjectCurrentVersion } = await import('@/lib/sync');
      await pushSubjectVersion({
        id: versionId,
        subjectId,
        contentMarkdown: content,
        parentVersionId: null,
        source: 'user',
        sourceActor: null,
        label: 'Versão inicial',
      });
      await updateSubjectCurrentVersion(userId, subjectId, versionId);

      // Optimistically reflect both rows so the SnapshotPanel shows the
      // initial version without waiting for realtime — same RLS-lag mitigation
      // we apply elsewhere (commits f248994, 697ac90).
      const nowIso = new Date().toISOString();
      set((s) => ({
        subjectRows: [
          ...s.subjectRows,
          {
            id: subjectId,
            userId,
            projectName,
            fileName,
            content,
            currentVersionId: versionId,
            updatedAt: nowIso,
          },
        ],
      }));
      useSubjectVersionsStore.getState().loadForSubject(subjectId);
    } catch (e) {
      console.error('[planner] createSubject (initial version) failed:', e);
    }
  },

  renameSubject: async (projectName, oldName, newName) => {
    const newFileName = newName.endsWith('.md') ? newName : `${newName}.md`;
    await rename(accountScopedPath(`NotterProjects/${projectName}/${oldName}`), accountScopedPath(`NotterProjects/${projectName}/${newFileName}`), { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
    set((state) => ({
      subjects: state.subjects.map((s) => (s === oldName ? newFileName : s)),
      selectedSubject: state.selectedSubject === oldName ? newFileName : state.selectedSubject,
    }));
    const userId = useAuthStore.getState().user?.id;
    if (userId) {
      deleteRemoteSubject(userId, projectName, oldName);
      try {
        const content = await readTextFile(accountScopedPath(`NotterProjects/${projectName}/${newFileName}`), { baseDir: BaseDirectory.AppLocalData });
        pushSubject(userId, projectName, newFileName, content);
      } catch { /* content will sync on next save */ }
    }
  },

  deleteSubject: async (projectName, subject) => {
    await remove(accountScopedPath(`NotterProjects/${projectName}/${subject}`), { baseDir: BaseDirectory.AppLocalData });
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
      mkdir(accountScopedPath(`NotterProjects/${p.name}`), { baseDir: BaseDirectory.AppLocalData, recursive: true }).catch(() => {});
    }
  },

  applyRemoteSubjects: async (subjects) => {
    for (const s of subjects) {
      try {
        await mkdir(accountScopedPath(`NotterProjects/${s.projectName}`), { baseDir: BaseDirectory.AppLocalData, recursive: true });
        await writeTextFile(accountScopedPath(`NotterProjects/${s.projectName}/${s.fileName}`), s.content, { baseDir: BaseDirectory.AppLocalData });
      } catch (e) {
        console.error(`Failed to write remote subject ${s.projectName}/${s.fileName}:`, e);
      }
    }
    // Cache the full rows so selectedSubjectRow() can resolve subject.id +
    // current_version_id without another network round trip. Realtime on the
    // `subjects` table fires applyRemoteSubjects again on current_version_id
    // updates, which keeps this slice live.
    set({ subjectRows: subjects });
    // Reload subjects for the currently selected project
    const selected = get().selectedProject;
    if (selected) get().loadSubjects(selected.name);

    // If a subject is currently selected, make sure the subject-versions
    // store is pointed at the right id. This handles the case where the row
    // arrives AFTER the user picked the subject (sync race).
    const selectedSubject = get().selectedSubject;
    if (selected && selectedSubject) {
      const row = subjects.find(
        (r) => r.projectName === selected.name && r.fileName === selectedSubject,
      );
      if (row && useSubjectVersionsStore.getState().currentSubjectId !== row.id) {
        useSubjectVersionsStore.getState().loadForSubject(row.id);
      }
    }
  },

  pushAllSubjects: async (userId) => {
    // Iterate the canonical list so a "Force sync" pushes notes from every
    // workspace's projects, not just the currently-active workspace.
    const projects = get().allProjects;
    for (const project of projects) {
      try {
        const entries = await readDir(accountScopedPath(`NotterProjects/${project.name}`), { baseDir: BaseDirectory.AppLocalData });
        const mdFiles = entries.filter((e) => e.isFile && e.name.endsWith('.md'));
        for (const file of mdFiles) {
          const content = await readTextFile(accountScopedPath(`NotterProjects/${project.name}/${file.name}`), { baseDir: BaseDirectory.AppLocalData });
          await pushSubject(userId, project.name, file.name, content);
        }
      } catch { /* skip unreadable projects */ }
    }
  },

  flush: async () => {
    await projectsSync.flush();
    await subjectSync.flush();
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
