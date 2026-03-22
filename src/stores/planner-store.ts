import { create } from 'zustand';
import { BaseDirectory, readDir, mkdir, readTextFile, writeTextFile, exists, remove, rename } from '@tauri-apps/plugin-fs';
import type { EditorTheme } from '@/types';

const BG_COLORS: EditorTheme[] = [
  { name: 'Zinc', value: 'bg-zinc-50 dark:bg-zinc-900', hex: '#fafafa', base: 'vs' },
  { name: 'Taupe', value: 'bg-stone-50 dark:bg-stone-900', hex: '#fafaf9', base: 'vs' },
  { name: 'Mist', value: 'bg-sky-50 dark:bg-sky-950', hex: '#f0f9ff', base: 'vs' },
  { name: 'Mauve', value: 'bg-purple-50 dark:bg-purple-950', hex: '#faf5ff', base: 'vs' },
  { name: 'Olive', value: 'bg-lime-50 dark:bg-lime-950', hex: '#f7fee7', base: 'vs' },
  { name: 'Dark', value: 'bg-background', hex: '#09090b', base: 'vs-dark' },
];

interface PlannerState {
  subjects: string[];
  selectedSubject: string | null;
  tasks: string[];
  selectedTask: string | null;
  taskContent: string;
  isViewing: boolean;
  editorBgClass: string;
  editorTheme: string;
  bgColors: EditorTheme[];

  setSelectedSubject: (subject: string | null) => void;
  setSelectedTask: (task: string | null) => void;
  setTaskContent: (content: string) => void;
  setIsViewing: (viewing: boolean) => void;
  setEditorTheme: (theme: EditorTheme) => void;

  initFilesystem: () => Promise<void>;
  loadTasks: (subject: string) => Promise<void>;
  loadTaskContent: (subject: string, task: string) => Promise<void>;
  saveTaskContent: (subject: string, task: string, content: string) => Promise<void>;
  createSubject: (name: string) => Promise<void>;
  renameSubject: (oldName: string, newName: string) => Promise<void>;
  deleteSubject: (name: string) => Promise<void>;
  createTask: (subject: string, name: string) => Promise<void>;
  renameTask: (subject: string, oldName: string, newName: string) => Promise<void>;
  deleteTask: (subject: string, task: string) => Promise<void>;
}

export const usePlannerStore = create<PlannerState>((set, get) => ({
  subjects: [],
  selectedSubject: null,
  tasks: [],
  selectedTask: null,
  taskContent: '# Anotações da Tarefa',
  isViewing: false,
  editorBgClass: BG_COLORS[0].value,
  editorTheme: `theme-${BG_COLORS[0].name}`,
  bgColors: BG_COLORS,

  setSelectedSubject: (subject) => {
    set({ selectedSubject: subject, selectedTask: null, tasks: [] });
    if (subject) get().loadTasks(subject);
  },

  setSelectedTask: (task) => {
    set({ selectedTask: task });
    const subject = get().selectedSubject;
    if (subject && task) get().loadTaskContent(subject, task);
  },

  setTaskContent: (content) => set({ taskContent: content }),
  setIsViewing: (viewing) => set({ isViewing: viewing }),

  setEditorTheme: (theme) => set({
    editorBgClass: theme.value,
    editorTheme: `theme-${theme.name}`,
  }),

  initFilesystem: async () => {
    try {
      const hasDir = await exists('AgentNotes', { baseDir: BaseDirectory.AppLocalData });
      if (!hasDir) await mkdir('AgentNotes', { baseDir: BaseDirectory.AppLocalData, recursive: true });
      const entries = await readDir('AgentNotes', { baseDir: BaseDirectory.AppLocalData });
      const dirs = entries.filter((e) => e.isDirectory).map((e) => e.name);
      set({ subjects: dirs });
    } catch (e) {
      console.error('Failed to init planner filesystem:', e);
    }
  },

  loadTasks: async (subject) => {
    try {
      const entries = await readDir(`AgentNotes/${subject}`, { baseDir: BaseDirectory.AppLocalData });
      const files = entries.filter((e) => e.isFile && e.name.endsWith('.md')).map((e) => e.name);
      set({ tasks: files });
    } catch (e) {
      console.error('Failed to load tasks:', e);
    }
  },

  loadTaskContent: async (subject, task) => {
    try {
      const content = await readTextFile(`AgentNotes/${subject}/${task}`, { baseDir: BaseDirectory.AppLocalData });
      set({ taskContent: content });
    } catch (e) {
      set({ taskContent: '# Erro ao carregar' });
    }
  },

  saveTaskContent: async (subject, task, content) => {
    try {
      await writeTextFile(`AgentNotes/${subject}/${task}`, content, { baseDir: BaseDirectory.AppLocalData });
    } catch (e) {
      console.error('Failed to save task content:', e);
    }
  },

  createSubject: async (name) => {
    await mkdir(`AgentNotes/${name}`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    set((state) => ({ subjects: [...state.subjects, name] }));
  },

  renameSubject: async (oldName, newName) => {
    await rename(`AgentNotes/${oldName}`, `AgentNotes/${newName}`, { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
    set((state) => ({
      subjects: state.subjects.map((s) => (s === oldName ? newName : s)),
      selectedSubject: state.selectedSubject === oldName ? newName : state.selectedSubject,
    }));
  },

  deleteSubject: async (name) => {
    await remove(`AgentNotes/${name}`, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    set((state) => ({
      subjects: state.subjects.filter((s) => s !== name),
      selectedSubject: state.selectedSubject === name ? null : state.selectedSubject,
      selectedTask: state.selectedSubject === name ? null : state.selectedTask,
    }));
  },

  createTask: async (subject, name) => {
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    await writeTextFile(
      `AgentNotes/${subject}/${fileName}`,
      '# Nova Anotação\n\nDescreva a tarefa...',
      { baseDir: BaseDirectory.AppLocalData }
    );
    set((state) => ({ tasks: [...state.tasks, fileName], selectedTask: fileName }));
  },

  renameTask: async (subject, oldName, newName) => {
    const newFileName = newName.endsWith('.md') ? newName : `${newName}.md`;
    await rename(`AgentNotes/${subject}/${oldName}`, `AgentNotes/${subject}/${newFileName}`, { oldPathBaseDir: BaseDirectory.AppLocalData, newPathBaseDir: BaseDirectory.AppLocalData });
    set((state) => ({
      tasks: state.tasks.map((t) => (t === oldName ? newFileName : t)),
      selectedTask: state.selectedTask === oldName ? newFileName : state.selectedTask,
    }));
  },

  deleteTask: async (subject, task) => {
    await remove(`AgentNotes/${subject}/${task}`, { baseDir: BaseDirectory.AppLocalData });
    set((state) => ({
      tasks: state.tasks.filter((t) => t !== task),
      selectedTask: state.selectedTask === task ? null : state.selectedTask,
      taskContent: state.selectedTask === task ? '' : state.taskContent,
    }));
  },
}));
