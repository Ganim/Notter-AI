import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  Play,
  CheckCircle2,
  XCircle,
  Sparkles,
  Loader2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { ActionTask, ActionTaskStatus } from '@/types/actions';
import { useActionsStore } from '@/stores/actions-store';
import { useTerminalsStore } from '@/stores/terminals-store';
import { useAiStore } from '@/stores/ai-store';
import { analyzeTaskFeedback, buildFollowUpTasks } from '@/lib/callback-analyzer';

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
    default:
      // v2 statuses (pending, blocked_hitl, skipped) — neutral dot
      return 'w-2.5 h-2.5 rounded-full border-2 border-gray-300 bg-transparent';
  }
}

export function TaskItem({ actionId, task }: TaskItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [selectedTerminal, setSelectedTerminal] = useState<string>(task.terminalId || '');
  const [feedbackDraft, setFeedbackDraft] = useState<string>(task.returnText);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const isEditingRef = useRef(false);

  // Sync local draft when the task is updated externally (e.g. by the
  // analyzer auto-appending output) — but only when the user isn't actively
  // typing in the textarea.
  useEffect(() => {
    if (!isEditingRef.current) {
      setFeedbackDraft(task.returnText);
    }
  }, [task.returnText]);
  const cycleTaskStatus = useActionsStore((s) => s.cycleTaskStatus);
  const updateTask = useActionsStore((s) => s.updateTask);
  const updateAction = useActionsStore((s) => s.updateAction);
  const consoles = useTerminalsStore((s) => s.consoles);
  const setTerminalRunningTask = useTerminalsStore((s) => s.setTerminalRunningTask);
  const clearRunningTaskByTaskId = useTerminalsStore((s) => s.clearRunningTaskByTaskId);
  const activeProviderId = useAiStore((s) => s.activeProviderId);
  const activeModelTag = useAiStore((s) => s.activeModelTag);
  const cloudConfigs = useAiStore((s) => s.cloudConfigs);

  function handleStatusClick(e: React.MouseEvent) {
    e.stopPropagation();
    cycleTaskStatus(actionId, task.id);
  }

  async function handleRun(e: React.MouseEvent) {
    e.stopPropagation();
    if (!task.prompt.trim()) {
      toast.error(t('actions.task_no_prompt'));
      return;
    }
    if (!selectedTerminal) {
      toast.error(t('actions.task_select_terminal'));
      return;
    }
    // Normalize line endings: PowerShell/cmd PTYs expect \r (CR) for Enter,
    // not \n (LF). Multi-line prompts need each line separated by \r.
    const normalized = task.prompt.replace(/\r?\n/g, '\r');
    const data = normalized.endsWith('\r') ? normalized : normalized + '\r';
    try {
      console.log('[TaskItem] inject', { terminal: selectedTerminal, bytes: data.length });
      await invoke('write_pty', { id: selectedTerminal, data });
      await updateTask(actionId, task.id, {
        terminalId: selectedTerminal,
        status: 'running',
      });
      setTerminalRunningTask(selectedTerminal, {
        actionId,
        taskId: task.id,
        label: task.objective || '(task)',
      });
      toast.success(t('actions.toast_inject_success'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TaskItem] write_pty failed', err);
      toast.error(t('actions.toast_inject_fail', { error: msg }));
    }
  }

  async function handleMarkDone(e: React.MouseEvent) {
    e.stopPropagation();
    await updateTask(actionId, task.id, { status: 'done', returnText: feedbackDraft });
    clearRunningTaskByTaskId(task.id);
  }

  async function handleMarkFailed(e: React.MouseEvent) {
    e.stopPropagation();
    await updateTask(actionId, task.id, { status: 'failed', returnText: feedbackDraft });
    clearRunningTaskByTaskId(task.id);
  }

  async function handleSaveFeedback() {
    if (feedbackDraft === task.returnText) return;
    await updateTask(actionId, task.id, { returnText: feedbackDraft });
  }

  async function handleAnalyze(e: React.MouseEvent) {
    e.stopPropagation();
    const effectiveFeedback = feedbackDraft.trim();
    if (!effectiveFeedback) {
      toast.error(t('actions.task_feedback_required'));
      return;
    }
    // Read the latest action snapshot from the store, not from the captured
    // closure — otherwise modifications made by other components during the
    // analyzer call would be silently overwritten when we patch the tasks array.
    const action = useActionsStore.getState().actions.find((a) => a.id === actionId);
    if (!action) return;

    let modelTag: string;
    let apiKey: string | undefined;
    if (activeProviderId === 'ollama') {
      if (!activeModelTag) {
        toast.error(t('actions.task_default_model_required'));
        return;
      }
      modelTag = activeModelTag;
    } else {
      const cfg = cloudConfigs[activeProviderId];
      if (!cfg?.apiKey.trim()) {
        toast.error(t('actions.task_cloud_provider_required'));
        return;
      }
      modelTag = cfg.model;
      apiKey = cfg.apiKey;
    }

    setIsAnalyzing(true);
    try {
      // Make sure the latest feedback is saved before analysis
      if (feedbackDraft !== task.returnText) {
        await updateTask(actionId, task.id, { returnText: feedbackDraft });
      }
      const result = await analyzeTaskFeedback({
        action,
        task: { ...task, returnText: feedbackDraft },
        feedback: feedbackDraft,
        providerId: activeProviderId,
        modelTag,
        apiKey,
      });

      if (result.complete && result.newTasks.length === 0) {
        toast.success(t('actions.task_analysis_complete'));
        await updateTask(actionId, task.id, { status: 'done' });
        return;
      }

      const followUps = buildFollowUpTasks(result.newTasks, modelTag);
      if (followUps.length === 0) {
        toast.success(t('actions.task_analysis_no_followups'));
        return;
      }

      // Re-read latest snapshot AFTER awaiting the analyzer to avoid stale tasks
      const updatedAction = useActionsStore.getState().actions.find((a) => a.id === actionId);
      if (!updatedAction) return;
      await updateAction(actionId, {
        tasks: [...updatedAction.tasks, ...followUps],
      });
      toast.success(t('actions.task_analysis_followups_added', { count: followUps.length }));
    } catch (err) {
      toast.error(t('actions.task_analysis_failed', { error: (err as Error).message ?? String(err) }));
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <div
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors text-left cursor-pointer"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <button
          onClick={handleStatusClick}
          className={`shrink-0 ${statusDotClass(task.status)}`}
          title={t(`actions.task_status_${task.status}`)}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate">{task.objective || '(no objective)'}</div>
          {/* Phase E: live summary line while executing, result summary
              when done, error message when failed. */}
          {task.status === 'running' && task.summary && (
            <div className="text-[11px] text-muted-foreground italic truncate mt-0.5">
              {task.summary}
            </div>
          )}
          {task.status === 'done' && task.result?.summary && (
            <div className="text-[11px] text-muted-foreground truncate mt-0.5">
              {task.result.summary}
            </div>
          )}
          {task.status === 'failed' && task.result?.errorMessage && (
            <div className="text-[11px] text-destructive truncate mt-0.5">
              {task.result.errorMessage}
            </div>
          )}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {t(`actions.task_status_${task.status}`)}
        </span>
      </div>

      {expanded && (
        <div className="px-3 py-2 border-t border-border space-y-2 bg-muted/20">
          <Field label={t('actions.task_prompt')} value={task.prompt} mono />

          {/* Run controls */}
          <div className="flex items-center gap-2 pt-1">
            {task.status === 'running' ? (
              <>
                <span className="flex-1 text-[11px] text-blue-600 dark:text-blue-400 font-mono">
                  {consoles.find((c) => c.id === task.terminalId)?.name ?? task.terminalId ?? '?'}
                </span>
                <button
                  onClick={handleMarkDone}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-emerald-500 text-white text-[11px] font-medium hover:bg-emerald-600"
                >
                  <CheckCircle2 size={12} /> {t('actions.task_done_button')}
                </button>
                <button
                  onClick={handleMarkFailed}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-rose-500 text-white text-[11px] font-medium hover:bg-rose-600"
                >
                  <XCircle size={12} /> {t('actions.task_failed_button')}
                </button>
              </>
            ) : (
              <>
                <select
                  value={selectedTerminal}
                  onChange={(e) => setSelectedTerminal(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 h-7 rounded-md border border-border bg-background px-2 text-[11px]"
                >
                  <option value="">— {t('actions.task_terminal')} —</option>
                  {consoles.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleRun}
                  disabled={!selectedTerminal || !task.prompt.trim() || consoles.length === 0}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Play size={12} fill="currentColor" /> {t('actions.task_run_button')}
                </button>
              </>
            )}
          </div>
          {consoles.length === 0 && task.status !== 'running' && (
            <p className="text-[10px] text-muted-foreground italic">
              {t('actions.task_no_terminals_hint')}
            </p>
          )}

          <div className="grid grid-cols-3 gap-2">
            <Field label={t('actions.task_agent')} value={task.agentId || '—'} />
            <Field label={t('actions.task_model')} value={task.modelTag || '—'} />
            <Field
              label={t('actions.task_terminal')}
              value={consoles.find((c) => c.id === task.terminalId)?.name || task.terminalId || '—'}
            />
          </div>
          {/* Editable feedback + analyze */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                {t('actions.task_return')}
              </span>
              <button
                onClick={handleAnalyze}
                disabled={isAnalyzing || !feedbackDraft.trim()}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-md bg-primary/10 text-primary text-[10px] font-semibold hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isAnalyzing ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Sparkles size={10} />
                )}
                {isAnalyzing ? t('actions.task_analyzing') : t('actions.task_analyze_button')}
              </button>
            </div>
            <textarea
              value={feedbackDraft}
              onChange={(e) => setFeedbackDraft(e.target.value)}
              onFocus={() => {
                isEditingRef.current = true;
              }}
              onBlur={() => {
                isEditingRef.current = false;
                handleSaveFeedback();
              }}
              onClick={(e) => e.stopPropagation()}
              placeholder={t('actions.no_return')}
              rows={3}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono text-foreground resize-y outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
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
