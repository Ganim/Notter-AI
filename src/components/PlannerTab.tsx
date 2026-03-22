import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlannerStore } from '@/stores/planner-store';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { PanelImperativeHandle } from 'react-resizable-panels';
import {
  Plus, Trash2, Pen, Eye, PencilLine, ChevronDown, ArrowLeft, FolderOpen, PanelLeftClose, PanelLeftOpen,
  Heading1, Heading2, Heading3, Bold, Italic, Underline, List, ListOrdered, Code, Quote, Minus,
} from 'lucide-react';

type MobilePanel = 'subjects' | 'tasks' | 'editor';

function useWindowWidth() {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

export function PlannerTab() {
  const { t } = useTranslation();
  const {
    subjects, selectedSubject, tasks, selectedTask, taskContent,
    isViewing, editorBgClass, editorTheme, bgColors,
    setSelectedSubject, setSelectedTask, setTaskContent, setIsViewing, setEditorTheme,
    initFilesystem, saveTaskContent, createSubject, renameSubject, deleteSubject, createTask, renameTask, deleteTask,
  } = usePlannerStore();

  const [isSubjectDialogOpen, setIsSubjectDialogOpen] = useState(false);
  const [isTaskDialogOpen, setIsTaskDialogOpen] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [deleteSubjectTarget, setDeleteSubjectTarget] = useState<string | null>(null);
  const [deleteTaskTarget, setDeleteTaskTarget] = useState<string | null>(null);
  const [renameSubjectTarget, setRenameSubjectTarget] = useState<string | null>(null);
  const [renameTaskTarget, setRenameTaskTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const editorRef = useRef<any>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('subjects');
  const subjectsPanelRef = useRef<PanelImperativeHandle>(null);
  const tasksPanelRef = useRef<PanelImperativeHandle>(null);
  const [subjectsCollapsed, setSubjectsCollapsed] = useState(false);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);

  const windowWidth = useWindowWidth();
  const isSmall = windowWidth < 640;
  const isMedium = windowWidth >= 640 && windowWidth < 1024;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    initFilesystem();
  }, [initFilesystem]);

  // --- Editor helpers ---
  const handleEditorMount = (editor: any) => { editorRef.current = editor; };

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
      const targetLine = insertLineNumber + cursorLineOffset;
      editor.setPosition({ lineNumber: targetLine, column: 1 });
    }
    editor.focus();
  };

  const handleEditorWillMount = (monaco: any) => {
    bgColors.forEach((c) => {
      monaco.editor.defineTheme(`theme-${c.name}`, { base: c.base as any, inherit: true, rules: [], colors: { 'editor.background': c.hex } });
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    const val = value || '';
    setTaskContent(val);
    if (selectedSubject && selectedTask) saveTaskContent(selectedSubject, selectedTask, val);
  };

  // --- CRUD handlers ---
  const handleCreateSubjectSubmit = async () => {
    if (!newItemName.trim()) return;
    try { await createSubject(newItemName); setIsSubjectDialogOpen(false); setNewItemName(''); toast.success(t('planner.subject_created')); }
    catch (e: any) { toast.error(t('planner.error_create_subject', { error: e })); }
  };

  const confirmDeleteSubject = async () => {
    if (!deleteSubjectTarget) return;
    try { await deleteSubject(deleteSubjectTarget); setDeleteSubjectTarget(null); toast.success(t('planner.subject_deleted')); }
    catch (e: any) { toast.error(t('planner.error_delete_subject', { error: e })); }
  };

  const handleCreateTaskSubmit = async () => {
    if (!selectedSubject || !newItemName.trim()) return;
    try { await createTask(selectedSubject, newItemName); setIsTaskDialogOpen(false); setNewItemName(''); toast.success(t('planner.task_created')); }
    catch (e: any) { toast.error(t('planner.error_create_task', { error: e })); }
  };

  const confirmDeleteTask = async () => {
    if (!deleteTaskTarget || !selectedSubject) return;
    try { await deleteTask(selectedSubject, deleteTaskTarget); setDeleteTaskTarget(null); toast.success(t('planner.task_deleted')); }
    catch (e: any) { toast.error(t('planner.error_delete_task', { error: e })); }
  };

  const handleRenameSubjectSubmit = async () => {
    if (!renameSubjectTarget || !renameValue.trim() || renameValue === renameSubjectTarget) return;
    try { await renameSubject(renameSubjectTarget, renameValue); setRenameSubjectTarget(null); setRenameValue(''); toast.success(t('planner.subject_renamed')); }
    catch (e: any) { toast.error(t('planner.error_rename_subject', { error: e })); }
  };

  const handleRenameTaskSubmit = async () => {
    if (!renameTaskTarget || !selectedSubject || !renameValue.trim() || renameValue === renameTaskTarget.replace('.md', '')) return;
    try { await renameTask(selectedSubject, renameTaskTarget, renameValue); setRenameTaskTarget(null); setRenameValue(''); toast.success(t('planner.task_renamed')); }
    catch (e: any) { toast.error(t('planner.error_rename_task', { error: e })); }
  };

  const triggerSubjectDialog = () => { setNewItemName(''); setIsSubjectDialogOpen(true); };
  const triggerTaskDialog = () => { setNewItemName(''); setIsTaskDialogOpen(true); };

  // --- Mobile navigation ---
  const selectSubjectMobile = (s: string) => {
    setSelectedSubject(s);
    setMobilePanel('tasks');
  };
  const selectTaskMobile = (task: string) => {
    setSelectedTask(task);
    setMobilePanel('editor');
  };
  const goBackToSubjects = () => {
    setMobilePanel('subjects');
    setSelectedSubject(null);
  };
  const goBackToTasks = () => {
    setMobilePanel('tasks');
    setSelectedTask(null);
  };

  // --- Shared UI pieces ---
  const tbBtn = 'p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors';

  const renderSubjectsList = (onSelect: (s: string) => void) => (
    <ScrollArea className="flex-1">
      <div className="p-2 space-y-1">
        {subjects.map((s) => (
          <div key={s} onClick={() => onSelect(s)} className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedSubject === s ? 'bg-accent text-accent-foreground' : 'hover:bg-muted font-normal'}`}>
            <span className="truncate">{s}</span>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <button onClick={(e) => { e.stopPropagation(); setRenameValue(s); setRenameSubjectTarget(s); }} className="text-muted-foreground hover:text-foreground"><PencilLine size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); setDeleteSubjectTarget(s); }} className="text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
        {subjects.length === 0 && <div className="text-xs p-2 normal-case text-muted-foreground">{t('planner.no_subjects')}</div>}
      </div>
    </ScrollArea>
  );

  const renderTasksList = (onSelect: (t: string) => void) => (
    <ScrollArea className="flex-1">
      <div className="p-2 space-y-2">
        {tasks.map((task) => (
          <div key={task} onClick={() => onSelect(task)} className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedTask === task ? 'bg-accent text-accent-foreground' : 'hover:bg-muted text-foreground'}`}>
            <div className="flex items-center space-x-2 truncate">
              <input type="checkbox" className="rounded border-gray-400 bg-transparent pointer-events-none" />
              <span className="truncate font-normal">{task.replace('.md', '')}</span>
            </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <button onClick={(e) => { e.stopPropagation(); setRenameValue(task.replace('.md', '')); setRenameTaskTarget(task); }} className="text-muted-foreground hover:text-foreground"><PencilLine size={14} /></button>
              <button onClick={(e) => { e.stopPropagation(); setDeleteTaskTarget(task); }} className="text-muted-foreground hover:text-destructive"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
        {tasks.length === 0 && selectedSubject && <div className="text-xs p-2 normal-case font-normal text-muted-foreground">{t('planner.create_first_task')}</div>}
        {!selectedSubject && <div className="text-xs p-2 normal-case font-normal text-muted-foreground">{t('planner.select_subject')}</div>}
      </div>
    </ScrollArea>
  );

  const renderColorPicker = () => (
    <>
      <div className="hidden xl:flex bg-muted rounded-md p-1 border border-border">
        {bgColors.map((c) => (
          <button key={c.name} title={c.name} onClick={() => setEditorTheme(c)} className={`w-4 h-4 rounded-full mx-1 border cursor-pointer hover:scale-110 transition-transform ${c.value.split(' ')[0]} ${editorBgClass === c.value ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'border-border'}`} />
        ))}
      </div>
      <div ref={colorPickerRef} className="relative xl:hidden">
        <button onClick={() => setColorPickerOpen(!colorPickerOpen)} className="flex items-center gap-1.5 bg-muted rounded-md px-2 py-1 border border-border hover:bg-muted/80 transition-colors">
          <div className={`w-4 h-4 rounded-full border ${bgColors.find((c) => c.value === editorBgClass)?.value.split(' ')[0] || ''} ${editorBgClass === 'bg-background' ? 'border-foreground/30' : 'border-border'}`} />
          <ChevronDown size={12} className="text-muted-foreground" />
        </button>
        {colorPickerOpen && (
          <div className="absolute right-0 top-full mt-1 bg-popover border border-border rounded-md shadow-lg z-50 p-2 flex flex-col gap-1">
            {bgColors.map((c) => (
              <button key={c.name} onClick={() => { setEditorTheme(c); setColorPickerOpen(false); }} className={`flex items-center gap-2 px-2 py-1 rounded-sm text-xs hover:bg-muted transition-colors whitespace-nowrap ${editorBgClass === c.value ? 'bg-muted font-medium' : ''}`}>
                <div className={`w-3.5 h-3.5 rounded-full border ${c.value.split(' ')[0]} ${c.value === 'bg-background' ? 'border-foreground/30' : 'border-border'}`} />
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
      {/* Back button on small/medium */}
      {(isSmall || isMedium) && (
        <button onClick={isSmall ? goBackToTasks : () => {}} className={`shrink-0 p-1 rounded-sm hover:bg-muted transition-colors ${isSmall ? '' : 'hidden'}`}>
          <ArrowLeft size={16} />
        </button>
      )}
      <span className="font-semibold text-xs sm:text-sm text-foreground truncate min-w-0">
        {t('planner.notes_about')} <span className="text-primary">{selectedTask?.replace('.md', '')}</span>
      </span>
      <div className="flex items-center gap-2 sm:gap-4 shrink-0">
        {renderColorPicker()}
        <div className="flex bg-muted rounded-md p-0.5 sm:p-1">
          <button onClick={() => setIsViewing(false)} className={`flex items-center gap-1 px-2 sm:px-3 py-1 rounded-sm text-xs font-medium transition-colors ${!isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            <Pen size={12} /><span className="hidden sm:inline">{t('planner.edit')}</span>
          </button>
          <button onClick={() => setIsViewing(true)} className={`flex items-center gap-1 px-2 sm:px-3 py-1 rounded-sm text-xs font-medium transition-colors ${isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            <Eye size={12} /><span className="hidden sm:inline">{t('planner.view')}</span>
          </button>
        </div>
      </div>
    </div>
  );

  const renderEditorContent = () => (
    <div className={`flex-1 w-full relative overflow-y-auto transition-colors duration-300 ${editorBgClass}`}>
      {!isViewing ? (
        <Editor
          height="100%" defaultLanguage="markdown" theme={editorTheme}
          beforeMount={handleEditorWillMount} onMount={handleEditorMount}
          value={taskContent} onChange={handleEditorChange}
          options={{ minimap: { enabled: false }, wordWrap: 'on', fontSize: 13, padding: { top: 16 } }}
          className="absolute inset-0"
        />
      ) : (
        <div className="p-4 sm:p-8 max-w-3xl mx-auto prose prose-sm dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{taskContent}</ReactMarkdown>
        </div>
      )}
    </div>
  );

  const renderEditorPanel = () => (
    selectedTask ? (
      <div className="flex flex-col h-full">
        {renderEditorHeader()}
        {!isViewing && renderToolbar()}
        {renderEditorContent()}
      </div>
    ) : (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4 text-center">
        {t('planner.select_task_hint')}
      </div>
    )
  );

  // ============================
  // SMALL SCREEN: single panel drill-down
  // ============================
  if (isSmall) {
    return (
      <>
        <div className="flex flex-col h-full">
          {mobilePanel === 'subjects' && (
            <>
              <div className="h-10 border-b border-border/50 flex items-center justify-between px-3 bg-muted/50 shrink-0">
                <span className="uppercase font-semibold text-xs text-muted-foreground">{t('planner.subjects')}</span>
                <button onClick={triggerSubjectDialog} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors"><Plus size={14} /></button>
              </div>
              {renderSubjectsList(selectSubjectMobile)}
            </>
          )}

          {mobilePanel === 'tasks' && (
            <>
              <div className="h-10 border-b border-border/50 flex items-center justify-between px-3 bg-muted/50 shrink-0">
                <div className="flex items-center gap-2">
                  <button onClick={goBackToSubjects} className="p-1 rounded-sm hover:bg-muted transition-colors"><ArrowLeft size={14} /></button>
                  <span className="font-semibold text-xs text-foreground truncate">{selectedSubject}</span>
                </div>
                <button onClick={triggerTaskDialog} disabled={!selectedSubject} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"><Plus size={14} /></button>
              </div>
              {renderTasksList(selectTaskMobile)}
            </>
          )}

          {mobilePanel === 'editor' && (
            <>
              <div className="h-10 border-b border-border/50 flex items-center px-3 bg-muted/50 shrink-0 gap-2">
                <button onClick={goBackToTasks} className="p-1 rounded-sm hover:bg-muted transition-colors shrink-0"><ArrowLeft size={14} /></button>
                <span className="font-semibold text-xs text-foreground truncate">{selectedSubject} / {selectedTask?.replace('.md', '')}</span>
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
  // MEDIUM SCREEN: 2 columns (combined sidebar + editor)
  // ============================
  if (isMedium) {
    return (
      <>
        {/* @ts-expect-error shadcn type mismatch */}
        <ResizablePanelGroup direction="horizontal" className="w-full h-full rounded-none">
          <ResizablePanel
            panelRef={subjectsPanelRef}
            defaultSize={35} minSize={20}
            collapsible collapsedSize={0}
            onResize={(size) => setSubjectsCollapsed(size.asPercentage === 0)}
            className="bg-muted/50"
          >
            <div className="flex flex-col h-full">
              {/* Subjects header */}
              <div className="p-2 border-b border-border/50 flex items-center justify-between px-3">
                <span className="uppercase font-semibold text-xs text-muted-foreground">{t('planner.subjects')}</span>
                <div className="flex items-center gap-1">
                  <button onClick={triggerSubjectDialog} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors"><Plus size={14} /></button>
                  <button onClick={() => subjectsPanelRef.current?.collapse()} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors"><PanelLeftClose size={14} /></button>
                </div>
              </div>
              {/* Subjects as compact horizontal pills or short list */}
              <div className="border-b border-border/50">
                <ScrollArea className="max-h-[120px]">
                  <div className="p-1.5 space-y-0.5">
                    {subjects.map((s) => (
                      <div key={s} onClick={() => setSelectedSubject(s)} className={`group flex items-center justify-between px-2 py-1.5 text-xs rounded cursor-pointer ${selectedSubject === s ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-muted text-foreground'}`}>
                        <div className="flex items-center gap-1.5 truncate">
                          <FolderOpen size={12} className="shrink-0 opacity-50" />
                          <span className="truncate">{s}</span>
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button onClick={(e) => { e.stopPropagation(); setRenameValue(s); setRenameSubjectTarget(s); }} className="text-muted-foreground hover:text-foreground p-0.5"><PencilLine size={12} /></button>
                          <button onClick={(e) => { e.stopPropagation(); setDeleteSubjectTarget(s); }} className="text-muted-foreground hover:text-destructive p-0.5"><Trash2 size={12} /></button>
                        </div>
                      </div>
                    ))}
                    {subjects.length === 0 && <div className="text-xs p-2 text-muted-foreground">{t('planner.no_subjects')}</div>}
                  </div>
                </ScrollArea>
              </div>
              {/* Tasks */}
              <div className="p-2 border-b border-border/50 flex items-center justify-between px-3">
                <span className="uppercase font-semibold text-xs text-muted-foreground">{t('planner.tasks')}</span>
                <button onClick={triggerTaskDialog} disabled={!selectedSubject} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"><Plus size={14} /></button>
              </div>
              {renderTasksList((task) => setSelectedTask(task))}
            </div>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize={65} minSize={40} className="flex flex-col bg-background">
            {subjectsCollapsed && (
              <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/30 shrink-0">
                <button onClick={() => subjectsPanelRef.current?.expand()} className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <PanelLeftOpen size={14} />
                  <span>{t('planner.subjects')} / {t('planner.tasks')}</span>
                </button>
              </div>
            )}
            {renderEditorPanel()}
          </ResizablePanel>
        </ResizablePanelGroup>
        {renderDialogs()}
      </>
    );
  }

  // ============================
  // LARGE SCREEN: 3 resizable panels (collapsible sidebars)
  // ============================
  return (
    <>
      {/* @ts-expect-error shadcn type mismatch */}
      <ResizablePanelGroup direction="horizontal" className="w-full h-full rounded-none">
        <ResizablePanel
          panelRef={subjectsPanelRef}
          defaultSize={20} minSize={10}
          collapsible collapsedSize={0}
          onResize={(size) => setSubjectsCollapsed(size.asPercentage === 0)}
          className="bg-muted/50"
        >
          <div className="flex flex-col h-full uppercase font-semibold text-xs text-muted-foreground">
            <div className="p-3 border-b border-border/50 flex items-center justify-between">
              <span>{t('planner.subjects')}</span>
              <div className="flex items-center gap-1">
                <button onClick={triggerSubjectDialog} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors" title={t('planner.create_subject')}><Plus size={14} /></button>
                <button onClick={() => subjectsPanelRef.current?.collapse()} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors" title="Collapse"><PanelLeftClose size={14} /></button>
              </div>
            </div>
            {renderSubjectsList((s) => setSelectedSubject(s))}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel
          panelRef={tasksPanelRef}
          defaultSize={25} minSize={10}
          collapsible collapsedSize={0}
          onResize={(size) => setTasksCollapsed(size.asPercentage === 0)}
          className="bg-muted/20"
        >
          <div className="flex flex-col h-full font-semibold text-xs text-muted-foreground">
            <div className="p-3 border-b border-border/50 uppercase flex items-center justify-between">
              <span>{t('planner.tasks')}</span>
              <div className="flex items-center gap-1">
                <button onClick={triggerTaskDialog} disabled={!selectedSubject} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50" title={t('planner.create_task')}><Plus size={14} /></button>
                <button onClick={() => tasksPanelRef.current?.collapse()} className="hover:bg-muted p-1 rounded-sm text-muted-foreground hover:text-foreground transition-colors" title="Collapse"><PanelLeftClose size={14} /></button>
              </div>
            </div>
            {renderTasksList((task) => setSelectedTask(task))}
          </div>
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize={55} minSize={30} className="flex flex-col bg-background">
          {/* Expand buttons when panels are collapsed */}
          {(subjectsCollapsed || tasksCollapsed) && (
            <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-muted/30 shrink-0">
              {subjectsCollapsed && (
                <button onClick={() => subjectsPanelRef.current?.expand()} className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <PanelLeftOpen size={14} />
                  <span>{t('planner.subjects')}</span>
                </button>
              )}
              {tasksCollapsed && (
                <button onClick={() => tasksPanelRef.current?.expand()} className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <PanelLeftOpen size={14} />
                  <span>{t('planner.tasks')}</span>
                </button>
              )}
            </div>
          )}
          {renderEditorPanel()}
        </ResizablePanel>
      </ResizablePanelGroup>
      {renderDialogs()}
    </>
  );

  // --- Dialogs (shared across all layouts) ---
  function renderDialogs() {
    return (
      <>
        <Dialog open={!!renameSubjectTarget} onOpenChange={(open) => { if (!open) setRenameSubjectTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.rename_subject')}</DialogTitle>
              <DialogDescription>{t('planner.rename_subject_desc', { name: renameSubjectTarget })}</DialogDescription>
            </DialogHeader>
            <input autoFocus type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleRenameSubjectSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
            <DialogFooter>
              <button onClick={() => setRenameSubjectTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('planner.cancel')}</button>
              <button onClick={handleRenameSubjectSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.rename')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!renameTaskTarget} onOpenChange={(open) => { if (!open) setRenameTaskTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.rename_task')}</DialogTitle>
              <DialogDescription>{t('planner.rename_task_desc', { name: renameTaskTarget?.replace('.md', '') })}</DialogDescription>
            </DialogHeader>
            <input autoFocus type="text" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleRenameTaskSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
            <DialogFooter>
              <button onClick={() => setRenameTaskTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('planner.cancel')}</button>
              <button onClick={handleRenameTaskSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.rename')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={isSubjectDialogOpen} onOpenChange={setIsSubjectDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.new_subject')}</DialogTitle>
              <DialogDescription>{t('planner.new_subject_desc')}</DialogDescription>
            </DialogHeader>
            <input autoFocus type="text" placeholder={t('planner.subject_placeholder')} value={newItemName} onChange={(e) => setNewItemName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateSubjectSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
            <DialogFooter>
              <button onClick={handleCreateSubjectSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.create')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={isTaskDialogOpen} onOpenChange={setIsTaskDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.new_task_in', { subject: selectedSubject })}</DialogTitle>
              <DialogDescription>{t('planner.new_task_desc')}</DialogDescription>
            </DialogHeader>
            <input autoFocus type="text" placeholder={t('planner.task_placeholder')} value={newItemName} onChange={(e) => setNewItemName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreateTaskSubmit()} className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring" />
            <DialogFooter>
              <button onClick={handleCreateTaskSubmit} className="bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.create')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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

        <Dialog open={!!deleteTaskTarget} onOpenChange={(open) => !open && setDeleteTaskTarget(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('planner.delete_task')}</DialogTitle>
              <DialogDescription>{t('planner.delete_task_desc', { name: deleteTaskTarget })}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button onClick={() => setDeleteTaskTarget(null)} className="px-4 py-2 rounded-md font-medium text-sm hover:bg-muted transition-colors">{t('planner.cancel')}</button>
              <button onClick={confirmDeleteTask} className="bg-rose-500 hover:bg-rose-600 text-white px-4 py-2 rounded-md font-medium text-sm transition-colors">{t('planner.delete')}</button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }
}
