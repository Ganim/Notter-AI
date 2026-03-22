import { create } from 'zustand';
import { BaseDirectory, readDir, mkdir, readTextFile, writeTextFile, exists, remove, rename } from '@tauri-apps/plugin-fs';
import type { EditorTheme, Project } from '@/types';

const BG_COLORS: EditorTheme[] = [
  { name: 'Zinc',  value: 'bg-zinc-50 dark:bg-zinc-900',     light: { hex: '#fafafa', base: 'vs' },      dark: { hex: '#18181b', base: 'vs-dark' } },
  { name: 'Taupe', value: 'bg-stone-50 dark:bg-stone-900/10', light: { hex: '#fafaf9', base: 'vs' },      dark: { hex: '#131211', base: 'vs-dark' } },
  { name: 'Mist',  value: 'bg-sky-50 dark:bg-sky-950/10',    light: { hex: '#f0f9ff', base: 'vs' },      dark: { hex: '#0a1219', base: 'vs-dark' } },
  { name: 'Mauve', value: 'bg-purple-50 dark:bg-purple-950/10', light: { hex: '#faf5ff', base: 'vs' },   dark: { hex: '#0e0a15', base: 'vs-dark' } },
  { name: 'Olive', value: 'bg-lime-50 dark:bg-lime-950/10',  light: { hex: '#f7fee7', base: 'vs' },      dark: { hex: '#0d1209', base: 'vs-dark' } },
  { name: 'Dark',  value: 'bg-background',                    light: { hex: '#09090b', base: 'vs-dark' }, dark: { hex: '#09090b', base: 'vs-dark' } },
];

const PROJECTS_FILE = 'NotterProjects/projects.json';

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
  },

  renameProject: async (oldName, newName) => {
    await rename(`NotterProjects/${oldName}`, `NotterProjects/${newName}`, { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
    const newProjects = get().projects.map((p) => (p.name === oldName ? { ...p, name: newName } : p));
    set({
      projects: newProjects,
      selectedProject: get().selectedProject?.name === oldName ? { ...get().selectedProject!, name: newName } : get().selectedProject,
    });
    await writeTextFile(PROJECTS_FILE, JSON.stringify(newProjects, null, 2), { baseDir: BaseDirectory.AppLocalData });
  },

  updateProjectPath: async (name, newPath) => {
    const newProjects = get().projects.map((p) => (p.name === name ? { ...p, path: newPath } : p));
    set({
      projects: newProjects,
      selectedProject: get().selectedProject?.name === name ? { ...get().selectedProject!, path: newPath } : get().selectedProject,
    });
    await writeTextFile(PROJECTS_FILE, JSON.stringify(newProjects, null, 2), { baseDir: BaseDirectory.AppLocalData });
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
    } catch (e) {
      console.error('Failed to save subject content:', e);
    }
  },

  createSubject: async (projectName, name) => {
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    await writeTextFile(
      `NotterProjects/${projectName}/${fileName}`,
      '# Nova Anotação\n\nDescreva o assunto...',
      { baseDir: BaseDirectory.AppLocalData }
    );
    set((state) => ({ subjects: [...state.subjects, fileName], selectedSubject: fileName }));
  },

  renameSubject: async (projectName, oldName, newName) => {
    const newFileName = newName.endsWith('.md') ? newName : `${newName}.md`;
    await rename(`NotterProjects/${projectName}/${oldName}`, `NotterProjects/${projectName}/${newFileName}`, { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
    set((state) => ({
      subjects: state.subjects.map((s) => (s === oldName ? newFileName : s)),
      selectedSubject: state.selectedSubject === oldName ? newFileName : state.selectedSubject,
    }));
  },

  deleteSubject: async (projectName, subject) => {
    await remove(`NotterProjects/${projectName}/${subject}`, { baseDir: BaseDirectory.AppLocalData });
    set((state) => ({
      subjects: state.subjects.filter((s) => s !== subject),
      selectedSubject: state.selectedSubject === subject ? null : state.selectedSubject,
      subjectContent: state.selectedSubject === subject ? '' : state.subjectContent,
    }));
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
}));
