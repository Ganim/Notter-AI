// src/components/plans/CommentsPanel.tsx
//
// Side panel listing all anchored comments for the current subject.
//
// Card layout:
//   ┌─────────────────────────────────────────┐
//   │ [linhas 5–9]  ●resolvido           ⋮   │
//   │ ▎ "trecho citado..."                    │
//   │   comentário do usuário                 │
//   │   guilherme · editado · 12/05 21:25     │
//   └─────────────────────────────────────────┘
//
// The active card (set by clicking an anchored highlight in the editor or
// the quote inside another card) gets a subtle ring; clicking the kebab
// opens the actions popover. Dimmed appearance covers resolved + archived.
import { useEffect, useRef, useState } from 'react';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2, Circle, MoreVertical, Pencil, Trash2,
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
    <div className="flex flex-col h-full p-3 gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
          {t('plans.comments_title')}
          <span className="ml-1.5 text-muted-foreground/70 normal-case font-normal">
            {visible.length}
          </span>
        </p>
        <div className="flex items-center gap-1">
          <ToggleChip
            active={showResolved}
            onClick={() => setShowResolved((v) => !v)}
            icon={<CheckCircle2 size={11} />}
            label={t('plans.resolved_marker')}
            title={showResolved ? t('plans.hide_resolved') : t('plans.show_resolved')}
          />
          <ToggleChip
            active={showArchived}
            onClick={() => setShowArchived((v) => !v)}
            icon={<Archive size={11} />}
            label={t('plans.archived_marker')}
            title={showArchived ? t('plans.hide_archived') : t('plans.show_archived')}
          />
        </div>
      </div>

      {visible.length === 0 && (
        <p className="text-[11px] text-muted-foreground italic px-1">
          {t('plans.no_comments_hint')}
        </p>
      )}

      <div className="flex-1 overflow-y-auto -mx-1 px-1 flex flex-col gap-2">
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

// ── ToggleChip ───────────────────────────────────────────────────────────

function ToggleChip({
  active,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 h-6 px-2 rounded-full border text-[10px] capitalize transition-colors',
        active
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-border/60 text-muted-foreground/80 hover:text-foreground hover:bg-muted/60',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
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

  // Scroll into view when this card becomes active.
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
  const author = formatAuthor(comment.authorDisplayName, t);
  const created = new Date(comment.createdAt);
  const dateLabel = created.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
  const timeLabel = created.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const edited = comment.updatedAt && comment.updatedAt !== comment.createdAt;

  return (
    <div
      ref={cardRef}
      onClick={onActivate}
      className={cn(
        'group rounded-md border text-xs bg-card/40 cursor-default transition-all',
        isActive
          ? 'border-primary/50 ring-1 ring-primary/40 bg-card/70'
          : 'border-border/50 hover:border-border',
        dimmed && 'opacity-65',
      )}
    >
      <div className="flex gap-1.5 p-2.5 pr-1.5">
        {/* ── Main column ─────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {/* Top row: line badge + status dots */}
          <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
            <span
              className={cn(
                'inline-flex items-center px-1.5 h-[18px] rounded-full border font-medium tabular-nums',
                resolved
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-border/60 bg-muted/40 text-muted-foreground italic',
              )}
            >
              {lineLabel}
            </span>
            {comment.resolved && (
              <StatusDot tone="green" label={t('plans.resolved_marker')} />
            )}
            {comment.archived && (
              <StatusDot tone="amber" label={t('plans.archived_marker')} />
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
            <p className="whitespace-pre-wrap text-foreground leading-snug">
              {comment.body}
            </p>
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

          {/* Footer: author · edited · date */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/80 mt-0.5">
            <span className="truncate" title={comment.authorDisplayName ?? ''}>{author}</span>
            {edited && <span className="opacity-70">· {t('plans.edited_marker')}</span>}
            <span className="opacity-70">·</span>
            <span className="tabular-nums" title={created.toLocaleString()}>
              {dateLabel} {timeLabel}
            </span>
          </div>
        </div>

        {/* ── Right column: kebab only ──────────────────────────────── */}
        <div ref={menuRef} className="relative shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            title={t('plans.more_options')}
            className="p-1 rounded text-muted-foreground/70 opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground transition-all data-[open=true]:opacity-100"
            data-open={menuOpen}
          >
            <MoreVertical size={14} />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 w-40 rounded-md border border-border bg-popover text-popover-foreground shadow-md z-30"
              onClick={(e) => e.stopPropagation()}
            >
              {isAuthor && (
                <MenuItem
                  icon={<Pencil size={12} />}
                  label={t('plans.edit_comment')}
                  onClick={() => {
                    setMenuOpen(false);
                    setEditing(true);
                  }}
                />
              )}
              <MenuItem
                icon={comment.resolved
                  ? <CheckCircle2 size={12} className="text-green-500" />
                  : <Circle size={12} />}
                label={comment.resolved ? t('plans.unresolve') : t('plans.resolve')}
                onClick={() => {
                  setMenuOpen(false);
                  onResolve();
                }}
              />
              <MenuItem
                icon={comment.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                label={comment.archived ? t('plans.unarchive') : t('plans.archive')}
                onClick={() => {
                  setMenuOpen(false);
                  onArchiveToggle();
                }}
              />
              {isAuthor && (
                <>
                  <div className="border-t border-border" />
                  <MenuItem
                    icon={<Trash2 size={12} />}
                    label={t('plans.delete_comment')}
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                    destructive
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors',
        destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'hover:bg-muted',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function StatusDot({ tone, label }: { tone: 'green' | 'amber'; label: string }) {
  const dot =
    tone === 'green'
      ? 'bg-green-500'
      : 'bg-amber-500';
  const text =
    tone === 'green'
      ? 'text-green-600 dark:text-green-400'
      : 'text-amber-600 dark:text-amber-400';
  return (
    <span className={cn('inline-flex items-center gap-1', text)}>
      <span className={cn('inline-block w-1.5 h-1.5 rounded-full', dot)} />
      <span className="capitalize">{label}</span>
    </span>
  );
}

/**
 * Display name for a comment author. If the stored value looks like an
 * email, we strip the domain to keep the footer line tight; full email is
 * still available via the row's `title` attribute.
 */
function formatAuthor(raw: string | null, t: (k: string) => string): string {
  if (!raw) return t('plans.unknown_author');
  const at = raw.indexOf('@');
  if (at > 0) return raw.slice(0, at);
  return raw;
}
