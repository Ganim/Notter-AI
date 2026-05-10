import { useState, useEffect, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { exists, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tryAccountScopedPath } from '@/lib/accounts/account-paths';
import { usePlannerStore } from '@/stores/planner-store';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import type { Project } from '@/types';
import { useWindowWidth } from '@/hooks/useWindowWidth';
import { useBoardStore } from '@/stores/board-store';
import { useAgentsStore } from '@/stores/agents-store';
import { useActionsStore } from '@/stores/actions-store';
import { useAiStore } from '@/stores/ai-store';
import { useAppStore } from '@/stores/app-store';
import { translateNote } from '@/lib/translator';
import { processNoteToAction } from '@/lib/action-processor';
import { PlanWithAiButton } from '@/components/planning/PlanWithAiButton';
import { Wand2, Loader2, Play, History, RefreshCw } from 'lucide-react';
import {
  Plus, Trash2, Pen, Eye, PencilLine, ChevronDown, ArrowLeft, FolderOpen, PanelLeftClose, PanelLeftOpen, Folder,
  Heading1, Heading2, Heading3, Bold, Italic, Underline, List, ListOrdered, Code, Quote, Minus,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { syncOnLogin } from '@/stores/auth-store';

type MobilePanel = 'projects' | 'subjects' | 'editor';

export function PlannerTab() {
  const { t } = useTranslation();
  const {
    projects, selectedProject, subjects, selectedSubject, subjectContent,
    isViewing, editorBgClass, editorTheme, bgColors,
    setSelectedProject, setSelectedSubject, setSubjectContent, setIsViewing, setEditorTheme,
    initFilesystem, saveSubjectContent, createProject, renameProject, deleteProject,
    createSubject, renameSubject, deleteSubject, refreshEditorTheme,
  } = usePlannerStore();

  // Dialog states
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const [isSubjectDialogOpen, setIsSubjectDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newSubjectName, setNewSubjectName] = useState('');
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<string | null>(null);
  const [deleteSubjectTarget, setDeleteSubjectTarget] = useState<string | null>(null);
  const [renameProjectTarget, setRenameProjectTarget] = useState<string | null>(null);
  const [renameSubjectTarget, setRenameSubjectTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Board dialog states
  const [isBoardDialogOpen, setIsBoardDialogOpen] = useState(false);
  const [boardTaskTitle, setBoardTaskTitle] = useState('');
  const [boardTaskDesc, setBoardTaskDesc] = useState('');
  const [boardTaskPriority, setBoardTaskPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const { createTaskFromPlanner, createTasksFromNote } = useBoardStore();
  const { profiles } = useAgentsStore();
  const [isTransformOpen, setIsTransformOpen] = useState(false);
  const [, setIsTransforming] = useState(false);

  // Action processing (Phase 3 + Phase 5 multi-provider)
  const activeModelTag = useAiStore((s) => s.activeModelTag);
  const ollamaStatus = useAiStore((s) => s.ollamaStatus);
  const activeProviderId = useAiStore((s) => s.activeProviderId);
  const cloudConfigs = useAiStore((s) => s.cloudConfigs);
  const addAction = useActionsStore((s) => s.addAction);
  const allActions = useActionsStore((s) => s.actions);

  // Sync
  const authUser = useAuthStore((s) => s.user);
  const [isSyncing, setIsSyncing] = useState(false);
  const handleForceSync = async () => {
    if (!authUser || isSyncing) return;
    setIsSyncing(true);
    try {
      await syncOnLogin(authUser.id);
      toast.success(t('planner.sync_success'));
    } catch {
      toast.error(t('planner.sync_error'));
    } finally {
      setIsSyncing(false);
    }
  };
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setSelectedAction = useActionsStore((s) => s.setSelected);
  const [isProcessing, setIsProcessing] = useState(false);

  // M2 migration banner: visible once the subjects→plans sentinel has been
  // written for the active account. While visible, the Planner tab is in
  // read-only mode (mutations disabled, Monaco readOnly).
  const [migrationBannerVisible, setMigrationBannerVisible] = useState(false);
  const isReadOnly = migrationBannerVisible;

  useEffect(() => {
    (async () => {
      try {
        const path = tryAccountScopedPath('.migration-m2-plans-complete');
        if (!path) return; // no active account; nothing to check
        const done = await exists(path, { baseDir: BaseDirectory.AppLocalData });
        setMigrationBannerVisible(done);
      } catch {
        // If the check fails, don't show the banner.
      }
    })();
  }, [authUser?.id]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  // Actions for the current subject (sorted newest first)
  const subjectHistory = useMemo(() => {
    if (!selectedProject || !selectedSubject) return [];
    return allActions
      .filter((a) => a.projectName === selectedProject.name && a.subjectName === selectedSubject)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [allActions, selectedProject, selectedSubject]);

  // Editor & layout refs
  const editorRef = useRef<any>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('projects');
  const projectsPanelRef = useRef<PanelImperativeHandle>(null);
  const subjectsPanelRef = useRef<PanelImperativeHandle>(null);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [subjectsCollapsed, setSubjectsCollapsed] = useState(false);

  const windowWidth = useWindowWidth();
  const isSmall = windowWidth < 640;
  const isMedium = windowWidth >= 640 && windowWidth < 1024;

  // --- Effects ---
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerOpen(false);
      }
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => { initFilesystem(); }, [initFilesystem]);

  useEffect(() => {
    const observer = new MutationObserver(() => { refreshEditorTheme(); });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [refreshEditorTheme]);

  // --- Editor helpers ---
  const handleEditorMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    editor.addAction({
      id: 'markdown-list-continue',
      label: 'Continue markdown list',
      keybindings: [monaco.KeyCode.Enter],
      run: (ed: any) => {
        const pos = ed.getPosition();
        const model = ed.getModel();
        if (!pos || !model) return;
        const line = model.getLineContent(pos.lineNumber);
        const orderedMatch = line.match(/^(\s*)(\d+)\.\s(.+)/);
        if (orderedMatch) {
          const [, indent, num] = orderedMatch;
          const next = parseInt(num) + 1;
          ed.executeEdits('list-continue', [{ range: { startLineNumber: pos.lineNumber, startColumn: line.length + 1, endLineNumber: pos.lineNumber, endColumn: line.length + 1 }, text: `\n${indent}${next}. ` }]);
          ed.setPosition({ lineNumber: pos.lineNumber + 1, column: indent.length + `${next}. `.length + 1 });
          return;
        }
        const emptyOrderedMatch = line.match(/^(\s*)\d+\.\s*$/);
        if (emptyOrderedMatch) {
          ed.executeEdits('list-continue', [{ range: { startLineNumber: pos.lineNumber, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: line.length + 1 }, text: '' }]);
          return;
        }
        const bulletMatch = line.match(/^(\s*)([-*])\s(.+)/);
        if (bulletMatch) {
          const [, indent, bullet] = bulletMatch;
          ed.executeEdits('list-continue', [{ range: { startLineNumber: pos.lineNumber, startColumn: line.length + 1, endLineNumber: pos.lineNumber, endColumn: line.length + 1 }, text: `\n${indent}${bullet} ` }]);
          ed.setPosition({ lineNumber: pos.lineNumber + 1, column: indent.length + 3 });
          return;
        }
        const emptyBulletMatch = line.match(/^(\s*)[-*]\s*$/);
        if (emptyBulletMatch) {
          ed.executeEdits('list-continue', [{ range: { startLineNumber: pos.lineNumber, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: line.length + 1 }, text: '' }]);
          return;
        }
        ed.trigger('keyboard', 'type', { text: '\n' });
      },
    });
  };

  const insertMarkdown = (prefix: string, suffix = '') => {
    if (isReadOnly) return;
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model) return;
    const selectedText = model.getValueInRange(selection);
    editor.executeEdits('toolbar', [{ range: selection, text: `${prefix}${selectedText}${suffix}` }]);
    if (!selectedText) {
      const pos = editor.getPosition();
      if (pos) {
        const newCol = pos.column - suffix.length;
        editor.setPosition({ lineNumber: pos.lineNumber, column: newCol > 0 ? newCol : pos.column });
      }
    }
    editor.focus();
  };

  const insertLine = (prefix: string, cursorLineOffset?: number) => {
    if (isReadOnly) return;
    const editor = editorRef.current;
    if (!editor) return;
    const pos = editor.getPosition();
    const model = editor.getModel();
    if (!pos || !model) return;
    const currentLine = model.getLineContent(pos.lineNumber);
    let insertLineNumber = pos.lineNumber;
    if (currentLine.trim() === '') {
      editor.executeEdits('toolbar', [{ range: { startLineNumber: pos.lineNumber, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: currentLine.length + 1 }, text: prefix }]);
    } else {
      const endCol = currentLine.length + 1;
      editor.executeEdits('toolbar', [{ range: { startLineNumber: pos.lineNumber, startColumn: endCol, endLineNumber: pos.lineNumber, endColumn: endCol }, text: `\n${prefix}` }]);
      insertLineNumber = pos.lineNumber + 1;
    }
    if (cursorLineOffset !== undefined) {
      editor.setPosition({ lineNumber: insertLineNumber + cursorLineOffset, column: 1 });
    }
    editor.focus();
  };

  const handleEditorWillMount = (monaco: any) => {
    bgColors.forEach((c) => {
      monaco.editor.defineTheme(`theme-${c.name}-light`, { base: c.light.base as any, inherit: true, rules: [], colors: { 'editor.background': c.light.hex } });
      monaco.editor.defineTheme(`theme-${c.name}-dark`, { base: c.dark.base as any, inherit: true, rules: [], colors: { 'editor.background': c.dark.hex } });
    });
    // Define surrounding pairs for markdown so typing a quote/bracket while
    // text is selected wraps it (VSCode-style) instead of replacing.
    monaco.languages.setLanguageConfiguration('markdown', {
      surroundingPairs: [
        { open: '"', close: '"' },
        { open: "'", close: "'" },
        { open: '`', close: '`' },
        { open: '(', close: ')' },
        { open: '[', close: ']' },
        { open: '{', close: '}' },
        { open: '*', close: '*' },
        { open: '_', close: '_' },
        { open: '<', close: '>' },
      ],
      autoClosingPairs: [
        { open: '(', close: ')' },
        { open: '[', close: ']' },
        { open: '{', close: '}' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
        { open: '`', close: '`' },
      ],
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    if (isReadOnly) return;
    const val = value || '';
    setSubjectContent(val);
    if (selectedProject && selectedSubject) saveSubjectContent(selectedProject.name, selectedSubject, val);
  };

  // --- CRUD handlers ---
  const handleBrowseFolder = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t('planner.project_path_label') });
    if (selected) setNewProjectPath(selected as string);
  };

  const handleCreateProjectSubmit = async () => {
    if (isReadOnly) return;
    if (!newProjectName.trim() || !newProjectPath.trim()) return;
    try {
      await createProject(newProjectName, newProjectPath);
      setIsProjectDialogOpen(false);
      setNewProjectName('');
      setNewProjectPath('');
      toast.success(t('planner.project_created'));
    } catch (e: any) { toast.error(t('planner.error_create_project', { error: e })); }
  };

  const confirmDeleteProject = async () => {
    if (isReadOnly) return;
    if (!deleteProjectTarget) return;
    try { await deleteProject(deleteProjectTarget); setDeleteProjectTarget(null); toast.success(t('planner.project_deleted')); }
    catch (e: any) { toast.error(t('planner.error_delete_project', { error: e })); }
  };

  const handleRenameProjectSubmit = async () => {
    if (isReadOnly) return;
    if (!renameProjectTarget || !renameValue.trim() || renameValue === renameProjectTarget) return;
    try { await renameProject(renameProjectTarget, renameValue); setRenameProjectTarget(null); setRenameValue(''); toast.success(t('planner.project_renamed')); }
    catch (e: any) { toast.error(t('planner.error_rename_project', { error: e })); }
  };

  const handleCreateSubjectSubmit = async () => {
    if (isReadOnly) return;
    if (!selectedProject || !newSubjectName.trim()) return;
    try { await createSubject(selectedProject.name, newSubjectName); setIsSubjectDialogOpen(false); setNewSubjectName(''); toast.success(t('planner.subject_created')); }
    catch (e: any) { toast.error(t('planner.error_create_subject', { error: e })); }
  };

  const confirmDeleteSubject = async () => {
    if (isReadOnly) return;
    if (!deleteSubjectTarget || !selectedProject) return;
    try { await deleteSubject(selectedProject.name, deleteSubjectTarget); setDeleteSubjectTarget(null); toast.success(t('planner.subject_deleted')); }
    catch (e: any) { toast.error(t('planner.error_delete_subject', { error: e })); }
  };

  const handleRenameSubjectSubmit = async () => {
    if (isReadOnly) return;
    if (!renameSubjectTarget || !selectedProject || !renameValue.trim() || renameValue === renameSubjectTarget.replace('.md', '')) return;
    try { await renameSubject(selectedProject.name, renameSubjectTarget, renameValue); setRenameSubjectTarget(null); setRenameValue(''); toast.success(t('planner.subject_renamed')); }
    catch (e: any) { toast.error(t('planner.error_rename_subject', { error: e })); }
  };

  const triggerProjectDialog = () => { if (isReadOnly) return; setNewProjectName(''); setNewProjectPath(''); setIsProjectDialogOpen(true); };
  const triggerSubjectDialog = () => { if (isReadOnly) return; setNewSubjectName(''); setIsSubjectDialogOpen(true); };

  const handleTransform = async (profile: import('@/types').AgentProfile) => {
    if (!selectedProject || !selectedSubject || !subjectContent.trim()) return;
    setIsTransformOpen(false);
    setIsTransforming(true);
    try {
      const result = await translateNote(profile, subjectContent);
      if (result.error) {
        toast.error(t('board.transform_error', { error: result.error }));
      } else {
        createTasksFromNote(selectedProject.name, selectedSubject, result.tasks);
        toast.success(t('board.transform_success', { count: result.tasks.length }));
      }
    } catch (e: any) {
      toast.error(t('board.transform_error', { error: e.message }));
    } finally {
      setIsTransforming(false);
    }
  };

  const canProcess = (() => {
    if (activeProviderId === 'ollama') {
      return ollamaStatus === 'running' && !!activeModelTag;
    }
    const cfg = cloudConfigs[activeProviderId];
    return !!cfg?.apiKey.trim() && !!cfg?.model.trim();
  })();

  const handleProcess = async () => {
    if (isReadOnly) return;
    if (!selectedProject || !selectedSubject) return;
    if (!subjectContent.trim()) {
      toast.error(t('planner.process_empty_note'));
      return;
    }
    if (!canProcess) {
      toast.error(t('planner.process_no_model'));
      return;
    }
    setIsProcessing(true);
    try {
      let modelTag: string;
      let apiKey: string | undefined;
      if (activeProviderId === 'ollama') {
        modelTag = activeModelTag!;
      } else {
        const cfg = cloudConfigs[activeProviderId];
        modelTag = cfg.model;
        apiKey = cfg.apiKey;
      }

      const action = await processNoteToAction({
        projectName: selectedProject.name,
        subjectName: selectedSubject,
        noteMarkdown: subjectContent,
        providerId: activeProviderId,
        modelTag,
        apiKey,
      });
      await addAction(action);
      toast.success(t('planner.process_success', { count: action.tasks.length }));

      // Clear the note for a new version, then navigate to the Actions tab
      setSubjectContent('');
      await saveSubjectContent(selectedProject.name, selectedSubject, '');
      setSelectedAction(action.id);
      setActiveTab('actions');
    } catch (e: any) {
      toast.error(t('planner.process_error', { error: e.message ?? String(e) }));
    } finally {
      setIsProcessing(false);
    }
  };

  const handleOpenHistoryVersion = async (actionId: string) => {
    if (isReadOnly) return;
    if (!selectedProject || !selectedSubject) return;
    const action = allActions.find((a) => a.id === actionId);
    if (!action) return;
    if (subjectContent.trim() && !confirm(t('planner.history_open_confirm'))) {
      return;
    }
    setSubjectContent(action.originalMarkdown);
    await saveSubjectContent(selectedProject.name, selectedSubject, action.originalMarkdown);
    setHistoryOpen(false);
  };

  // --- Mobile navigation ---
  const selectProjectMobile = (p: Project) => { setSelectedProject(p); setMobilePanel('subjects'); };
  const selectSubjectMobile = (s: string) => { setSelectedSubject(s); setMobilePanel('editor'); };
  const goBackToProjects = () => { setMobilePanel('projects'); setSelectedProject(null); };
  const goBackToSubjects = () => { setMobilePanel('subjects'); setSelectedSubject(null); };

  // --- Shared UI ---
  const tbBtn = 'p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors';

  const renderMigrationBanner = () => (
    migrationBannerVisible ? (
      <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200 shrink-0">
        <span>{t('plans.migrated_banner')}</span>
        <button
          className="underline font-medium ml-1"
          onClick={() => useAppStore.getState().setActiveTab('plans')}
        >
          {t('plans.migrated_link')}
        </button>
      </div>
    ) : null
  );

  const renderProjectsList = (onSelect: (p: Project) => void) => (
    <ScrollArea className="flex-1">
      <div className="p-2 space-y-1">
        {projects.map((p) => (
          <div key={p.name} onClick={() => onSelect(p)} className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedProject?.name === p.name ? 'bg-accent text-accent-foreground' : 'hover:bg-muted font-normal'}`}>
            <div className="flex flex-col gap-0.5 truncate">
              <span className="truncate">{p.name}</span>
              <span className="text-[10px] text-muted-foreground truncate font-normal opacity-70">{p.path}</span>
            </div>
            {!isReadOnly && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button onClick={(e) => { e.stopPropagation(); setRenameValue(p.name); setRenameProjectTarget(p.name); }} className="text-muted-foreground hover:text-foreground"><PencilLine size={14} /></button>
                <button onClick={(e) => { e.stopPropagation(); setDeleteProjectTarget(p.name); }} className="text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button>
              </div>
            )}
          </div>
        ))}
        {projects.length === 0 && <div className="text-xs p-2 normal-case text-muted-foreground">{t('planner.no_projects')}</div>}
      </div>
    </ScrollArea>
  );

  const renderSubjectsList = (onSelect: (s: string) => void) => (
    <ScrollArea className="flex-1">
      <div className="p-2 space-y-2">
        {subjects.map((subject) => (
          <div key={subject} onClick={() => onSelect(subject)} className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedSubject === subject ? 'bg-accent text-accent-foreground' : 'hover:bg-muted text-foreground'}`}>
            <span className="truncate font-normal">{subject.replace('.md', '')}</span>
            {!isReadOnly && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                <button onClick={(e) => { e.stopPropagation(); setRenameValue(subject.replace('.md', '')); setRenameSubjectTarget(subject); }} className="text-muted-foreground hover:text-foreground"><PencilLine size={14} /></button>
                <button onClick={(e) => { e.stopPropagation(); setDeleteSubjectTarget(subject); }} className="text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button>
              </div>
            )}
          </div>
        ))}
        {subjects.length === 0 && selectedProject && <div className="text-xs p-2 normal-case font-normal text-muted-foreground">{t('planner.create_first_subject')}</div>}
        {!selectedProject && <div className="text-xs p-2 normal-case font-normal text-muted-foreground">{t('planner.select_project')}</div>}
      </div>
    </ScrollArea>
  );

  const renderColorPicker = () => (
    <>
      <div className="hidden xl:flex bg-muted rounded-md p-1 border border-border">
        {bgColors.map((c) => (
          <button key={c.name} title={c.name} onClick={() => setEditorTheme(c)} className={`w-4 h-4 rounded-full mx-1 border cursor-pointer hover:scale-110 transition-transform ${c.value} ${editorBgClass === c.value ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'border-border'}`} />
        ))}
      </div>
      <div ref={colorPickerRef} className="relative xl:hidden">
        <button onClick={() => setColorPickerOpen(!colorPickerOpen)} className="flex items-center gap-1.5 bg-muted rounded-md px-2 py-1 border border-border hover:bg-muted/80 transition-colors">
          <div className={`w-4 h-4 rounded-full border ${bgColors.find((c) => c.value === editorBgClass)?.value || ''} ${editorBgClass === 'bg-background' ? 'border-foreground/30' : 'border-border'}`} />
          <ChevronDown size={12} className="text-muted-foreground" />
        </button>
        {colorPickerOpen && (
          <div className="absolute right-0 top-full mt-1 bg-popover border border-border rounded-md shadow-lg z-50 p-2 flex flex-col gap-1">
            {bgColors.map((c) => (
              <button key={c.name} onClick={() => { setEditorTheme(c); setColorPickerOpen(false); }} className={`flex items-center gap-2 px-2 py-1 rounded-sm text-xs hover:bg-muted transition-colors whitespace-nowrap ${editorBgClass === c.value ? 'bg-muted font-medium' : ''}`}>
                <div className={`w-3.5 h-3.5 rounded-full border ${c.value} ${c.value === 'bg-background' ? 'border-foreground/30' : 'border-border'}`} />
                <span>{c.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );

  const renderToolbar = () => (
    <div className="border-b border-border flex items-center px-2 sm:px-4 bg-muted/30 shrink-0 overflow-x-auto scrollbar-none">
      <div className="flex items-center gap-0.5 py-1">
        <button onClick={() => insertLine('# ')} className={tbBtn} title="H1"><Heading1 size={15} /></button>
        <button onClick={() => insertLine('## ')} className={tbBtn} title="H2"><Heading2 size={15} /></button>
        <button onClick={() => insertLine('### ')} className={tbBtn} title="H3"><Heading3 size={15} /></button>
        <div className="w-px h-4 bg-border mx-1" />
        <button onClick={() => insertMarkdown('**', '**')} className={tbBtn} title="Bold"><Bold size={15} /></button>
        <button onClick={() => insertMarkdown('*', '*')} className={tbBtn} title="Italic"><Italic size={15} /></button>
        <button onClick={() => insertMarkdown('<u>', '</u>')} className={tbBtn} title="Underline"><Underline size={15} /></button>
        <div className="w-px h-4 bg-border mx-1" />
        <button onClick={() => insertLine('- ')} className={tbBtn} title="List"><List size={15} /></button>
        <button onClick={() => insertLine('1. ')} className={tbBtn} title="Ordered List"><ListOrdered size={15} /></button>
        <div className="w-px h-4 bg-border mx-1" />
        <button onClick={() => insertMarkdown('`', '`')} className={tbBtn} title="Inline Code"><Code size={15} /></button>
        <button onClick={() => insertLine('```\n\n```', 1)} className={`${tbBtn} flex items-center justify-center w-[27px] h-[27px]`} title="Code Block"><span className="text-[11px] font-mono font-bold leading-none">{'{}'}</span></button>
        <button onClick={() => insertLine('> ')} className={tbBtn} title="Quote"><Quote size={15} /></button>
        <button onClick={() => insertLine('---')} className={tbBtn} title="Divider"><Minus size={15} /></button>
      </div>
    </div>
  );

  const renderEditorHeader = () => (
    <div className="h-10 sm:h-12 border-b border-border flex items-center justify-between px-2 sm:px-4 bg-background z-10 shrink-0 gap-2">
      {isSmall && (
        <button onClick={goBackToSubjects} className="shrink-0 p-1 rounded-sm hover:bg-muted transition-colors">
          <ArrowLeft size={16} />
        </button>
      )}
      <span className="font-semibold text-xs sm:text-sm text-foreground truncate min-w-0">
        {t('planner.notes_about')} <span className="text-primary">{selectedSubject?.replace('.md', '')}</span>
      </span>
      <div className="flex items-center gap-2 sm:gap-3 shrink-0 ml-auto">
        {renderColorPicker()}
        <div className="flex bg-muted rounded-md p-0.5 sm:p-1">
          <button onClick={() => setIsViewing(false)} className={`flex items-center gap-1 px-2 sm:px-3 py-1 rounded-sm text-xs font-medium transition-colors ${!isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            <Pen size={12} /><span className="hidden sm:inline">{t('planner.edit')}</span>
          </button>
          <button onClick={() => setIsViewing(true)} className={`flex items-center gap-1 px-2 sm:px-3 py-1 rounded-sm text-xs font-medium transition-colors ${isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            <Eye size={12} /><span className="hidden sm:inline">{t('planner.view')}</span>
          </button>
        </div>
        {selectedProject && selectedSubject && (
          <>
            <div ref={historyRef} className="relative">
              <button
                onClick={() => setHistoryOpen((v) => !v)}
                title={t('planner.history')}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <History size={12} />
              </button>
              {historyOpen && (
                <div className="absolute right-0 top-8 z-50 w-80 bg-popover border border-border rounded-md shadow-lg py-1 max-h-96 overflow-auto">
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold border-b border-border">
                    {t('planner.history')}
                  </div>
                  {subjectHistory.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground italic text-center">
                      {t('planner.history_empty')}
                    </div>
                  ) : (
                    subjectHistory.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => handleOpenHistoryVersion(a.id)}
                        className="w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b border-border/50 last:border-b-0"
                      >
                        <div className="text-xs font-medium text-foreground truncate">
                          {a.title || '(untitled)'}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {new Date(a.createdAt).toLocaleString()} · {a.tasks.length} tasks
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <button
              onClick={handleProcess}
              disabled={isProcessing || !subjectContent.trim() || !canProcess || isReadOnly}
              title={
                !canProcess
                  ? t('planner.process_no_model')
                  : !subjectContent.trim()
                  ? t('planner.process_empty_note')
                  : t('planner.process')
              }
              className="inline-flex items-center justify-center h-7 w-7 rounded-md bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isProcessing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} fill="currentColor" />
              )}
            </button>
            <PlanWithAiButton
              project={selectedProject}
              subjectName={selectedSubject}
              noteMarkdown={subjectContent}
              onStarted={(actionId) => {
                setSelectedAction(actionId);
                setActiveTab('actions');
              }}
            />
          </>
        )}
      </div>
    </div>
  );

  const renderEditorContent = () => (
    <div className={`flex-1 w-full relative overflow-y-auto transition-colors duration-300 ${editorBgClass}`}>
      {!isViewing ? (
        <Editor
          height="100%" defaultLanguage="markdown" theme={editorTheme}
          beforeMount={handleEditorWillMount} onMount={handleEditorMount}
          value={subjectContent} onChange={handleEditorChange}
          options={{ minimap: { enabled: false }, wordWrap: 'on', fontSize: 13, padding: { top: 16 }, autoSurround: 'languageDefined', autoClosingQuotes: 'languageDefined', autoClosingBrackets: 'languageDefined', readOnly: isReadOnly }}
          className="absolute inset-0"
        />
      ) : (
        <div className="p-4 sm:p-8 max-w-3xl mx-auto prose prose-sm dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{subjectContent}</ReactMarkdown>
        </div>
      )}
    </div>
  );

  const renderEditorPanel = () => (
    selectedSubject ? (
      <div className="flex flex-col h-full">
        {renderEditorHeader()}
        {!isViewing && renderToolbar()}
        {renderEditorContent()}
      </div>
    ) : (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4 text-center">
        {t('planner.select_subject_hint')}
      </div>
    )
  );

  // ============================
  // SMALL SCREEN
  // ============================
  if (isSmall) {
    return (
      <>
        <div className="flex flex-col h-full">
          {renderMigrationBanner()}
          {mobilePanel === 'projects' && (
            <>
              <div className="h-10 border-b border-border/50 flex items-center justify-between px-3 bg-muted/50 shrink-0">
                <span className="uppercase font-semibold text-xs text-muted-foreground">{t('planner.projects')}</span>
                <div className="flex items-center gap-1">
                  {authUser && (
                    <button onClick={handleForceSync} disabled={isSyncing} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50" title={t('planner.sync')}>
                      <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
                    </button>
                  )}
                  <button onClick={triggerProjectDialog} disabled={isReadOnly} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"><Plus size={14} /></button>
                </div>
              </div>
              {renderProjectsList(selectProjectMobile)}
            </>
          )}
          {mobilePanel === 'subjects' && (
            <>
              <div className="h-10 border-b border-border/50 flex items-center justify-between px-3 bg-muted/50 shrink-0">
                <div className="flex items-center gap-2">
                  <button onClick={goBackToProjects} className="p-1 rounded-sm hover:bg-muted transition-colors"><ArrowLeft size={14} /></button>
                  <span className="font-semibold text-xs text-foreground truncate">{selectedProject?.name}</span>
                </div>
                <button onClick={triggerSubjectDialog} disabled={!selectedProject || isReadOnly} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"><Plus size={14} /></button>
              </div>
              {renderSubjectsList(selectSubjectMobile)}
            </>
          )}
          {mobilePanel === 'editor' && (
            <>
              <div className="h-10 border-b border-border/50 flex items-center px-3 bg-muted/50 shrink-0 gap-2">
                <button onClick={goBackToSubjects} className="p-1 rounded-sm hover:bg-muted transition-colors shrink-0"><ArrowLeft size={14} /></button>
                <span className="font-semibold text-xs text-foreground truncate">{selectedProject?.name} / {selectedSubject?.replace('.md', '')}</span>
              </div>
              {renderEditorHeader()}
              {!isViewing && renderToolbar()}
              {renderEditorContent()}
            </>
          )}
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ============================
  // MEDIUM SCREEN
  // ============================
  if (isMedium) {
    return (
      <>
        <div className="flex flex-col h-full w-full">
          {renderMigrationBanner()}
          {/* @ts-expect-error shadcn type mismatch */}
          <ResizablePanelGroup direction="horizontal" className="w-full flex-1 rounded-none">
          <ResizablePanel
            panelRef={projectsPanelRef} defaultSize={35} minSize={20}
            collapsible collapsedSize={0}
            onResize={(size) => setProjectsCollapsed(size.asPercentage === 0)}
            className="bg-muted/50"
          >
            <div className="flex flex-col h-full">
              <div className="p-2 border-b border-border/50 flex items-center justify-between px-3">
                <span className="uppercase font-semibold text-xs text-muted-foreground">{t('planner.projects')}</span>
                <div className="flex items-center gap-1">
                  {authUser && (
                    <button onClick={handleForceSync} disabled={isSyncing} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50" title={t('planner.sync')}>
                      <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
                    </button>
                  )}
                  <button onClick={triggerProjectDialog} disabled={isReadOnly} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"><Plus size={14} /></button>
                  <button onClick={() => projectsPanelRef.current?.collapse()} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors"><PanelLeftClose size={14} /></button>
                </div>
              </div>
              <div className="border-b border-border/50">
                <ScrollArea className="max-h-[120px]">
                  <div className="p-1.5 space-y-0.5">
                    {projects.map((p) => (
                      <div key={p.name} onClick={() => setSelectedProject(p)} className={`group flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer ${selectedProject?.name === p.name ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-muted text-foreground'}`}>
                        <div className="flex items-center gap-1.5 truncate">
                          <FolderOpen size={12} className="shrink-0 opacity-50" />
                          <span className="truncate">{p.name}</span>
                        </div>
                        {!isReadOnly && (
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                            <button onClick={(e) => { e.stopPropagation(); setRenameValue(p.name); setRenameProjectTarget(p.name); }} className="text-muted-foreground hover:text-foreground p-0.5"><PencilLine size={12} /></button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteProjectTarget(p.name); }} className="text-muted-foreground hover:text-destructive p-0.5"><Trash2 size={12} /></button>
                          </div>
                        )}
                      </div>
                    ))}
                    {projects.length === 0 && <div className="text-xs p-2 text-muted-foreground">{t('planner.no_projects')}</div>}
                  </div>
                </ScrollArea>
              </div>
              <div className="p-2 border-b border-border/50 flex items-center justify-between px-3">
                <span className="uppercase font-semibold text-xs text-muted-foreground">{t('planner.subjects')}</span>
                <button onClick={triggerSubjectDialog} disabled={!selectedProject || isReadOnly} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"><Plus size={14} /></button>
              </div>
              {renderSubjectsList((s) => setSelectedSubject(s))}
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={65} minSize={40} className="flex flex-col bg-background">
            {projectsCollapsed && (
              <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/30 shrink-0">
                <button onClick={() => projectsPanelRef.current?.expand()} className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <PanelLeftOpen size={14} />
                  <span>{t('planner.projects')} / {t('planner.subjects')}</span>
                </button>
              </div>
            )}
            {renderEditorPanel()}
          </ResizablePanel>
        </ResizablePanelGroup>
        </div>
        {renderDialogs()}
      </>
    );
  }

  // ============================
  // LARGE SCREEN
  // ============================
  return (
    <>
      <div className="flex flex-col h-full w-full">
        {renderMigrationBanner()}
        {/* @ts-expect-error shadcn type mismatch */}
        <ResizablePanelGroup direction="horizontal" className="w-full flex-1 rounded-none">
        <ResizablePanel
          panelRef={projectsPanelRef} defaultSize={20} minSize={10}
          collapsible collapsedSize={0}
          onResize={(size) => setProjectsCollapsed(size.asPercentage === 0)}
          className="bg-muted/50"
        >
          <div className="flex flex-col h-full uppercase font-semibold text-xs text-muted-foreground">
            <div className="p-3 border-b border-border/50 flex items-center justify-between">
              <span>{t('planner.projects')}</span>
              <div className="flex items-center gap-1">
                {authUser && (
                  <button onClick={handleForceSync} disabled={isSyncing} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50" title={t('planner.sync')}>
                    <RefreshCw size={14} className={isSyncing ? 'animate-spin' : ''} />
                  </button>
                )}
                <button onClick={triggerProjectDialog} disabled={isReadOnly} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50" title={t('planner.create_project')}><Plus size={14} /></button>
                <button onClick={() => projectsPanelRef.current?.collapse()} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors" title="Collapse"><PanelLeftClose size={14} /></button>
              </div>
            </div>
            {renderProjectsList((p) => setSelectedProject(p))}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel
          panelRef={subjectsPanelRef} defaultSize={25} minSize={10}
          collapsible collapsedSize={0}
          onResize={(size) => setSubjectsCollapsed(size.asPercentage === 0)}
          className="bg-muted/20"
        >
          <div className="flex flex-col h-full font-semibold text-xs text-muted-foreground">
            <div className="p-3 border-b border-border/50 uppercase flex items-center justify-between">
              <span>{t('planner.subjects')}</span>
              <div className="flex items-center gap-1">
                <button onClick={triggerSubjectDialog} disabled={!selectedProject || isReadOnly} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50" title={t('planner.create_subject')}><Plus size={14} /></button>
                <button onClick={() => subjectsPanelRef.current?.collapse()} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors" title="Collapse"><PanelLeftClose size={14} /></button>
              </div>
            </div>
            {renderSubjectsList((s) => setSelectedSubject(s))}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize={55} minSize={30} className="flex flex-col bg-background">
          {(projectsCollapsed || subjectsCollapsed) && (
            <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/30 shrink-0">
              {projectsCollapsed && (
                <button onClick={() => projectsPanelRef.current?.expand()} className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <PanelLeftOpen size={14} /><span>{t('planner.projects')}</span>
                </button>
              )}
              {subjectsCollapsed && (
                <button onClick={() => subjectsPanelRef.current?.expand()} className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <PanelLeftOpen size={14} /><span>{t('planner.subjects')}</span>
                </button>
              )}
            </div>
          )}
          {renderEditorPanel()}
        </ResizablePanel>
      </ResizablePanelGroup>
      </div>
      {renderDialogs()}
    </>
  );

  // --- Dialogs ---
  function renderDialogs() {
    return (
      <>
        {/* Create Project */}
        <Dialog open={isProjectDialogOpen} onOpenChange={setIsProjectDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.new_project')}</DialogTitle>
              <DialogDescription>{t('planner.new_project_desc')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <input autoFocus type="text" placeholder={t('planner.project_name_placeholder')} value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newProjectPath && handleCreateProjectSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('planner.project_path_label')}</label>
                <div className="flex gap-2">
                  <input type="text" readOnly value={newProjectPath} placeholder={t('planner.project_path_placeholder')} className="flex-1 bg-muted/50 border border-input rounded-md p-2 text-sm text-foreground outline-none cursor-pointer truncate" onClick={handleBrowseFolder} />
                  <button onClick={handleBrowseFolder} className="bg-muted hover:bg-muted/80 border border-border px-3 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5">
                    <Folder size={14} />{t('planner.browse')}
                  </button>
                </div>
              </div>
            </div>
            <DialogFooter>
              <button onClick={handleCreateProjectSubmit} disabled={!newProjectName.trim() || !newProjectPath.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors disabled:opacity-50">{t('planner.create')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Rename Project */}
        <Dialog open={!!renameProjectTarget} onOpenChange={(open) => { if (!open) setRenameProjectTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.rename_project')}</DialogTitle>
              <DialogDescription>{t('planner.rename_project_desc', { name: renameProjectTarget })}</DialogDescription>
            </DialogHeader>
            <input autoFocus type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleRenameProjectSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
            <DialogFooter>
              <button onClick={() => setRenameProjectTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('planner.cancel')}</button>
              <button onClick={handleRenameProjectSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.rename')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Project */}
        <Dialog open={!!deleteProjectTarget} onOpenChange={(open) => !open && setDeleteProjectTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.delete_project')}</DialogTitle>
              <DialogDescription>{t('planner.delete_project_desc', { name: deleteProjectTarget })}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button onClick={() => setDeleteProjectTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('planner.cancel')}</button>
              <button onClick={confirmDeleteProject} className="bg-rose-500 hover:bg-rose-600 text-white px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.delete')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Create Subject */}
        <Dialog open={isSubjectDialogOpen} onOpenChange={setIsSubjectDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.new_subject_in', { project: selectedProject?.name })}</DialogTitle>
              <DialogDescription>{t('planner.new_subject_desc')}</DialogDescription>
            </DialogHeader>
            <input autoFocus type="text" placeholder={t('planner.subject_placeholder')} value={newSubjectName} onChange={(e) => setNewSubjectName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateSubjectSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
            <DialogFooter>
              <button onClick={handleCreateSubjectSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.create')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Rename Subject */}
        <Dialog open={!!renameSubjectTarget} onOpenChange={(open) => { if (!open) setRenameSubjectTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.rename_subject')}</DialogTitle>
              <DialogDescription>{t('planner.rename_subject_desc', { name: renameSubjectTarget?.replace('.md', '') })}</DialogDescription>
            </DialogHeader>
            <input autoFocus type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleRenameSubjectSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
            <DialogFooter>
              <button onClick={() => setRenameSubjectTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('planner.cancel')}</button>
              <button onClick={handleRenameSubjectSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.rename')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Subject */}
        <Dialog open={!!deleteSubjectTarget} onOpenChange={(open) => !open && setDeleteSubjectTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.delete_subject')}</DialogTitle>
              <DialogDescription>{t('planner.delete_subject_desc', { name: deleteSubjectTarget })}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button onClick={() => setDeleteSubjectTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('planner.cancel')}</button>
              <button onClick={confirmDeleteSubject} className="bg-rose-500 hover:bg-rose-600 text-white px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.delete')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Create Board Task */}
        <Dialog open={isBoardDialogOpen} onOpenChange={setIsBoardDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('board.create_task')}</DialogTitle>
              <DialogDescription>{t('board.create_task_desc')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.project')}</label>
                <input type="text" readOnly value={selectedProject?.name || ''} className="w-full bg-muted/50 border border-border rounded-md p-2 text-sm text-foreground" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.subject')}</label>
                <input type="text" readOnly value={selectedSubject?.replace('.md', '') || ''} className="w-full bg-muted/50 border border-border rounded-md p-2 text-sm text-foreground" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.title_label')}</label>
                <input autoFocus type="text" value={boardTaskTitle} onChange={(e) => setBoardTaskTitle(e.target.value)} placeholder={t('board.title_placeholder')} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.description_label')}</label>
                <textarea value={boardTaskDesc} onChange={(e) => setBoardTaskDesc(e.target.value)} placeholder={t('board.description_placeholder')} rows={3} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring resize-y" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">{t('board.priority_label')}</label>
                <select value={boardTaskPriority} onChange={(e) => setBoardTaskPriority(e.target.value as 'low' | 'medium' | 'high')} className="w-full bg-background text-foreground border border-border rounded-md px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring">
                  <option value="low">{t('board.priority_low')}</option>
                  <option value="medium">{t('board.priority_medium')}</option>
                  <option value="high">{t('board.priority_high')}</option>
                </select>
              </div>
            </div>
            <DialogFooter>
              <button onClick={() => setIsBoardDialogOpen(false)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('board.cancel')}</button>
              <button
                onClick={() => {
                  if (!selectedProject || !selectedSubject || !boardTaskTitle.trim()) return;
                  createTaskFromPlanner(selectedProject.name, selectedSubject, boardTaskTitle, boardTaskDesc, boardTaskPriority);
                  setIsBoardDialogOpen(false);
                  toast.success(t('board.task_created'));
                }}
                disabled={!boardTaskTitle.trim()}
                className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors disabled:opacity-50"
              >
                {t('board.create_task')}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Select Agent for Transform */}
        <Dialog open={isTransformOpen} onOpenChange={setIsTransformOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('board.select_agent')}</DialogTitle>
              <DialogDescription>{t('board.select_agent_desc')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2 mt-2">
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => handleTransform(p)}
                  className="w-full flex items-center gap-3 p-3 border border-border rounded-md hover:border-purple-500/50 hover:bg-purple-500/5 transition-all text-left group"
                >
                  <div className="p-2 rounded-md bg-purple-500/10 text-purple-500 group-hover:bg-purple-500 group-hover:text-white transition-colors">
                    <Wand2 size={16} />
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-semibold truncate group-hover:text-purple-500 transition-colors">{p.name}</span>
                    <span className="text-[10px] text-muted-foreground">{p.provider.toUpperCase()}</span>
                  </div>
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }
}
