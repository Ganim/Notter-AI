import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlannerStore } from '@/stores/planner-store';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { open as openDialogPick } from '@tauri-apps/plugin-dialog';
import { exportCurrentVersion } from '@/lib/plans/export';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import type { Project } from '@/types';
import { useWindowWidth } from '@/hooks/useWindowWidth';
import { useBoardStore } from '@/stores/board-store';
import { CommentsPanel } from '@/components/plans/CommentsPanel';
import { MoveProjectToWorkspaceMenu } from '@/components/MoveProjectToWorkspaceMenu';
import { formatRelativeTime } from '@/lib/plans/format';
import { Loader2, History, RefreshCw, PanelRightClose, PanelRightOpen, Upload, Download } from 'lucide-react';
import {
  Plus, Trash2, Pen, Eye, PencilLine, ChevronDown, ArrowLeft, FolderOpen, PanelLeftClose, PanelLeftOpen,
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
  // Subject counts in the project list use the canonical subjectRows slice
  // (cross-project, cross-workspace). Subscribed via a selector so the count
  // updates reactively when subjects are added/removed/synced.
  const subjectRows = usePlannerStore((s) => s.subjectRows);

  // Dialog states
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const [isSubjectDialogOpen, setIsSubjectDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
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
  const { createTaskFromPlanner } = useBoardStore();

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

  // Import / Export (M4)
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  // Resolve a unique subject filename within the current project by appending
  // " (2)", " (3)", ... until a free slot is found. Defensive cap at 1000;
  // beyond that fall back to a timestamp suffix.
  const makeUniqueSubjectFileName = (base: string, existingFileNames: string[]): string => {
    const baseNoExt = base.replace(/\.md$/i, '');
    const candidate = `${baseNoExt}.md`;
    if (!existingFileNames.includes(candidate)) return candidate;
    for (let i = 2; i < 1000; i++) {
      const alt = `${baseNoExt} (${i}).md`;
      if (!existingFileNames.includes(alt)) return alt;
    }
    return `${baseNoExt} (${Date.now()}).md`;
  };

  const handleImport = async () => {
    if (isImporting || !selectedProject) return;
    setIsImporting(true);
    try {
      const picked = await openDialogPick({
        multiple: false,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!picked || Array.isArray(picked)) return;
      const pickedPath = picked as string;
      const { readTextFile: readFs } = await import('@tauri-apps/plugin-fs');
      const fileText = await readFs(pickedPath);

      // Derive a base name. Prefer the imported file's basename; frontmatter
      // title is ignored — the user said imports always create a brand-new
      // subject, never reuse an existing subject_id linkage.
      const rawBase = (pickedPath.split(/[\\/]/).pop() ?? 'Imported.md').replace(/\.md$/i, '');
      const existing = subjectRows
        .filter((s) => s.projectName === selectedProject.name)
        .map((s) => s.fileName);
      const uniqueName = makeUniqueSubjectFileName(rawBase, existing);

      await createSubject(selectedProject.name, uniqueName, fileText);
      toast.success(t('planner.subject_imported', { name: uniqueName.replace(/\.md$/i, '') }));
    } catch (e: any) {
      toast.error(t('planner.subject_import_failed', { message: e?.message ?? String(e) }));
    } finally {
      setIsImporting(false);
    }
  };

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const result = await exportCurrentVersion();
      if (result.cancelled) {
        toast.info(t('import_export.export_cancelled'));
      } else {
        toast.success(t('import_export.export_success', { path: result.path }));
      }
    } catch (e: any) {
      if (e?.name === 'ExportError') {
        if (e.code === 'NO_SUBJECT') toast.error(t('import_export.export_no_subject'));
        else if (e.code === 'NO_VERSION') toast.error(t('import_export.export_no_version'));
        else if (e.code === 'VERSION_NOT_LOADED') toast.error(t('import_export.export_version_not_loaded'));
        else toast.error(t('import_export.export_failed', { message: e?.message ?? String(e) }));
      } else {
        toast.error(t('import_export.export_failed', { message: e?.message ?? String(e) }));
      }
    } finally {
      setIsExporting(false);
    }
  };
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);

  // Reactive read of the live current_version_id for the selected subject.
  // Drives the "current" marker badge in the History dropdown. The
  // `subjectRows` slice is replaced wholesale on every postgres_changes event
  // for the `subjects` table, so this re-runs on remote adopts too.
  const currentVersionId = usePlannerStore((s) => {
    if (!s.selectedProject || !s.selectedSubject) return null;
    return (
      s.subjectRows.find(
        (r) =>
          r.projectName === s.selectedProject!.name &&
          r.fileName === s.selectedSubject,
      )?.currentVersionId ?? null
    );
  });

  // Editor & layout refs
  const editorRef = useRef<any>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('projects');
  const projectsPanelRef = useRef<PanelImperativeHandle>(null);
  const subjectsPanelRef = useRef<PanelImperativeHandle>(null);
  const versionsPanelRef = useRef<PanelImperativeHandle>(null);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [subjectsCollapsed, setSubjectsCollapsed] = useState(false);
  const [isVersionsPanelCollapsed, setIsVersionsPanelCollapsed] = useState(true);

  const windowWidth = useWindowWidth();
  const isSmall = windowWidth < 640;
  const isMedium = windowWidth >= 640 && windowWidth < 1024;

  // Subject-versions store subscriptions for preview-mode banner + editor swap
  const previewVersionId = useSubjectVersionsStore((s) => s.previewVersionId);
  const versionList = useSubjectVersionsStore((s) => s.versions);
  const previewVersion = previewVersionId
    ? versionList.find((v) => v.id === previewVersionId) ?? null
    : null;
  const exitPreview = useSubjectVersionsStore((s) => s.exitPreview);
  const adoptVersion = useSubjectVersionsStore((s) => s.adoptVersion);

  const toggleVersionsPanel = () => {
    const ref = versionsPanelRef.current;
    if (!ref) return;
    if (ref.isCollapsed()) ref.expand();
    else ref.collapse();
  };

  // Start the versions/comments side panel collapsed. The defaultSize on the
  // ResizablePanel only applies on first render; we need an imperative collapse()
  // after mount so the panel begins hidden until the user toggles it open.
  useEffect(() => {
    versionsPanelRef.current?.collapse();
  }, []);

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
    // Guard: while previewing a historical version, Monaco still emits onChange
    // when we swap its `value` prop programmatically. Ignore those events so we
    // don't clobber the live subjectContent (or persist the preview to disk).
    if (previewVersionId) return;
    const val = value || '';
    setSubjectContent(val);
    if (selectedProject && selectedSubject) saveSubjectContent(selectedProject.name, selectedSubject, val);
  };

  // --- CRUD handlers ---
  const handleCreateProjectSubmit = async () => {
    if (!newProjectName.trim()) return;
    try {
      await createProject(newProjectName, '');
      setIsProjectDialogOpen(false);
      setNewProjectName('');
      toast.success(t('planner.project_created'));
    } catch (e: any) { toast.error(t('planner.error_create_project', { error: e })); }
  };

  const confirmDeleteProject = async () => {
    if (!deleteProjectTarget) return;
    try { await deleteProject(deleteProjectTarget); setDeleteProjectTarget(null); toast.success(t('planner.project_deleted')); }
    catch (e: any) { toast.error(t('planner.error_delete_project', { error: e })); }
  };

  const handleRenameProjectSubmit = async () => {
    if (!renameProjectTarget || !renameValue.trim() || renameValue === renameProjectTarget) return;
    try { await renameProject(renameProjectTarget, renameValue); setRenameProjectTarget(null); setRenameValue(''); toast.success(t('planner.project_renamed')); }
    catch (e: any) { toast.error(t('planner.error_rename_project', { error: e })); }
  };

  const handleCreateSubjectSubmit = async () => {
    if (!selectedProject || !newSubjectName.trim()) return;
    try { await createSubject(selectedProject.name, newSubjectName); setIsSubjectDialogOpen(false); setNewSubjectName(''); toast.success(t('planner.subject_created')); }
    catch (e: any) { toast.error(t('planner.error_create_subject', { error: e })); }
  };

  const confirmDeleteSubject = async () => {
    if (!deleteSubjectTarget || !selectedProject) return;
    try { await deleteSubject(selectedProject.name, deleteSubjectTarget); setDeleteSubjectTarget(null); toast.success(t('planner.subject_deleted')); }
    catch (e: any) { toast.error(t('planner.error_delete_subject', { error: e })); }
  };

  const handleRenameSubjectSubmit = async () => {
    if (!renameSubjectTarget || !selectedProject || !renameValue.trim() || renameValue === renameSubjectTarget.replace('.md', '')) return;
    try { await renameSubject(selectedProject.name, renameSubjectTarget, renameValue); setRenameSubjectTarget(null); setRenameValue(''); toast.success(t('planner.subject_renamed')); }
    catch (e: any) { toast.error(t('planner.error_rename_subject', { error: e })); }
  };

  const triggerProjectDialog = () => { setNewProjectName(''); setIsProjectDialogOpen(true); };
  const triggerSubjectDialog = () => { setNewSubjectName(''); setIsSubjectDialogOpen(true); };

  // --- Mobile navigation ---
  const selectProjectMobile = (p: Project) => { setSelectedProject(p); setMobilePanel('subjects'); };
  const selectSubjectMobile = (s: string) => { setSelectedSubject(s); setMobilePanel('editor'); };
  const goBackToProjects = () => { setMobilePanel('projects'); setSelectedProject(null); };
  const goBackToSubjects = () => { setMobilePanel('subjects'); setSelectedSubject(null); };

  // --- Shared UI ---
  const tbBtn = 'p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors';

  const renderProjectsList = (onSelect: (p: Project) => void) => (
    <ScrollArea className="flex-1">
      <div className="p-2 space-y-1">
        {projects.map((p) => {
          const subjectCount = subjectRows.filter((s) => s.projectName === p.name).length;
          return (
          <div key={p.name} onClick={() => onSelect(p)} className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedProject?.name === p.name ? 'bg-accent text-accent-foreground' : 'hover:bg-muted font-normal'}`}>
            <div className="flex flex-col gap-0.5 truncate">
              <span className="truncate">{p.name}</span>
              <span className="text-[10px] text-muted-foreground truncate font-normal opacity-70">
                {t('planner.subject_count', { count: subjectCount })}
              </span>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <button onClick={(e) => { e.stopPropagation(); setRenameValue(p.name); setRenameProjectTarget(p.name); }} className="text-muted-foreground hover:text-foreground"><PencilLine size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); setDeleteProjectTarget(p.name); }} className="text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button>
              <MoveProjectToWorkspaceMenu projectName={p.name} iconSize={14} />
            </div>
          </div>
          );
        })}
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
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <button onClick={(e) => { e.stopPropagation(); setRenameValue(subject.replace('.md', '')); setRenameSubjectTarget(subject); }} className="text-muted-foreground hover:text-foreground"><PencilLine size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); setDeleteSubjectTarget(subject); }} className="text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button>
            </div>
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
            <button
              onClick={handleExport}
              disabled={isExporting}
              title={t('import_export.export_button_tooltip')}
              className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            >
              {isExporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            </button>
            {!isSmall && (
              <button
                onClick={toggleVersionsPanel}
                title={t('plans.comments_title')}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {isVersionsPanelCollapsed ? <PanelRightOpen size={12} /> : <PanelRightClose size={12} />}
              </button>
            )}
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
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold border-b border-border flex items-center justify-between gap-2">
                    <span>{t('planner.history')}</span>
                    <button
                      onClick={async () => {
                        const row = usePlannerStore.getState().selectedSubjectRow();
                        if (!row) return;
                        const v = await useSubjectVersionsStore.getState().snapshotAndAdopt({
                          contentMarkdown: subjectContent,
                          source: 'user',
                          label: t('plans.manual_edit_label'),
                          parentVersionId: row.currentVersionId ?? null,
                        });
                        if (v) {
                          // Optimistic marker update so the History dropdown reflects
                          // the new current version immediately (realtime UPDATE on
                          // subjects.current_version_id can lag — same pattern as
                          // commits f248994 / 697ac90).
                          usePlannerStore.getState().markSubjectCurrentVersion(v.subjectId, v.id);
                          toast.success(t('planner.version_created'));
                        } else {
                          toast.error(t('planner.version_create_failed'));
                        }
                      }}
                      disabled={!selectedSubject}
                      title={t('planner.create_version')}
                      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed normal-case"
                    >
                      <Plus size={12} />
                    </button>
                  </div>
                  {versionList.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground italic text-center">
                      {t('planner.history_empty_versions')}
                    </div>
                  ) : (
                    versionList.map((v) => {
                      const isCurrent = currentVersionId === v.id;
                      return (
                        <button
                          key={v.id}
                          onClick={() => {
                            useSubjectVersionsStore.getState().enterPreview(v.id);
                            setHistoryOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 hover:bg-muted transition-colors border-b border-border/50 last:border-b-0 ${isCurrent ? 'bg-primary/5' : ''}`}
                        >
                          <div className="text-xs font-medium text-foreground truncate flex items-center justify-between gap-2">
                            <span className="truncate">{v.label ?? `v${v.id.slice(0, 6)}`}</span>
                            {isCurrent && (
                              <span className="text-[9px] uppercase tracking-wider text-primary shrink-0">
                                {t('plans.current_marker')}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                            <span>{formatRelativeTime(v.createdAt)}</span>
                            <span className="opacity-60">·</span>
                            <span>
                              {v.source === 'user'
                                ? t('plans.source_user')
                                : v.source === 'ai'
                                ? t('plans.source_ai')
                                : t('plans.source_import')}
                            </span>
                            {v.sourceActor && (
                              <>
                                <span className="opacity-60">·</span>
                                <span className="truncate">{v.sourceActor}</span>
                              </>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const renderPreviewBanner = () => {
    if (!previewVersion) return null;
    return (
      <div className="border-b border-primary bg-primary/5 px-4 py-2 flex items-center justify-between gap-2 shrink-0">
        <span className="text-xs">
          {t('plans.preview_banner', {
            label: previewVersion.label ?? `v${previewVersion.id.slice(0, 6)}`,
            when: formatRelativeTime(previewVersion.createdAt),
          })}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => exitPreview()}>
            {t('plans.exit_preview')}
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const adopted = await adoptVersion(previewVersion.id);
              if (adopted && selectedProject && selectedSubject) {
                setSubjectContent(adopted.contentMarkdown);
                await saveSubjectContent(selectedProject.name, selectedSubject, adopted.contentMarkdown);
                // Move the "current" marker in the History dropdown right away.
                usePlannerStore.getState().markSubjectCurrentVersion(adopted.subjectId, adopted.id);
              }
            }}
          >
            {t('plans.adopt_version')}
          </Button>
        </div>
      </div>
    );
  };

  // Derived editor inputs for preview-mode content swap. While previewing,
  // Monaco shows the historical version's markdown (read-only) and our
  // onChange handler short-circuits so we never persist preview content.
  const editorValue = previewVersion ? previewVersion.contentMarkdown : subjectContent;
  const editorReadOnly = previewVersion !== null;

  const renderEditorContent = () => (
    <>
      {renderPreviewBanner()}
      <div className={`flex-1 w-full relative overflow-y-auto transition-colors duration-300 ${editorBgClass}`}>
        {!isViewing ? (
          <Editor
            height="100%" defaultLanguage="markdown" theme={editorTheme}
            beforeMount={handleEditorWillMount} onMount={handleEditorMount}
            value={editorValue} onChange={handleEditorChange}
            options={{
              minimap: { enabled: false }, wordWrap: 'on', fontSize: 13, padding: { top: 16 },
              autoSurround: 'languageDefined', autoClosingQuotes: 'languageDefined', autoClosingBrackets: 'languageDefined',
              readOnly: editorReadOnly,
            }}
            className="absolute inset-0"
          />
        ) : (
          <div className="p-4 sm:p-8 max-w-3xl mx-auto prose prose-sm dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{editorValue}</ReactMarkdown>
          </div>
        )}
      </div>
    </>
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

  // Right-side comments panel content (used by large + medium layouts).
  // Versions are now reachable via the History dropdown in the editor header,
  // so the side panel collapses to just comments. CommentsPanel early-returns
  // on `!currentSubjectId`, so no-subject states render nothing here.
  const renderCommentsPanel = () => (
    <div className="w-full h-full bg-background overflow-hidden">
      <CommentsPanel />
    </div>
  );

  // ============================
  // SMALL SCREEN
  // ============================
  if (isSmall) {
    return (
      <>
        <div className="flex flex-col h-full">
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
                  <button onClick={triggerProjectDialog} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors"><Plus size={14} /></button>
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
                <div className="flex items-center gap-1">
                  <button onClick={handleImport} disabled={!selectedProject || isImporting} title={t('planner.import_subject')} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
                    {isImporting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  </button>
                  <button onClick={triggerSubjectDialog} disabled={!selectedProject} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"><Plus size={14} /></button>
                </div>
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
        {/* @ts-expect-error shadcn type mismatch */}
        <ResizablePanelGroup direction="horizontal" className="w-full h-full rounded-none">
          <ResizablePanel
            panelRef={projectsPanelRef} defaultSize="35%" minSize="20%"
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
                  <button onClick={triggerProjectDialog} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors"><Plus size={14} /></button>
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
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button onClick={(e) => { e.stopPropagation(); setRenameValue(p.name); setRenameProjectTarget(p.name); }} className="text-muted-foreground hover:text-foreground p-0.5"><PencilLine size={12} /></button>
                          <button onClick={(e) => { e.stopPropagation(); setDeleteProjectTarget(p.name); }} className="text-muted-foreground hover:text-destructive p-0.5"><Trash2 size={12} /></button>
                          <MoveProjectToWorkspaceMenu projectName={p.name} iconSize={12} />
                        </div>
                      </div>
                    ))}
                    {projects.length === 0 && <div className="text-xs p-2 text-muted-foreground">{t('planner.no_projects')}</div>}
                  </div>
                </ScrollArea>
              </div>
              <div className="p-2 border-b border-border/50 flex items-center justify-between px-3">
                <span className="uppercase font-semibold text-xs text-muted-foreground">{t('planner.subjects')}</span>
                <div className="flex items-center gap-1">
                  <button onClick={handleImport} disabled={!selectedProject || isImporting} title={t('planner.import_subject')} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
                    {isImporting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  </button>
                  <button onClick={triggerSubjectDialog} disabled={!selectedProject} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"><Plus size={14} /></button>
                </div>
              </div>
              {renderSubjectsList((s) => setSelectedSubject(s))}
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="65%" minSize="40%" className="flex flex-col bg-background">
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
          <ResizableHandle />
          <ResizablePanel
            panelRef={versionsPanelRef}
            defaultSize="28%" minSize="15%" maxSize="45%"
            collapsible collapsedSize={0}
            onResize={(size) => setIsVersionsPanelCollapsed(size.asPercentage === 0)}
            className="bg-muted/10"
          >
            {renderCommentsPanel()}
          </ResizablePanel>
        </ResizablePanelGroup>
        {renderDialogs()}
      </>
    );
  }

  // ============================
  // LARGE SCREEN
  // ============================
  return (
    <>
      {/* @ts-expect-error shadcn type mismatch */}
      <ResizablePanelGroup direction="horizontal" className="w-full h-full rounded-none">
        <ResizablePanel
          panelRef={projectsPanelRef} defaultSize="30%" minSize="15%"
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
                <button onClick={triggerProjectDialog} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors" title={t('planner.create_project')}><Plus size={14} /></button>
                <button onClick={() => projectsPanelRef.current?.collapse()} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors" title="Collapse"><PanelLeftClose size={14} /></button>
              </div>
            </div>
            {renderProjectsList((p) => setSelectedProject(p))}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel
          panelRef={subjectsPanelRef} defaultSize="30%" minSize="15%"
          collapsible collapsedSize={0}
          onResize={(size) => setSubjectsCollapsed(size.asPercentage === 0)}
          className="bg-muted/20"
        >
          <div className="flex flex-col h-full font-semibold text-xs text-muted-foreground">
            <div className="p-3 border-b border-border/50 uppercase flex items-center justify-between">
              <span>{t('planner.subjects')}</span>
              <div className="flex items-center gap-1">
                <button onClick={handleImport} disabled={!selectedProject || isImporting} title={t('planner.import_subject')} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
                  {isImporting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                </button>
                <button onClick={triggerSubjectDialog} disabled={!selectedProject} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50" title={t('planner.create_subject')}><Plus size={14} /></button>
                <button onClick={() => subjectsPanelRef.current?.collapse()} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors" title="Collapse"><PanelLeftClose size={14} /></button>
              </div>
            </div>
            {renderSubjectsList((s) => setSelectedSubject(s))}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize="40%" minSize="25%" className="flex flex-col bg-background">
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

        <ResizableHandle />

        <ResizablePanel
          panelRef={versionsPanelRef}
          defaultSize="25%" minSize="15%" maxSize="40%"
          collapsible collapsedSize={0}
          onResize={(size) => setIsVersionsPanelCollapsed(size.asPercentage === 0)}
          className="bg-muted/10"
        >
          {renderCommentsPanel()}
        </ResizablePanel>
      </ResizablePanelGroup>
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
              <input autoFocus type="text" placeholder={t('planner.project_name_placeholder')} value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newProjectName.trim() && handleCreateProjectSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
            </div>
            <DialogFooter>
              <button onClick={handleCreateProjectSubmit} disabled={!newProjectName.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors disabled:opacity-50">{t('planner.create')}</button>
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

      </>
    );
  }
}
