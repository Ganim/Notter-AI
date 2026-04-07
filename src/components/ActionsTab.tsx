import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Play, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { useActionsStore } from '@/stores/actions-store';
import { useTerminalsStore } from '@/stores/terminals-store';
import { runActionQueue } from '@/lib/action-runner';
import { ActionList } from './actions/ActionList';
import { ActionDetail } from './actions/ActionDetail';

export function ActionsTab() {
  const { t } = useTranslation();
  const actions = useActionsStore((s) => s.actions);
  const loaded = useActionsStore((s) => s.loaded);
  const consoles = useTerminalsStore((s) => s.consoles);
  const addConsole = useTerminalsStore((s) => s.addConsole);
  const [queueTerminal, setQueueTerminal] = useState<string>('');
  const [isQueueRunning, setIsQueueRunning] = useState(false);

  const waitingActions = useMemo(
    () => actions.filter((a) => a.status === 'waiting' && a.tasks.some((t) => t.status === 'waiting')),
    [actions],
  );

  async function handleProcessQueue() {
    if (waitingActions.length === 0) {
      toast.info(t('actions.toast_no_waiting_queue'));
      return;
    }
    let terminalId = queueTerminal;
    if (!terminalId) {
      const newId = addConsole('queue', undefined);
      if (!newId) {
        toast.error(t('actions.toast_terminal_max'));
        return;
      }
      terminalId = newId;
      setQueueTerminal(newId);
      await new Promise((r) => setTimeout(r, 1500));
    }
    setIsQueueRunning(true);
    try {
      const result = await runActionQueue(waitingActions, terminalId);
      toast.success(
        t('actions.toast_queue_done', {
          actions: result.actionsProcessed,
          tasks: result.tasksSucceeded,
          failed: result.tasksFailed,
        }),
      );
    } finally {
      setIsQueueRunning(false);
    }
  }

  if (loaded && actions.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-center px-4">
        <Sparkles size={48} className="text-muted-foreground/30 mb-4" />
        <h2 className="text-lg font-semibold text-foreground mb-2">{t('actions.empty_title')}</h2>
        <p className="text-sm text-muted-foreground max-w-sm">{t('actions.empty_subtitle')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-2 flex items-center justify-between gap-3">
        <h1 className="text-base font-semibold">{t('actions.title')}</h1>
        <div className="flex items-center gap-2">
          <select
            value={queueTerminal}
            onChange={(e) => setQueueTerminal(e.target.value)}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
            title={t('actions.queue_terminal_title')}
          >
            <option value="">{consoles.length === 0 ? '+ new terminal' : '— select terminal —'}</option>
            {consoles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleProcessQueue}
            disabled={isQueueRunning || waitingActions.length === 0}
            className="flex items-center gap-1.5 h-7 rounded-md bg-emerald-500 px-2.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('actions.process_all_title')}
          >
            {isQueueRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} fill="currentColor" />}
            {t('actions.process_all', { count: waitingActions.length })}
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel defaultSize={35} minSize={20}>
            <ActionList />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={65} minSize={30}>
            <ActionDetail />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
