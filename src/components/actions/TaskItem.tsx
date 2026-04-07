import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ActionTask, ActionTaskStatus } from '@/types/actions';
import { useActionsStore } from '@/stores/actions-store';

interface TaskItemProps {
  actionId: string;
  task: ActionTask;
}

function statusDotClass(s: ActionTaskStatus): string {
  switch (s) {
    case 'waiting':
      return 'w-2.5 h-2.5 rounded-full border-2 border-gray-400 bg-transparent';
    case 'running':
      return 'w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse';
    case 'done':
      return 'w-2.5 h-2.5 rounded-full bg-green-500';
    case 'failed':
      return 'w-2.5 h-2.5 rounded-full bg-red-500';
  }
}

export function TaskItem({ actionId, task }: TaskItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const cycleTaskStatus = useActionsStore((s) => s.cycleTaskStatus);

  function handleStatusClick(e: React.MouseEvent) {
    e.stopPropagation();
    cycleTaskStatus(actionId, task.id);
  }

  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <button
          onClick={handleStatusClick}
          className={`shrink-0 ${statusDotClass(task.status)}`}
          title={t(`actions.task_status_${task.status}`)}
        />
        <span className="flex-1 text-sm truncate">{task.objective || '(no objective)'}</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t(`actions.task_status_${task.status}`)}
        </span>
      </button>

      {expanded && (
        <div className="px-3 py-2 border-t border-border space-y-2 bg-muted/20">
          <Field label={t('actions.task_prompt')} value={task.prompt} mono />
          <div className="grid grid-cols-3 gap-2">
            <Field label={t('actions.task_agent')} value={task.agentId || '—'} />
            <Field label={t('actions.task_model')} value={task.modelTag || '—'} />
            <Field label={t('actions.task_terminal')} value={task.terminalId || '—'} />
          </div>
          <Field
            label={t('actions.task_return')}
            value={task.returnText || t('actions.no_return')}
            mono={!!task.returnText}
            muted={!task.returnText}
          />
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  muted = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div
        className={`text-xs whitespace-pre-wrap break-words ${mono ? 'font-mono' : ''} ${
          muted ? 'text-muted-foreground italic' : 'text-foreground'
        }`}
      >
        {value}
      </div>
    </div>
  );
}
