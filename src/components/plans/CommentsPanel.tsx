// src/components/plans/CommentsPanel.tsx
//
// No `date-fns` import — see formatRelativeTime helper.
import { useState } from 'react';
import { usePlanStore } from '@/stores/plan-store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Circle, Trash2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { formatRelativeTime } from '@/lib/plans/format';

export function CommentsPanel() {
  const { t } = useTranslation();
  const comments = usePlanStore((s) => s.comments);
  const currentPlanId = usePlanStore((s) => s.currentPlanId);
  const plans = usePlanStore((s) => s.plans);
  const addComment = usePlanStore((s) => s.addComment);
  const deleteComment = usePlanStore((s) => s.deleteComment);
  const toggleResolveComment = usePlanStore((s) => s.toggleResolveComment);

  const currentSnapshotId = plans.find((p) => p.id === currentPlanId)?.currentSnapshotId ?? null;
  const userId = useAuthStore((s) => s.user?.id);

  const [body, setBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  // Default: comments for the current snapshot version. If no snapshot, show all.
  const filtered = currentSnapshotId
    ? comments.filter((c) =>
        showResolved ? c.versionId === currentSnapshotId : !c.resolved && c.versionId === currentSnapshotId,
      )
    : comments.filter((c) => showResolved || !c.resolved);

  const handleAdd = async () => {
    if (!body.trim() || !currentSnapshotId) return;
    await addComment(currentSnapshotId, body);
    setBody('');
  };

  if (!currentPlanId) return null;

  return (
    <div className="flex flex-col h-full gap-2 p-3">
      {/* Filter toggle */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Comments ({filtered.length})
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? 'Hide resolved' : 'Show resolved'}
        </Button>
      </div>

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {currentSnapshotId ? 'No comments on this version yet.' : 'No snapshot selected — snapshot the plan to add comments.'}
          </p>
        )}
        {filtered.map((c) => (
          <div
            key={c.id}
            className={cn(
              'flex flex-col gap-1 px-2 py-2 rounded border text-xs',
              c.resolved ? 'opacity-50 border-border' : 'border-border',
            )}
          >
            <p className="whitespace-pre-wrap">{c.body}</p>
            <div className="flex items-center justify-between mt-1">
              <span className="text-muted-foreground">{formatRelativeTime(c.createdAt)}</span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-5 p-0"
                  title={c.resolved ? t('plans.unresolve') : t('plans.resolve')}
                  onClick={() => toggleResolveComment(c.id)}
                >
                  {c.resolved
                    ? <CheckCircle className="w-3 h-3 text-green-500" />
                    : <Circle className="w-3 h-3" />}
                </Button>
                {c.authorUserId === userId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 w-5 p-0"
                    onClick={() => deleteComment(c.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add comment */}
      {currentSnapshotId ? (
        <div className="flex flex-col gap-2 shrink-0">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('plans.comment_placeholder')}
            className="text-xs resize-none h-16"
          />
          <Button size="sm" onClick={handleAdd} disabled={!body.trim()}>
            Add comment
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground shrink-0">
          Snapshot the plan to enable comments.
        </p>
      )}
    </div>
  );
}
