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

const BG_COLORS: EditorTheme[] = [
  { name: 'Zinc',  value: 'bg-zinc-50 dark:bg-zinc-900',     light: { hex: '#fafafa', base: 'vs' },      dark: { hex: '#18181b', base: 'vs-dark' } },
  { name: 'Taupe', value: 'bg-stone-50 dark:bg-stone-900/10', light: { hex: '#fafaf9', base: 'vs' },      dark: { hex: '#131211', base: 'vs-dark' } },
  { name: 'Mist',  value: 'bg-sky-50 dark:bg-sky-950/10',    light: { hex: '#f0f9ff', base: 'vs' },      dark: { hex: '#0a1219', base: 'vs-dark' } },
  { name: 'Mauve', value: 'bg-purple-50 dark:bg-purple-950/10', light: { hex: '#faf5ff', base: 'vs' },   dark: { hex: '#0e0a15', base: 'vs-dark' } },
  { name: 'Olive', value: 'bg-lime-50 dark:bg-lime-950/10',  light: { hex: '#f7fee7', base: 'vs' },      dark: { hex: '#0d1209', base: 'vs-dark' } },
  { name: 'Dark',  value: 'bg-background',                    light: { hex: '#09090b', base: 'vs-dark' }, dark: { hex: '#09090b', base: 'vs-dark' } },
];

const PROJECTS_FILE = 'NotterProjects/projects.json';

const projectsSync = makeDebouncedSync<Project[]>(pushProjects, 1000);
type SubjectPayload = { projectName: string; fileName: string; content: string };
const subjectSync = makeDebouncedSync<SubjectPayload>(
  (uid, p) => pushSubject(uid, p.projectName, p.fileName, p.content),
  1000,
);

interface PlannerState {
  // Projects (formerly "subjects/assuntos")
  projects: Project[];
  selectedProject: Project | null;

  // Subjects/notes (formerly "tasks/tarefas")
  subjects: string[];
  selectedSubject: string | null;

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

  // Subject actions
  setSelectedSubject: (subject: string | null) => void;
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
}

