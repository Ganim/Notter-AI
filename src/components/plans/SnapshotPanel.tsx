// src/components/plans/SnapshotPanel.tsx
//
// No `Badge` import — the shadcn `badge.tsx` component is NOT installed in
// this project. The "source" pill is a styled <span>, which keeps the dep
// surface flat. Same applies to `date-fns`: see formatRelativeTime helper.
//
// Read-only listing of subject_versions for the active subject. Versions are
// auto-created by AI hooks (see PlannerTab) — there is NO manual "Snapshot
// now" button in this UI. Clicking a row enters preview mode in the editor;
// the Adopt / Back banner sits in PlannerTab, not here.
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/plans/format';

export function SnapshotPanel() {
  const { t } = useTranslation();
  const versions = useSubjectVersionsStore((s) => s.versions);
  const currentSubjectId = useSubjectVersionsStore((s) => s.currentSubjectId);
  const previewVersionId = useSubjectVersionsStore((s) => s.previewVersionId);
  const enterPreview = useSubjectVersionsStore((s) => s.enterPreview);

  // Reactive read of the live current_version_id. The `subjectRows` slice on
  // planner-store is replaced wholesale by applyRemoteSubjects on every
  // postgres_changes event for the `subjects` table, so this selector
  // re-runs whenever an adopt fires server-side too.
  const currentVersionId = usePlannerStore((s) => {
    if (!s.selectedProject || !s.selectedSubject) return null;
    return (
      s.subjectRows.find(
        (r) =>
          r.projectName === s.selectedProject!.name &&
          r.fileName === s.selectedSubject,
      )?.currentVersionId ?? null
    );
  });

  if (!currentSubjectId) return null;

  return (
    <div className="flex flex-col gap-1 p-3 h-full overflow-y-auto">
      <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
        {t('plans.versions_title')} ({versions.length})
      </p>
      {versions.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('plans.no_versions')}</p>
      )}
      {versions.map((snap) => {
        const isCurrent = snap.id === currentVersionId;
        const isPreviewing = snap.id === previewVersionId;
        return (
          <button
            key={snap.id}
            type="button"
            onClick={() => enterPreview(snap.id)}
            className={cn(
              'flex flex-col gap-1 px-2 py-2 rounded border text-xs text-left transition-colors',
              isPreviewing
                ? 'border-primary bg-primary/10'
                : isCurrent
                ? 'border-primary/60 bg-primary/5'
                : 'border-border hover:bg-muted/50',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium truncate">
                {snap.label ?? `v${snap.id.slice(0, 6)}`}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                {isCurrent && (
                  <span className="text-[10px] py-0 px-1 rounded border border-primary text-primary uppercase tracking-wide">
                    {t('plans.current_marker')}
                  </span>
                )}
                <span className="text-[10px] py-0 px-1 rounded border border-border text-muted-foreground uppercase tracking-wide">
                  {snap.source === 'user'
                    ? t('plans.source_user')
                    : snap.source === 'ai'
                    ? t('plans.source_ai')
                    : t('plans.source_import')}
                </span>
              </div>
            </div>
            {snap.sourceActor && (
              <span className="text-muted-foreground">{snap.sourceActor}</span>
            )}
            <span className="text-muted-foreground">{formatRelativeTime(snap.createdAt)}</span>
          </button>
        );
      })}
    </div>
  );
}
