// src/components/plans/SnapshotPanel.tsx
//
// No `Badge` import — the shadcn `badge.tsx` component is NOT installed in
// this project. The "source" pill is a styled <span>, which keeps the dep
// surface flat. Same applies to `date-fns`: see formatRelativeTime helper.
import { usePlanStore } from '@/stores/plan-store';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/plans/format';

export function SnapshotPanel() {
  const { t } = useTranslation();
  const snapshots = usePlanStore((s) => s.snapshots);
  const currentPlanId = usePlanStore((s) => s.currentPlanId);
  const plans = usePlanStore((s) => s.plans);
  const loadSnapshot = usePlanStore((s) => s.loadSnapshot);

  const currentSnapshotId = plans.find((p) => p.id === currentPlanId)?.currentSnapshotId ?? null;

  if (!currentPlanId) return null;

  return (
    <div className="flex flex-col gap-1 p-3 h-full overflow-y-auto">
      <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
        Versions ({snapshots.length})
      </p>
      {snapshots.length === 0 && (
        <p className="text-xs text-muted-foreground">No snapshots yet — click "Snapshot now" to save the current state.</p>
      )}
      {snapshots.map((snap) => (
        <div
          key={snap.id}
          className={cn(
            'flex flex-col gap-1 px-2 py-2 rounded border text-xs',
            snap.id === currentSnapshotId ? 'border-primary bg-primary/5' : 'border-border',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium truncate">{snap.label ?? `v${snap.id.slice(0, 6)}`}</span>
            <span className="text-[10px] py-0 px-1 shrink-0 rounded border border-border text-muted-foreground uppercase tracking-wide">
              {snap.source === 'user' ? t('plans.source_user')
                : snap.source === 'ai' ? t('plans.source_ai')
                : t('plans.source_import')}
            </span>
          </div>
          {snap.sourceActor && (
            <span className="text-muted-foreground">{snap.sourceActor}</span>
          )}
          <div className="flex items-center justify-between mt-1">
            <span className="text-muted-foreground">{formatRelativeTime(snap.createdAt)}</span>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-2 text-xs"
              onClick={() => loadSnapshot(snap.id)}
            >
              Load
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