export const usePlannerStore = create<PlannerState>((set, get) => ({
  projects: [],
  selectedProject: null,
  subjects: [],
  selectedSubject: null,
  subjectContent: '# Nova Anotação',
  isViewing: false,
  editorBgClass: BG_COLORS[0].value,
  editorTheme: `theme-${BG_COLORS[0].name}-light`,
  bgColors: BG_COLORS,
  _activeTheme: BG_COLORS[0],

  // --- Projects ---

  setSelectedProject: (project) => {
    set({ selectedProject: project, selectedSubject: null, subjects: [] });
    if (project) get().loadSubjects(project.name);
  },

  initFilesystem: async () => {
    try {
      const hasDir = await exists('NotterProjects', { baseDir: BaseDirectory.AppLocalData });
      if (!hasDir) await mkdir('NotterProjects', { baseDir: BaseDirectory.AppLocalData, recursive: true });

      if (await exists(PROJECTS_FILE, { baseDir: BaseDirectory.AppLocalData })) {
        const contents = await readTextFile(PROJECTS_FILE, { baseDir: BaseDirectory.AppLocalData });
        const parsed: Project[] = JSON.parse(contents);
        set({ projects: parsed });
      } else {
        await writeTextFile(PROJECTS_FILE, '[]', { baseDir: BaseDirectory.AppLocalData });
      }
    } catch (e) {
      console.error('Failed to init planner filesystem:', e);
    }
  },

  createProject: async (name, path) => {
    await mkdir(`NotterProjects/${name}`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    const newProject: Project = { name, path };
    const newProjects = [...get().projects, newProject];
    set({ projects: newProjects });
    await writeTextFile(PROJECTS_FILE, JSON.stringify(newProjects, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newProjects);
  },

  renameProject: async (oldName, newName) => {
    await rename(`NotterProjects/${oldName}`, `NotterProjects/${newName}`, { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
    const newProjects = get().projects.map((p) => (p.name === oldName ? { ...p, name: newName } : p));
    set({
      projects: newProjects,
      selectedProject: get().selectedProject?.name === oldName ? { ...get().selectedProject!, name: newName } : get().selectedProject,
    });
    await writeTextFile(PROJECTS_FILE, JSON.stringify(newProjects, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newProjects);
    const userId = useAuthStore.getState().user?.id;
    if (userId) deleteUserRow('projects', userId, oldName).catch((e) => console.error(e));
    if (userId) renameRemoteSubjectsProject(userId, oldName, newName);
    useBoardStore.getState().onProjectRenamed(oldName, newName);
  },

  updateProjectPath: async (name, newPath) => {
    const newProjects = get().projects.map((p) => (p.name === name ? { ...p, path: newPath } : p));
    set({
      projects: newProjects,
      selectedProject: get().selectedProject?.name === name ? { ...get().selectedProject!, path: newPath } : get().selectedProject,
    });
    await writeTextFile(PROJECTS_FILE, JSON.stringify(newProjects, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newProjects);
  },

  deleteProject: async (name) => {
    await remove(`NotterProjects/${name}`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    const newProjects = get().projects.filter((p) => p.name !== name);
    set({
      projects: newProjects,
      selectedProject: get().selectedProject?.name === name ? null : get().selectedProject,
      selectedSubject: get().selectedProject?.name === name ? null : get().selectedSubject,
    });
    await writeTextFile(PROJECTS_FILE, JSON.stringify(newProjects, null, 2), { baseDir: BaseDirectory.AppLocalData });
    projectsSync.schedule(newProjects);
    const userId = useAuthStore.getState().user?.id;
    if (userId) deleteUserRow('projects', userId, name).catch((e) => console.error(e));
    if (userId) deleteRemoteSubjectsByProject(userId, name);
    useBoardStore.getState().onProjectDeleted(name);
  },

  // --- Subjects (notes) ---

  setSelectedSubject: (subject) => {
    set({ selectedSubject: subject });
    const project = get().selectedProject;
    if (project && subject) get().loadSubjectContent(project.name, subject);
  },

  loadSubjects: async (projectName) => {
    try {
      const entries = await readDir(`NotterProjects/${projectName}`, { baseDir: BaseDirectory.AppLocalData });
      const files = entries.filter((e) => e.isFile && e.name.endsWith('.md')).map((e) => e.name);
      set({ subjects: files });
    } catch (e) {
      console.error('Failed to load subjects:', e);
    }
  },

  loadSubjectContent: async (projectName, subject) => {
    try {
      const content = await readTextFile(`NotterProjects/${projectName}/${subject}`, { baseDir: BaseDirectory.AppLocalData });
      set({ subjectContent: content });
    } catch (e) {
      set({ subjectContent: '# Erro ao carregar' });
    }
  },

  setSubjectContent: (content) => set({ subjectContent: content }),

  saveSubjectContent: async (projectName, subject, content) => {
    try {
      await writeTextFile(`NotterProjects/${projectName}/${subject}`, content, { baseDir: BaseDirectory.AppLocalData });
      subjectSync.schedule({ projectName, fileName: subject, content });
    } catch (e) {
      console.error('Failed to save subject content:', e);
    }
  },

  createSubject: async (projectName, name) => {
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const content = '# Nova Anotação\n\nDescreva o assunto...';
    await writeTextFile(
      `NotterProjects/${projectName}/${fileName}`,
      content,
      { baseDir: BaseDirectory.AppLocalData }
    );
    set((state) => ({ subjects: [...state.subjects, fileName], selectedSubject: fileName }));
    const userId = useAuthStore.getState().user?.id;
    if (userId) pushSubject(userId, projectName, fileName, content);
  },

  renameSubject: async (projectName, oldName, newName) => {
    const newFileName = newName.endsWith('.md') ? newName : `${newName}.md`;
    await rename(`NotterProjects/${projectName}/${oldName}`, `NotterProjects/${projectName}/${newFileName}`, { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
    set((state) => ({
      subjects: state.subjects.map((s) => (s === oldName ? newFileName : s)),
      selectedSubject: state.selectedSubject === oldName ? newFileName : state.selectedSubject,
    }));
    const userId = useAuthStore.getState().user?.id;
    if (userId) {
      deleteRemoteSubject(userId, projectName, oldName);
      try {
        const content = await readTextFile(`NotterProjects/${projectName}/${newFileName}`, { baseDir: BaseDirectory.AppLocalData });
        pushSubject(userId, projectName, newFileName, content);
      } catch { /* content will sync on next save */ }
    }
  },

  deleteSubject: async (projectName, subject) => {
    await remove(`NotterProjects/${projectName}/${subject}`, { baseDir: BaseDirectory.AppLocalData });
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
    set({ projects });
    writeTextFile(PROJECTS_FILE, JSON.stringify(projects, null, 2), { baseDir: BaseDirectory.AppLocalData }).catch(() => {});
    // Ensure local directories exist for each remote project
    for (const p of projects) {
      mkdir(`NotterProjects/${p.name}`, { baseDir: BaseDirectory.AppLocalData, recursive: true }).catch(() => {});
    }
  },

  applyRemoteSubjects: async (subjects) => {
    for (const s of subjects) {
      try {
        await mkdir(`NotterProjects/${s.projectName}`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
        await writeTextFile(`NotterProjects/${s.projectName}/${s.fileName}`, s.content, { baseDir: BaseDirectory.AppLocalData });
      } catch (e) {
        console.error(`Failed to write remote subject ${s.projectName}/${s.fileName}:`, e);
      }
    }
    // Reload subjects for the currently selected project
    const selected = get().selectedProject;
    if (selected) get().loadSubjects(selected.name);
  },

  pushAllSubjects: async (userId) => {
    const projects = get().projects;
    for (const project of projects) {
      try {
        const entries = await readDir(`NotterProjects/${project.name}`, { baseDir: BaseDirectory.AppLocalData });
        const mdFiles = entries.filter((e) => e.isFile && e.name.endsWith('.md'));
        for (const file of mdFiles) {
          const content = await readTextFile(`NotterProjects/${project.name}/${file.name}`, { baseDir: BaseDirectory.AppLocalData });
          await pushSubject(userId, project.name, file.name, content);
        }
      } catch { /* skip unreadable projects */ }
    }
  },

  flush: async () => {
    await projectsSync.flush();
    await subjectSync.flush();
  },
}));
