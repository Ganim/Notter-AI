// src/components/planning/PlanReviewPanel.tsx
//
// Phase D: replaces the task list in ActionDetail when the Action is in
// plan_review. Shows a summary (task count, total estimated cost), the
// PlanStageStrip for the completed pipeline, a scrollable list of
// TaskCards, and the Approve & Queue / Reject buttons.

import { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Action } from '@/types/actions';
import { useActionsStore } from '@/stores/actions-store';
import { TaskCard } from './TaskCard';
import { PlanStageStrip } from './PlanStageStrip';

interface PlanReviewPanelProps {
  action: Action;
}

export function PlanReviewPanel({ action }: PlanReviewPanelProps) {
  const approvePlan = useActionsStore((s) => s.approvePlan);
  const rejectPlan = useActionsStore((s) => s.rejectPlan);
  const retryPlanStage = useActionsStore((s) => s.retryPlanStage);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const totals = useMemo(() => {
    const stages = action.planStages ?? [];
    const inputTokens = stages.reduce(
      (sum, s) => sum + (s.tokenUsage?.inputTokens ?? 0),
      0,
    );
    const outputTokens = stages.reduce(
      (sum, s) => sum + (s.tokenUsage?.outputTokens ?? 0),
      0,
    );
    const costEstimate = stages.reduce(
      (sum, s) => sum + (s.tokenUsage?.costEstimate ?? 0),
      0,
    );
    const durationMs = stages.reduce((sum, s) => {
      if (s.startedAt && s.completedAt) {
        return sum + (s.completedAt - s.startedAt);
      }
      return sum;
    }, 0);
    return { inputTokens, outputTokens, costEstimate, durationMs };
  }, [action.planStages]);

  async function handleApprove() {
    await approvePlan(action.id);
    toast.success(`Plan approved — ${action.tasks.length} tasks queued.`);
  }

  async function handleConfirmReject() {
    await rejectPlan(action.id, rejectReason.trim() || undefined);
    toast.info('Plan rejected.');
    setRejecting(false);
    setRejectReason('');
  }

  const hasTasks = action.tasks.length > 0;

  return (
    <section className="space-y-4">
      {/* Summary bar */}
      <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Plan review</h3>
          <span className="text-xs text-muted-foreground">
            {action.tasks.length} task{action.tasks.length === 1 ? '' : 's'}
            {' · '}
            {totals.inputTokens + totals.outputTokens} tokens
            {totals.costEstimate > 0 && (
              <> {' · '} ${totals.costEstimate.toFixed(4)}</>
            )}
            {totals.durationMs > 0 && (
              <> {' · '} {(totals.durationMs / 1000).toFixed(1)}s</>
            )}
          </span>
        </div>
        <PlanStageStrip
          stages={action.planStages}
          onRetry={(stage) => retryPlanStage(action.id, stage)}
        />
      </div>

      {/* Task list */}
      <div className="space-y-2">
        {!hasTasks && (
          <p className="text-xs text-muted-foreground italic">
            No tasks — did the extract stage return an empty array?
          </p>
        )}
        {action.tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>

      {/* Phase E: show a banner while waiting for the Queue Worker to
          pick this Action up, or while it's running. The Queue Worker
          polls every 500ms so the banner should flip fast. */}
      {action.status === 'queued' && (
        <div className="rounded-md border border-primary/50 bg-primary/10 px-3 py-2 text-xs text-primary">
          Waiting for executor… the Queue Worker will pick this up within a second.
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        {rejecting ? (
          <div className="flex items-center gap-2 flex-1">
            <input
              autoFocus
              type="text"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmReject();
                if (e.key === 'Escape') {
                  setRejecting(false);
                  setRejectReason('');
                }
              }}
              placeholder="Reason (optional)"
              className="flex-1 h-8 rounded-md border border-border bg-background px-2 text-xs"
            />
            <button
              type="button"
              onClick={() => {
                setRejecting(false);
                setRejectReason('');
              }}
              className="h-8 px-3 rounded-md text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmReject}
              className="h-8 px-3 rounded-md bg-destructive text-destructive-foreground text-xs font-medium hover:bg-destructive/90"
            >
              Confirm reject
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setRejecting(true)}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <X size={12} />
              Reject
            </button>
            <button
              type="button"
              disabled={!hasTasks}
              onClick={handleApprove}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-emerald-500 text-white text-xs font-semibold hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={12} />
              Approve & Queue
            </button>
          </>
        )}
      </div>
    </section>
  );
}
