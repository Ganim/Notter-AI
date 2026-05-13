// src/components/plans/CommentsPanel.tsx
//
// Side panel listing all anchored comments for the current subject.
//
// Card layout (left → right column):
//   Left  : line range badge (outline) → quoted snippet → comment body
//   Right : kebab menu (Edit / Resolve / Delete) → date + time
//
// The active card (set by clicking an anchored highlight in the editor or
// the quote inside another card) gets a colored ring; clicking the kebab
// opens the actions popover. Dimmed appearance covers resolved + archived.
import { useEffect, useRef, useState } from 'react';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle, Circle, MoreVertical, Pencil, Trash2,
  Archive, ArchiveRestore,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { findAnchor, offsetToLine } from '@/lib/plans/anchor';
import type { SubjectCommentRecord } from '@/lib/sync';

export function CommentsPanel() {
  const { t } = useTranslation();
  const comments = useSubjectVersionsStore((s) => s.comments);
  const currentSubjectId = useSubjectVersionsStore((s) => s.currentSubjectId);
  const editComment = useSubjectVersionsStore((s) => s.editComment);
  const deleteComment = useSubjectVersionsStore((s) => s.deleteComment);
  const toggleResolveComment = useSubjectVersionsStore((s) => s.toggleResolveComment);
  const setCommentArchived = useSubjectVersionsStore((s) => s.setCommentArchived);
  const activeCommentId = useSubjectVersionsStore((s) => s.activeCommentId);
  const setActiveCommentId = useSubjectVersionsStore((s) => s.setActiveCommentId);

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

      {visible.length === 0 && (
        <p className="text-xs text-muted-foreground italic mt-2">
          {t('plans.no_comments_hint')}
        </p>
      )}

      <div className="flex-1 overflow-y-auto flex flex-col gap-2">
        {visible.map((c) => (
          <CommentCard
            key={c.id}
            comment={c}
            isAuthor={c.authorUserId === userId}
            isActive={c.id === activeCommentId}
            onActivate={() => setActiveCommentId(c.id)}
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
  isActive: boolean;
  onActivate: () => void;
  onResolve: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
  onEdit: (body: string) => Promise<void>;
  t: (k: string, opts?: any) => string;
}

function CommentCard({
  comment,
  isAuthor,
  isActive,
  onActivate,
  onResolve,
  onArchiveToggle,
  onDelete,
  onEdit,
  t,
}: CommentCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [menuOpen, setMenuOpen] = useState(false);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const subjectContent = usePlannerStore((s) => s.subjectContent);

  // Resolve the anchor against the current draft so we can render the live
  // line range badge ("line 5", "lines 5–9") and use the live offsets when
  // the user clicks the quote to scroll the editor.
  const resolved = comment.anchorQuote
    ? findAnchor(subjectContent, {
        quote: comment.anchorQuote,
        prefix: comment.anchorPrefix,
        suffix: comment.anchorSuffix,
      })
    : null;

  const lineLabel = resolved
    ? (() => {
        const from = offsetToLine(subjectContent, resolved.start);
        const to = offsetToLine(subjectContent, Math.max(resolved.start, resolved.end - 1));
        return from === to
          ? t('plans.line_singular', { n: from })
          : t('plans.line_range', { from, to });
      })()
    : t('plans.line_orphan');

  // Scroll into view + flash when this card becomes active.
  useEffect(() => {
    if (isActive && cardRef.current) {
      cardRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  // Outside-click closes the kebab menu.
  useEffect(() => {
    if (!menuOpen) return;
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  const handleScrollToAnchor = () => {
    onActivate();
    if (!resolved) return;
    window.dispatchEvent(
      new CustomEvent('notter:reveal-comment-anchor', {
        detail: { commentId: comment.id, start: resolved.start, end: resolved.end },
      }),
    );
  };

  const handleSave = async () => {
    await onEdit(draft);
    setEditing(false);
  };

  const dimmed = comment.resolved || comment.archived;
  const author = comment.authorDisplayName ?? t('plans.unknown_author');
  const created = new Date(comment.createdAt);
  const dateLabel = created.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
  const timeLabel = created.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const edited = comment.updatedAt && comment.updatedAt !== comment.createdAt;

  return (
    <div
      ref={cardRef}
      onClick={onActivate}
      className={cn(
        'group rounded border text-xs bg-background/60 transition-all',
        isActive
          ? 'border-primary ring-2 ring-primary/40 shadow-sm'
          : 'border-border hover:border-border/80',
        dimmed && 'opacity-60',
      )}
    >
      <div className="flex gap-2 p-2.5">
        {/* ── Left column ─────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
          {/* Line range badge + state badges */}
          <div className="flex items-center gap-1 flex-wrap">
            <span
              className={cn(
                'inline-flex items-center px-1.5 py-px rounded border text-[10px] uppercase tracking-wider font-medium',
                resolved
                  ? 'border-border text-muted-foreground'
                  : 'border-amber-300/60 text-amber-700 dark:text-amber-400 dark:border-amber-500/40',
              )}
            >
              {lineLabel}
            </span>
            {comment.resolved && (
              <span className="text-[9px] uppercase tracking-wide text-green-600 dark:text-green-400">
                · {t('plans.resolved_marker')}
              </span>
            )}
            {comment.archived && !comment.resolved && (
              <span className="text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
                · {t('plans.archived_marker')}
              </span>
            )}
          </div>

          {/* Quoted snippet */}
          {comment.anchorQuote && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleScrollToAnchor();
              }}
              title={comment.anchorQuote}
              className="text-left border-l-2 border-primary/40 pl-2 italic text-muted-foreground line-clamp-2 hover:text-foreground hover:border-primary transition-colors"
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
                onClick={(e) => e.stopPropagation()}
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
                  onClick={(e) => {
                    e.stopPropagation();
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
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSave();
                  }}
                >
                  {t('plans.save_comment')}
                </Button>
              </div>
            </div>
          )}

          {/* Author + edited marker */}
          <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
            <span className="truncate">— {author}</span>
            {edited && (
              <span className="opacity-70">· {t('plans.edited_marker')}</span>
            )}
          </div>
        </div>

        {/* ── Right column ────────────────────────────────────────────── */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          {/* Kebab menu */}
          <div ref={menuRef} className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              title={t('plans.more_options')}
              className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            >
              <MoreVertical size={14} />
            </button>
            {menuOpen && (
              <div
                className="absolute right-0 top-full mt-1 w-40 rounded-md border border-border bg-popover text-popover-foreground shadow-md z-30"
                onClick={(e) => e.stopPropagation()}
              >
                {isAuthor && (
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setEditing(true);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left"
                  >
                    <Pencil size={12} />
                    <span>{t('plans.edit_comment')}</span>
                  </button>
                )}
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onResolve();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left"
                >
                  {comment.resolved
                    ? <CheckCircle size={12} className="text-green-500" />
                    : <Circle size={12} />}
                  <span>{comment.resolved ? t('plans.unresolve') : t('plans.resolve')}</span>
                </button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    onArchiveToggle();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted text-left"
                >
                  {comment.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                  <span>{comment.archived ? t('plans.unarchive') : t('plans.archive')}</span>
                </button>
                {isAuthor && (
                  <>
                    <div className="border-t border-border" />
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        onDelete();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-destructive/10 text-destructive text-left"
                    >
                      <Trash2 size={12} />
                      <span>{t('plans.delete_comment')}</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Date / time stack */}
          <div
            className="flex flex-col items-end text-[10px] leading-tight text-muted-foreground tabular-nums"
            title={created.toLocaleString()}
          >
            <span>{dateLabel}</span>
            <span>{timeLabel}</span>
          </div>
        </div>
      </div>

    </div>
  );
}
