// src/components/plans/CommentsPanel.tsx
//
// Side panel listing all anchored comments for the current subject. Each
// card shows the quoted snippet (the highlighted region in the editor),
// author + relative time, the body, and inline actions: edit, resolve,
// delete. Clicking the quote scrolls the editor to that anchor.
//
// Comments are anchored to the working draft (not snapshots) per the
// 2026-05-12 design: anchors float on subjects.content; an orphan anchor
// (text edited so the quote no longer exists) is silently archived but the
// row stays in Supabase so the AI roundtrip retains the original feedback.
import { useState } from 'react';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { CheckCircle, Circle, Trash2, Pencil, Archive, ArchiveRestore } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { formatRelativeTime } from '@/lib/plans/format';
import type { SubjectCommentRecord } from '@/lib/sync';

export function CommentsPanel() {
  const { t } = useTranslation();
  const comments = useSubjectVersionsStore((s) => s.comments);
  const currentSubjectId = useSubjectVersionsStore((s) => s.currentSubjectId);
  const editComment = useSubjectVersionsStore((s) => s.editComment);
  const deleteComment = useSubjectVersionsStore((s) => s.deleteComment);
  const toggleResolveComment = useSubjectVersionsStore((s) => s.toggleResolveComment);
  const setCommentArchived = useSubjectVersionsStore((s) => s.setCommentArchived);

  const userId = useAuthStore((s) => s.user?.id);

  const [showResolved, setShowResolved] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const visible = comments.filter((c) => {
    if (c.archived && !showArchived) return false;
    if (c.resolved && !showResolved) return false;
    return true;
  });

  if (!currentSubjectId) return null;

  return (
    <div className="flex flex-col h-full gap-2 p-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t('plans.comments_title')} ({visible.length})
        </p>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className={cn('h-6 px-2 text-[10px] uppercase tracking-wide', showResolved && 'bg-muted')}
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? t('plans.hide_resolved') : t('plans.show_resolved')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className={cn('h-6 px-2 text-[10px] uppercase tracking-wide', showArchived && 'bg-muted')}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? t('plans.hide_archived') : t('plans.show_archived')}
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {visible.length === 0 && (
        <p className="text-xs text-muted-foreground italic mt-2">
          {t('plans.no_comments_hint')}
        </p>
      )}

      {/* Cards */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {visible.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            isAuthor={c.authorUserId === userId}
            onResolve={() => toggleResolveComment(c.id)}
            onArchiveToggle={() => setCommentArchived(c.id, !c.archived)}
            onDelete={() => deleteComment(c.id)}
            onEdit={(body) => editComment(c.id, body)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

// ── CommentCard ─────────────────────────────────────────────────────────────

interface CommentCardProps {
  comment: SubjectCommentRecord;
  isAuthor: boolean;
  onResolve: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
  onEdit: (body: string) => Promise<void>;
  t: (k: string, opts?: any) => string;
}

function CommentCard({
  comment,
  isAuthor,
  onResolve,
  onArchiveToggle,
  onDelete,
  onEdit,
  t,
}: CommentCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  const dimmed = comment.resolved || comment.archived;
  const subjectContent = usePlannerStore((s) => s.subjectContent);

  const scrollToAnchor = () => {
    if (!comment.anchorQuote) return;
    // Best-effort: if the anchor still resolves in the current draft,
    // dispatch a scroll-request event the editor side listens to.
    const idx = subjectContent.indexOf(comment.anchorQuote);
    if (idx === -1) return;
    window.dispatchEvent(
      new CustomEvent('notter:reveal-comment-anchor', {
        detail: { commentId: comment.id, start: idx, end: idx + comment.anchorQuote.length },
      }),
    );
  };

  const handleSave = async () => {
    await onEdit(draft);
    setEditing(false);
  };

  const author = comment.authorDisplayName ?? t('plans.unknown_author');
  const when = formatRelativeTime(comment.createdAt);
  const edited = comment.updatedAt && comment.updatedAt !== comment.createdAt;

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 px-2.5 py-2 rounded border text-xs bg-background/50 border-border',
        dimmed && 'opacity-60',
      )}
    >
      {/* Header: author + time + state badges */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-medium text-foreground truncate">{author}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground" title={new Date(comment.createdAt).toLocaleString()}>{when}</span>
          {edited && (
            <span className="text-[9px] uppercase text-muted-foreground/70">
              {t('plans.edited_marker')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {comment.archived && (
            <span className="text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
              {t('plans.archived_marker')}
            </span>
          )}
          {comment.resolved && (
            <span className="text-[9px] uppercase tracking-wide text-green-600 dark:text-green-400">
              {t('plans.resolved_marker')}
            </span>
          )}
        </div>
      </div>

      {/* Quoted snippet */}
      {comment.anchorQuote && (
        <button
          onClick={scrollToAnchor}
          title={comment.anchorQuote}
          className="text-left border-l-2 border-primary/50 pl-2 italic text-muted-foreground line-clamp-2 hover:text-foreground hover:border-primary transition-colors"
        >
          "{comment.anchorQuote}"
        </button>
      )}

      {/* Body */}
      {!editing ? (
        <p className="whitespace-pre-wrap text-foreground">{comment.body}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSave();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(comment.body);
                setEditing(false);
              }
            }}
            className="text-xs resize-none h-16"
          />
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px]"
              onClick={() => {
                setDraft(comment.body);
                setEditing(false);
              }}
            >
              {t('plans.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-[10px]"
              disabled={!draft.trim() || draft.trim() === comment.body}
              onClick={handleSave}
            >
              {t('plans.save_comment')}
            </Button>
          </div>
        </div>
      )}

      {/* Footer actions */}
      {!editing && (
        <div className="flex items-center justify-end gap-0.5 mt-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            title={comment.resolved ? t('plans.unresolve') : t('plans.resolve')}
            onClick={onResolve}
          >
            {comment.resolved
              ? <CheckCircle className="w-3.5 h-3.5 text-green-500" />
              : <Circle className="w-3.5 h-3.5" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            title={comment.archived ? t('plans.unarchive') : t('plans.archive')}
            onClick={onArchiveToggle}
          >
            {comment.archived
              ? <ArchiveRestore className="w-3.5 h-3.5" />
              : <Archive className="w-3.5 h-3.5" />}
          </Button>
          {isAuthor && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                title={t('plans.edit_comment')}
                onClick={() => setEditing(true)}
              >
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                title={t('plans.delete_comment')}
                onClick={onDelete}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
