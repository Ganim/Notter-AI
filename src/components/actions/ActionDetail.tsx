import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Play, FileText, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useActionsStore } from '@/stores/actions-store';
import { useTerminalsStore } from '@/stores/terminals-store';
import type { ActionStatus } from '@/types/actions';
import { TaskItem } from './TaskItem';

const STATUS_OPTIONS: ActionStatus[] = ['waiting', 'processing', 'skipped', 'done'];

export function ActionDetail() {
  const { t } = useTranslation();
  const actions = useActionsStore((s) => s.actions);
  const selectedId = useActionsStore((s) => s.selectedActionId);
  const updateAction = useActionsStore((s) => s.updateAction);
  const deleteAction = useActionsStore((s) => s.deleteAction);
  const updateTask = useActionsStore((s) => s.updateTask);
  const consoles = useTerminalsStore((s) => s.consoles);
  const addConsole = useTerminalsStore((s) => s.addConsole);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [originalOpen, setOriginalOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [defaultTerminal, setDefaultTerminal] = useState<string>('');

  const selected = useMemo(
    () => actions.find((a) => a.id === selectedId) ?? null,
    [actions, selectedId],
  );

  if (!selected) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t('actions.select_hint')}
      </div>
    );
  }

  function handleTitleSave() {
    if (!selected) return;
    if (titleDraft.trim() && titleDraft.trim() !== selected.title) {
      updateAction(selected.id, { title: titleDraft.trim() });
    }
    setEditingTitle(false);
  }

  function handleDelete() {
    if (!selected) return;
    deleteAction(selected.id);
    setDeleteOpen(false);
  }

  function normalizeForPty(text: string): string {
    const normalized = text.replace(/\r?\n/g, '\r');
    return normalized.endsWith('\r') ? normalized : normalized + '\r';
  }

  async function handleProcessAll() {
    if (!selected) return;
    let terminalId = defaultTerminal;
    if (!terminalId) {
      // Auto-spawn a new terminal for this action's project if none picked
      const newId = addConsole(selected.title || selected.projectName, selected.projectName);
      if (!newId) {
        toast.error('Could not create terminal (max 4 reached). Pick one manually.');
        return;
      }
      terminalId = newId;
      setDefaultTerminal(newId);
      // Give the TerminalView a moment to mount and create the PTY
      await new Promise((r) => setTimeout(r, 1500));
    }

    const pendingTasks = selected.tasks.filter((t) => t.status === 'waiting');
    if (pendingTasks.length === 0) {
      toast.info('No waiting tasks to process');
      return;
    }

    setIsProcessing(true);
    await updateAction(selected.id, { status: 'processing' });
    let success = 0;
    let failed = 0;

    for (const task of pendingTasks) {
      try {
        const data = normalizeForPty(task.prompt);
        await invoke('write_pty', { id: terminalId, data });
        await updateTask(selected.id, task.id, {
          terminalId,
          status: 'running',
        });
        success++;
        // Small delay between commands to let the previous one start
        await new Promise((r) => setTimeout(r, 600));
      } catch (err) {
        failed++;
        console.error('[ActionDetail] write_pty failed for task', task.id, err);
      }
    }

    setIsProcessing(false);
    if (failed === 0) {
      toast.success(`Injected ${success} task${success === 1 ? '' : 's'} into terminal`);
    } else {
      toast.warning(`Injected ${success}, failed ${failed}. See console for details.`);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-border px-4 py-3 space-y-2">
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleTitleSave();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
            className="w-full bg-transparent text-lg font-semibold outline-none border-b border-primary"
          />
        ) : (
          <h2
            className="text-lg font-semibold cursor-pointer hover:text-primary transition-colors"
            onDoubleClick={() => {
              setTitleDraft(selected.title);
              setEditingTitle(true);
            }}
          >
            {selected.title || '(untitled)'}
          </h2>
        )}

        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <select
            value={selected.status}
            onChange={(e) => updateAction(selected.id, { status: e.target.value as ActionStatus })}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {t(`actions.status_${s}`)}
              </option>
            ))}
          </select>
          <span>
            {selected.projectName}
            {selected.subjectName && ` / ${selected.subjectName}`}
          </span>
          <div className="flex-1" />
          <select
            value={defaultTerminal}
            onChange={(e) => setDefaultTerminal(e.target.value)}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
            title="Default terminal for batch processing"
          >
            <option value="">{consoles.length === 0 ? '+ new terminal' : '— select terminal —'}</option>
            {consoles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleProcessAll}
            disabled={isProcessing || selected.tasks.filter((tt) => tt.status === 'waiting').length === 0}
            title="Run all waiting tasks sequentially in the selected terminal"
            className="flex items-center gap-1.5 h-7 rounded-md bg-emerald-500 px-2.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isProcessing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} fill="currentColor" />}
            {t('actions.process')}
          </button>
          <button
            onClick={() => setOriginalOpen(true)}
            disabled={!selected.originalMarkdown}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-40"
            title="View original Planner note"
          >
            <FileText size={14} />
          </button>
          <button
            onClick={() => setDeleteOpen(true)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title={t('actions.delete')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Body */}
      <ScrollArea className="flex-1 px-4 py-3 space-y-6">
        {/* Context */}
        <section className="space-y-2 mb-6">
          <h3 className="text-sm font-semibold">{t('actions.context')}</h3>
          {selected.summary ? (
            <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.summary}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">{t('actions.no_context')}</p>
          )}
        </section>

        {/* Tasks */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            {t('actions.tasks')} ({selected.tasks.length})
          </h3>
          {selected.tasks.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">—</p>
          ) : (
            <div className="space-y-2">
              {selected.tasks.map((task) => (
                <TaskItem key={task.id} actionId={selected.id} task={task} />
              ))}
            </div>
          )}
        </section>
      </ScrollArea>

      {/* Original Planner Note dialog */}
      <Dialog open={originalOpen} onOpenChange={setOriginalOpen}>
        <DialogContent className="sm:max-w-3xl max-w-[calc(100%-2rem)]">
          <DialogHeader>
            <DialogTitle>Original Planner note</DialogTitle>
            <DialogDescription>
              Snapshot of {selected.subjectName || selected.projectName} when this Action was processed.
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[60vh]">
            <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted/30 p-3 rounded-md">
              {selected.originalMarkdown || '(no snapshot)'}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('actions.delete')}</DialogTitle>
            <DialogDescription>
              {t('actions.delete_confirm', { title: selected.title })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setDeleteOpen(false)}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              {t('actions.cancel')}
            </button>
            <button
              onClick={handleDelete}
              className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
            >
              {t('actions.delete')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
