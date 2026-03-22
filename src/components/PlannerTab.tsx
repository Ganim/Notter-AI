import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlannerStore } from '@/stores/planner-store';
import { useAgentsStore } from '@/stores/agents-store';
import { useAppStore } from '@/stores/app-store';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import Editor from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Plus, Trash2, Pen, Eye, Play, PencilLine } from 'lucide-react';

export function PlannerTab() {
  const { t } = useTranslation();
  const {
    subjects, selectedSubject, tasks, selectedTask, taskContent,
    isViewing, editorBgClass, editorTheme, bgColors,
    setSelectedSubject, setSelectedTask, setTaskContent, setIsViewing, setEditorTheme,
    initFilesystem, saveTaskContent, createSubject, renameSubject, deleteSubject, createTask, renameTask, deleteTask,
  } = usePlannerStore();

  const { profiles } = useAgentsStore();
  const { setActiveTab } = useAppStore();

  const [isSubjectDialogOpen, setIsSubjectDialogOpen] = useState(false);
  const [isTaskDialogOpen, setIsTaskDialogOpen] = useState(false);
  const [isAgentTriggerOpen, setIsAgentTriggerOpen] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [deleteSubjectTarget, setDeleteSubjectTarget] = useState<string | null>(null);
  const [deleteTaskTarget, setDeleteTaskTarget] = useState<string | null>(null);
  const [renameSubjectTarget, setRenameSubjectTarget] = useState<string | null>(null);
  const [renameTaskTarget, setRenameTaskTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    initFilesystem();
  }, [initFilesystem]);

  const handleEditorWillMount = (monaco: any) => {
    bgColors.forEach((c) => {
      monaco.editor.defineTheme(`theme-${c.name}`, {
        base: c.base as any,
        inherit: true,
        rules: [],
        colors: { 'editor.background': c.hex },
      });
    });
  };

  const handleEditorChange = (value: string | undefined) => {
    const val = value || '';
    setTaskContent(val);
    if (selectedSubject && selectedTask) {
      saveTaskContent(selectedSubject, selectedTask, val);
    }
  };

  const handleCreateSubjectSubmit = async () => {
    if (!newItemName.trim()) return;
    try {
      await createSubject(newItemName);
      setIsSubjectDialogOpen(false);
      setNewItemName('');
      toast.success(t('planner.subject_created'));
    } catch (e: any) {
      toast.error(t('planner.error_create_subject', { error: e }));
    }
  };

  const confirmDeleteSubject = async () => {
    if (!deleteSubjectTarget) return;
    try {
      await deleteSubject(deleteSubjectTarget);
      setDeleteSubjectTarget(null);
      toast.success(t('planner.subject_deleted'));
    } catch (e: any) {
      toast.error(t('planner.error_delete_subject', { error: e }));
    }
  };

  const handleCreateTaskSubmit = async () => {
    if (!selectedSubject || !newItemName.trim()) return;
    try {
      await createTask(selectedSubject, newItemName);
      setIsTaskDialogOpen(false);
      setNewItemName('');
      toast.success(t('planner.task_created'));
    } catch (e: any) {
      toast.error(t('planner.error_create_task', { error: e }));
    }
  };

  const confirmDeleteTask = async () => {
    if (!deleteTaskTarget || !selectedSubject) return;
    try {
      await deleteTask(selectedSubject, deleteTaskTarget);
      setDeleteTaskTarget(null);
      toast.success(t('planner.task_deleted'));
    } catch (e: any) {
      toast.error(t('planner.error_delete_task', { error: e }));
    }
  };

  const handleRenameSubjectSubmit = async () => {
    if (!renameSubjectTarget || !renameValue.trim() || renameValue === renameSubjectTarget) return;
    try {
      await renameSubject(renameSubjectTarget, renameValue);
      setRenameSubjectTarget(null);
      setRenameValue('');
      toast.success(t('planner.subject_renamed'));
    } catch (e: any) {
      toast.error(t('planner.error_rename_subject', { error: e }));
    }
  };

  const handleRenameTaskSubmit = async () => {
    if (!renameTaskTarget || !selectedSubject || !renameValue.trim() || renameValue === renameTaskTarget.replace('.md', '')) return;
    try {
      await renameTask(selectedSubject, renameTaskTarget, renameValue);
      setRenameTaskTarget(null);
      setRenameValue('');
      toast.success(t('planner.task_renamed'));
    } catch (e: any) {
      toast.error(t('planner.error_rename_task', { error: e }));
    }
  };

  const triggerSubjectDialog = () => { setNewItemName(''); setIsSubjectDialogOpen(true); };
  const triggerTaskDialog = () => { setNewItemName(''); setIsTaskDialogOpen(true); };

  return (
    <>
      {/* @ts-expect-error shadcn type mismatch */}
      <ResizablePanelGroup direction="horizontal" className="w-full h-full rounded-none">
        {/* Subjects Panel */}
        <ResizablePanel defaultSize={20} minSize={15} className="bg-muted/50">
          <div className="flex flex-col h-full uppercase font-semibold text-xs text-muted-foreground">
            <div className="p-3 border-b border-border/50 flex items-center justify-between">
              <span>{t('planner.subjects')}</span>
              <button onClick={triggerSubjectDialog} className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors" title={t('planner.create_subject')}>
                <Plus size={14} />
              </button>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-1">
                {subjects.map((s) => (
                  <div
                    key={s}
                    onClick={() => setSelectedSubject(s)}
                    className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedSubject === s ? 'bg-accent text-accent-foreground' : 'hover:bg-muted font-normal'}`}
                  >
                    <span className="truncate">{s}</span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); setRenameValue(s); setRenameSubjectTarget(s); }} className="text-muted-foreground hover:text-foreground">
                        <PencilLine size={14} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setDeleteSubjectTarget(s); }} className="text-muted-foreground hover:text-destructive">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                {subjects.length === 0 && <div className="text-xs p-2 normal-case text-muted-foreground">{t('planner.no_subjects')}</div>}
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Tasks Panel */}
        <ResizablePanel defaultSize={25} minSize={20} className="bg-muted/20">
          <div className="flex flex-col h-full font-semibold text-xs text-muted-foreground">
            <div className="p-3 border-b border-border/50 uppercase flex items-center justify-between">
              <span>{t('planner.tasks')}</span>
              <button
                onClick={triggerTaskDialog}
                disabled={!selectedSubject}
                className="hover:bg-muted p-1 rounded-sm text-foreground transition-colors disabled:opacity-50"
                title={t('planner.create_task')}
              >
                <Plus size={14} />
              </button>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2 space-y-2">
                {tasks.map((task) => (
                  <div
                    key={task}
                    onClick={() => setSelectedTask(task)}
                    className={`group flex items-center justify-between p-2 text-sm rounded-md cursor-pointer ${selectedTask === task ? 'bg-accent text-accent-foreground' : 'hover:bg-muted text-foreground'}`}
                  >
                    <div className="flex items-center space-x-2 truncate">
                      <input type="checkbox" className="rounded border-gray-400 bg-transparent pointer-events-none" />
                      <span className="truncate font-normal">{task.replace('.md', '')}</span>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); setRenameValue(task.replace('.md', '')); setRenameTaskTarget(task); }} className="text-muted-foreground hover:text-foreground">
                        <PencilLine size={14} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setDeleteTaskTarget(task); }} className="text-muted-foreground hover:text-destructive">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
                {tasks.length === 0 && selectedSubject && <div className="text-xs p-2 normal-case font-normal text-muted-foreground">{t('planner.create_first_task')}</div>}
                {!selectedSubject && <div className="text-xs p-2 normal-case font-normal text-muted-foreground">{t('planner.select_subject')}</div>}
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle />

        {/* Editor Panel */}
        <ResizablePanel defaultSize={55} className="flex flex-col bg-background">
          {selectedTask ? (
            <>
              <div className="h-12 border-b border-border flex items-center justify-between px-4 sticky top-0 bg-background z-10 shrink-0">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-sm text-foreground">
                    {t('planner.notes_about')} <span className="text-primary">{selectedTask.replace('.md', '')}</span>
                  </span>
                  <button onClick={() => setIsAgentTriggerOpen(true)} className="bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 px-3 py-1 rounded-[4px] font-semibold text-[11px] flex items-center transition-colors ml-2 uppercase tracking-wider shadow-sm focus:ring-1 focus:ring-primary focus:outline-none">
                    <Play size={12} className="mr-1.5" /> {t('planner.delegate_agent')}
                  </button>
                </div>
                <div className="flex items-center space-x-4">
                  <div className="flex bg-muted rounded-md p-1 border border-border">
                    {bgColors.map((c) => (
                      <button
                        key={c.name}
                        title={c.name}
                        onClick={() => setEditorTheme(c)}
                        className={`w-4 h-4 rounded-full mx-1 border cursor-pointer hover:scale-110 transition-transform ${c.value.split(' ')[0]} ${editorBgClass === c.value ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : 'border-border'}`}
                      />
                    ))}
                  </div>
                  <div className="flex bg-muted rounded-md p-1">
                    <button
                      onClick={() => setIsViewing(false)}
                      className={`flex items-center space-x-1 px-3 py-1 rounded-sm text-xs font-medium transition-colors ${!isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      <Pen size={12} /><span>{t('planner.edit')}</span>
                    </button>
                    <button
                      onClick={() => setIsViewing(true)}
                      className={`flex items-center space-x-1 px-3 py-1 rounded-sm text-xs font-medium transition-colors ${isViewing ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    >
                      <Eye size={12} /><span>{t('planner.view')}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className={`flex-1 w-full relative overflow-y-auto transition-colors duration-300 ${editorBgClass}`}>
                {!isViewing ? (
                  <Editor
                    height="100%"
                    defaultLanguage="markdown"
                    theme={editorTheme}
                    beforeMount={handleEditorWillMount}
                    value={taskContent}
                    onChange={handleEditorChange}
                    options={{ minimap: { enabled: false }, wordWrap: 'on', fontSize: 13, padding: { top: 16 } }}
                    className="absolute inset-0"
                  />
                ) : (
                  <div className="p-8 max-w-3xl mx-auto prose prose-sm dark:prose-invert">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {taskContent}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              {t('planner.select_task_hint')}
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* Dialogs */}
      <Dialog open={!!renameSubjectTarget} onOpenChange={(open) => { if (!open) setRenameSubjectTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('planner.rename_subject')}</DialogTitle>
            <DialogDescription>{t('planner.rename_subject_desc', { name: renameSubjectTarget })}</DialogDescription>
          </DialogHeader>
          <input
            autoFocus type="text" value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRenameSubjectSubmit()}
            className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
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
          <input
            autoFocus type="text" value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRenameTaskSubmit()}
            className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
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
          <input
            autoFocus type="text" placeholder={t('planner.subject_placeholder')}
            value={newItemName} onChange={(e) => setNewItemName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateSubjectSubmit()}
            className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
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
          <input
            autoFocus type="text" placeholder={t('planner.task_placeholder')}
            value={newItemName} onChange={(e) => setNewItemName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateTaskSubmit()}
            className="w-full bg-background border border-input rounded-md p-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
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

      <Dialog open={isAgentTriggerOpen} onOpenChange={setIsAgentTriggerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('delegate.title')}</DialogTitle>
            <DialogDescription>{t('delegate.desc')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 mt-2 max-h-[300px] overflow-y-auto pr-2">
            {profiles.length === 0 ? (
              <div className="p-4 text-center text-sm text-muted-foreground bg-muted/30 rounded-md border border-border/50">
                {t('delegate.no_profiles')}
              </div>
            ) : (
              profiles.map((p) => (
                <div
                  key={p.id}
                  onClick={() => {
                    setIsAgentTriggerOpen(false);
                    setActiveTab('terminals');
                    toast.success(t('delegate.dispatched', { name: p.name }));
                    // TODO: Alpha 3.0 — restore triggerAgentLoop with terminal write feedback.
                    // The original App.tsx wrote ANSI-colored status lines to the terminal.
                    // This will be reimplemented when the agent pipeline is built.
                  }}
                  className="p-3 border border-border/80 rounded-md cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-all flex items-center justify-between group"
                >
                  <div className="flex flex-col gap-1">
                    <p className="font-semibold text-sm group-hover:text-primary transition-colors">{p.name}</p>
                    <p className="text-[11px] text-muted-foreground font-mono flex gap-2">
                      <span>{p.provider.toUpperCase()}</span>
                      <span>|</span>
                      <span>{p.autonomous ? t('agents.autonomous_mode') : 'Manual'}</span>
                    </p>
                  </div>
                  <button className="bg-background border shadow-sm p-2 rounded-full text-foreground group-hover:bg-primary group-hover:text-primary-foreground group-hover:border-primary transition-all">
                    <Play size={14} className="ml-0.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
