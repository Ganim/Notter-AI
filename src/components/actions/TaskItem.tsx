import { useState } from 'react';
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
  }
}

export function TaskItem({ actionId, task }: TaskItemProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [selectedTerminal, setSelectedTerminal] = useState<string>(task.terminalId || '');
  const [feedbackDraft, setFeedbackDraft] = useState<string>(task.returnText);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const cycleTaskStatus = useActionsStore((s) => s.cycleTaskStatus);
  const updateTask = useActionsStore((s) => s.updateTask);
  const updateAction = useActionsStore((s) => s.updateAction);
  const actions = useActionsStore((s) => s.actions);
  const consoles = useTerminalsStore((s) => s.consoles);
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
      toast.error('Task has no prompt to run');
      return;
    }
    if (!selectedTerminal) {
      toast.error('Select a terminal first');
      return;
    }
    try {
      await invoke('write_pty', { id: selectedTerminal, data: task.prompt + '\r' });
      await updateTask(actionId, task.id, {
        terminalId: selectedTerminal,
        status: 'running',
      });
      toast.success('Prompt injected into terminal');
    } catch (err) {
      toast.error(`Failed to inject: ${(err as Error).message ?? String(err)}`);
    }
  }

  async function handleMarkDone(e: React.MouseEvent) {
    e.stopPropagation();
    await updateTask(actionId, task.id, { status: 'done', returnText: feedbackDraft });
  }

  async function handleMarkFailed(e: React.MouseEvent) {
    e.stopPropagation();
    await updateTask(actionId, task.id, { status: 'failed', returnText: feedbackDraft });
  }

  async function handleSaveFeedback() {
    if (feedbackDraft === task.returnText) return;
    await updateTask(actionId, task.id, { returnText: feedbackDraft });
  }

  async function handleAnalyze(e: React.MouseEvent) {
    e.stopPropagation();
    const effectiveFeedback = feedbackDraft.trim();
    if (!effectiveFeedback) {
      toast.error('Enter some feedback first');
      return;
    }
    const action = actions.find((a) => a.id === actionId);
    if (!action) return;

    let modelTag: string;
    let apiKey: string | undefined;
    if (activeProviderId === 'ollama') {
      if (!activeModelTag) {
        toast.error('Set a default AI model first');
        return;
      }
      modelTag = activeModelTag;
    } else {
      const cfg = cloudConfigs[activeProviderId];
      if (!cfg?.apiKey.trim()) {
        toast.error('Configure the active cloud provider first');
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
        toast.success('Analysis: task is complete, no follow-ups needed');
        await updateTask(actionId, task.id, { status: 'done' });
        return;
      }

      const followUps = buildFollowUpTasks(result.newTasks, modelTag);
      if (followUps.length === 0) {
        toast.success('Analysis complete — no follow-up tasks suggested');
        return;
      }

      const updatedAction = actions.find((a) => a.id === actionId);
      if (!updatedAction) return;
      await updateAction(actionId, {
        tasks: [...updatedAction.tasks, ...followUps],
      });
      toast.success(`Added ${followUps.length} follow-up task${followUps.length === 1 ? '' : 's'}`);
    } catch (err) {
      toast.error(`Analysis failed: ${(err as Error).message ?? String(err)}`);
    } finally {
      setIsAnalyzing(false);
    }
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
                  <CheckCircle2 size={12} /> Done
                </button>
                <button
                  onClick={handleMarkFailed}
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-rose-500 text-white text-[11px] font-medium hover:bg-rose-600"
                >
                  <XCircle size={12} /> Failed
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
                  <Play size={12} fill="currentColor" /> Run
                </button>
              </>
            )}
          </div>
          {consoles.length === 0 && task.status !== 'running' && (
            <p className="text-[10px] text-muted-foreground italic">
              Open a terminal in the Terminals tab first
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
                {isAnalyzing ? 'Analyzing...' : 'Analyze'}
              </button>
            </div>
            <textarea
              value={feedbackDraft}
              onChange={(e) => setFeedbackDraft(e.target.value)}
              onBlur={handleSaveFeedback}
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
