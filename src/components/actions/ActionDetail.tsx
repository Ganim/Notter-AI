import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, Play } from 'lucide-react';
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
import type { ActionStatus } from '@/types/actions';
import { TaskItem } from './TaskItem';

const STATUS_OPTIONS: ActionStatus[] = ['waiting', 'processing', 'skipped', 'done'];

export function ActionDetail() {
  const { t } = useTranslation();
  const actions = useActionsStore((s) => s.actions);
  const selectedId = useActionsStore((s) => s.selectedActionId);
  const updateAction = useActionsStore((s) => s.updateAction);
  const deleteAction = useActionsStore((s) => s.deleteAction);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

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
          <button
            disabled
            title={t('actions.process_disabled_tooltip')}
            className="flex items-center gap-1.5 h-7 rounded-md bg-primary/40 px-2.5 text-xs font-medium text-primary-foreground cursor-not-allowed"
          >
            <Play size={12} /> {t('actions.process')}
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
