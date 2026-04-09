// src/components/planning/PlanStageStrip.tsx
//
// Phase D: horizontal 4-pill strip showing progress through the planning
// pipeline. Clicking a failed pill calls onRetry so the user can re-run
// from that stage.

import { Loader2, CircleCheck, CircleAlert, Circle } from 'lucide-react';
import type { PlanStage, PlanStageName } from '@/types/actions';

interface PlanStageStripProps {
  stages: PlanStage[] | undefined;
  onRetry?: (stage: PlanStageName) => void;
  compact?: boolean;
}

const STAGE_LABELS: Record<PlanStageName, string> = {
  extract: 'Extract',
  security: 'Security',
  data_consistency: 'Data',
  prompt_critic: 'Critic',
};

const STAGE_ORDER: PlanStageName[] = [
  'extract',
  'security',
  'data_consistency',
  'prompt_critic',
];

export function PlanStageStrip({
  stages,
  onRetry,
  compact = false,
}: PlanStageStripProps) {
  // Always render 4 pills, filling in missing stages as 'pending'.
  const byName = new Map((stages ?? []).map((s) => [s.name, s]));
  const ordered: PlanStage[] = STAGE_ORDER.map(
    (name) => byName.get(name) ?? { name, status: 'pending' },
  );

  return (
    <div className="flex items-center gap-1.5" role="status" aria-label="Planning pipeline progress">
      {ordered.map((stage) => {
        const base = compact
          ? 'flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors'
          : 'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border transition-colors';

        let palette: string;
        let icon;
        switch (stage.status) {
          case 'running':
            palette = 'bg-primary/10 border-primary text-primary';
            icon = <Loader2 size={compact ? 10 : 12} className="animate-spin" />;
            break;
          case 'done':
            palette = 'bg-emerald-500/10 border-emerald-500 text-emerald-600 dark:text-emerald-400';
            icon = <CircleCheck size={compact ? 10 : 12} />;
            break;
          case 'failed':
            palette =
              'bg-destructive/10 border-destructive text-destructive cursor-pointer hover:bg-destructive/20';
            icon = <CircleAlert size={compact ? 10 : 12} />;
            break;
          default:
            palette = 'bg-muted border-border text-muted-foreground';
            icon = <Circle size={compact ? 10 : 12} />;
        }

        const clickable = stage.status === 'failed' && onRetry;
        const title =
          stage.status === 'failed'
            ? `${STAGE_LABELS[stage.name]}: ${stage.errorMessage ?? 'failed'}${
                clickable ? ' (click to retry)' : ''
              }`
            : `${STAGE_LABELS[stage.name]}: ${stage.status}`;

        return (
          <button
            key={stage.name}
            type="button"
            disabled={!clickable}
            onClick={clickable ? () => onRetry(stage.name) : undefined}
            className={`${base} ${palette} ${clickable ? '' : 'cursor-default'}`}
            title={title}
          >
            {icon}
            {!compact && <span>{STAGE_LABELS[stage.name]}</span>}
          </button>
        );
      })}
    </div>
  );
}
