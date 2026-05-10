// src/components/plans/CommentsPanel.tsx
//
// No `date-fns` import — see formatRelativeTime helper.
//
// Per-version comment thread. The active version is read live from
// `subjects.current_version_id` via planner-store.subjectRows. When no
// version exists yet (brand-new subject pre-snapshot), the add-comment form
// is hidden and a hint asks the user to create a version first.
import { useState } from 'react';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Circle, Trash2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { formatRelativeTime } from '@/lib/plans/format';

export function CommentsPanel() {
  const { t } = useTranslation();
  const comments = useSubjectVersionsStore((s) => s.comments);
  const currentSubjectId = useSubjectVersionsStore((s) => s.currentSubjectId);
  const addComment = useSubjectVersionsStore((s) => s.addComment);
  const deleteComment = useSubjectVersionsStore((s) => s.deleteComment);
  const toggleResolveComment = useSubjectVersionsStore((s) => s.toggleResolveComment);

  // Reactive read — re-renders when planner-store.subjectRows changes (e.g.
  // after an adopt round-trips through postgres_changes).
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

  const userId = useAuthStore((s) => s.user?.id);

  const [body, setBody] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  // Default: comments for the current version. When there is no current
  // version yet, the list is empty (we can't author comments yet either).
  const filtered = currentVersionId
    ? comments.filter((c) =>
        showResolved
          ? c.versionId === currentVersionId
          : !c.resolved && c.versionId === currentVersionId,
      )
    : [];

  const handleAdd = async () => {
    if (!body.trim() || !currentVersionId) return;
    await addComment(currentVersionId, body);
    setBody('');
  };

  if (!currentSubjectId) return null;

  return (
    <div className="flex flex-col h-full gap-2 p-3">
      {/* Filter toggle */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t('plans.comments_title')} ({filtered.length})
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved ? t('plans.hide_resolved') : t('plans.show_resolved')}
        </Button>
      </div>

      {/* Comment list */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {filtered.length === 0 && currentVersionId && (
          <p className="text-xs text-muted-foreground">
            {t('plans.no_comments_for_version')}
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
      {currentVersionId ? (
        <div className="flex flex-col gap-2 shrink-0">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('plans.comment_placeholder')}
            className="text-xs resize-none h-16"
          />
          <Button size="sm" onClick={handleAdd} disabled={!body.trim()}>
            {t('plans.add_comment')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground shrink-0">
          {t('plans.no_version_for_comments')}
        </p>
      )}
    </div>
  );
}
