// src/components/plans/InlineCommentTrigger.tsx
//
// Floating "💬 Comentar" button that follows the user's text selection inside
// either the Monaco editor (edit mode) or the rendered markdown preview
// (view mode). On click, it expands inline to a tiny composer (textarea +
// Save / Cancel) and creates an anchored comment via the subject-versions
// store.
//
// All positioning is screen-space via React Portal so the bubble can escape
// any overflow:hidden parents (Monaco's internals, ScrollAreas, etc.).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';
import { buildAnchorFromSelection } from '@/lib/plans/anchor';
import type { CommentAnchor } from '@/lib/plans/anchor';
import { rangeToSourceOffsets } from '@/lib/plans/dom-source-range';

interface PendingSelection {
  /** Anchor we'll persist if the user confirms. */
  anchor: CommentAnchor;
  /** Screen-space anchor for the bubble (just-below-end-of-selection). */
  x: number;
  y: number;
}

interface Props {
  /** Monaco editor instance — null until onMount fires. */
  monacoEditor: any | null;
  /** DOM container that hosts the rendered markdown in view mode. */
  previewContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Which surface is currently visible — drives which selection source we listen to. */
  mode: 'edit' | 'view';
  /** Suppress the trigger entirely (preview mode, no subject, etc). */
  disabled?: boolean;
}

export function InlineCommentTrigger({
  monacoEditor,
  previewContainerRef,
  mode,
  disabled,
}: Props) {
  const { t } = useTranslation();
  const subjectContent = usePlannerStore((s) => s.subjectContent);

  // Read the live current_version_id off planner-store. addComment auto-snapshots
  // when this is null, so we don't need to gate on it ourselves.
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

  const addComment = useSubjectVersionsStore((s) => s.addComment);
  const setActiveCommentId = useSubjectVersionsStore((s) => s.setActiveCommentId);

  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const composerRef = useRef<HTMLDivElement | null>(null);

  // ── Reset on subject / mode change ────────────────────────────────────────
  useEffect(() => {
    setPending(null);
    setComposerOpen(false);
    setBody('');
  }, [mode, subjectContent.length === 0]);

  // ── Selection listeners ───────────────────────────────────────────────────
  // Edit mode → Monaco's onDidChangeCursorSelection is the source of truth.
  useEffect(() => {
    if (disabled || mode !== 'edit' || !monacoEditor) return;
    const editor = monacoEditor;
    const dispose = editor.onDidChangeCursorSelection(() => {
      // If the composer is open, don't disturb it — the user is typing.
      if (composerOpen) return;
      const sel = editor.getSelection();
      if (!sel || sel.isEmpty()) {
        setPending(null);
        return;
      }
      const model = editor.getModel();
      if (!model) return;
      const startOffset: number = model.getOffsetAt(sel.getStartPosition());
      const endOffset: number = model.getOffsetAt(sel.getEndPosition());
      const text = model.getValueInRange(sel) as string;
      if (!text.trim()) {
        setPending(null);
        return;
      }
      const anchor = buildAnchorFromSelection(subjectContent, startOffset, endOffset);
      if (!anchor) {
        setPending(null);
        return;
      }
      const visible = editor.getScrolledVisiblePosition(sel.getEndPosition());
      const dom = editor.getDomNode() as HTMLElement | null;
      if (!visible || !dom) return;
      const rect = dom.getBoundingClientRect();
      setPending({
        anchor,
        x: rect.left + visible.left,
        y: rect.top + visible.top + visible.height,
      });
    });
    return () => dispose.dispose();
  }, [disabled, mode, monacoEditor, subjectContent, composerOpen]);

  // View mode → DOM `selectionchange` scoped to the preview container.
  // Resolution goes via `.notter-src` data attributes (see
  // rehype-source-positions), so the anchor's source range is exact even
  // when the selection crosses inline formatting like **bold** or links.
  useEffect(() => {
    if (disabled || mode !== 'view') return;
    const handle = () => {
      if (composerOpen) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setPending(null);
        return;
      }
      if (!sel.toString().trim()) {
        setPending(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = previewContainerRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        setPending(null);
        return;
      }
      const sourceRange = rangeToSourceOffsets(range, container);
      if (!sourceRange) {
        setPending(null);
        return;
      }
      const anchor = buildAnchorFromSelection(subjectContent, sourceRange.start, sourceRange.end);
      if (!anchor) {
        setPending(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setPending({
        anchor,
        x: rect.right,
        y: rect.bottom,
      });
    };
    document.addEventListener('selectionchange', handle);
    return () => document.removeEventListener('selectionchange', handle);
  }, [disabled, mode, previewContainerRef, subjectContent, composerOpen]);

  // ── Outside-click closes composer ─────────────────────────────────────────
  useEffect(() => {
    if (!composerOpen) return;
    const handle = (e: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(e.target as Node)) {
        setComposerOpen(false);
        setBody('');
        setPending(null);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [composerOpen]);

  // ── Save handler ─────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!pending || submitting) return;
    setSubmitting(true);
    try {
      const r = await addComment({
        body,
        anchor: pending.anchor,
        versionId: currentVersionId,
        contentForSnapshot: subjectContent,
      });
      if (!r) {
        toast.error(t('plans.comment_save_failed'));
        return;
      }
      // Focus the newly-created comment so the user sees it pop into the
      // side panel with the active ring + matching bright highlight.
      setActiveCommentId(r.id);
      setComposerOpen(false);
      setBody('');
      setPending(null);
      // Clear native selection so the trigger doesn't immediately re-show.
      window.getSelection()?.removeAllRanges();
    } finally {
      setSubmitting(false);
    }
  }, [pending, submitting, addComment, body, currentVersionId, subjectContent, t]);

  // Quoted preview shown above the textarea (so the user remembers what they
  // selected if the selection got cleared by the click).
  const quoteSnippet = useMemo(() => {
    if (!pending) return '';
    const q = pending.anchor.quote;
    return q.length > 80 ? q.slice(0, 77) + '…' : q;
  }, [pending]);

  if (disabled || !pending) return null;

  // Clamp into viewport so the bubble doesn't get cut off near the edges.
  const COMPOSER_W = composerOpen ? 320 : 120;
  const COMPOSER_H = composerOpen ? 180 : 32;
  const x = Math.min(window.innerWidth - COMPOSER_W - 8, Math.max(8, pending.x));
  const y = Math.min(window.innerHeight - COMPOSER_H - 8, pending.y + 6);

  return createPortal(
    <div
      ref={composerRef}
      style={{ position: 'fixed', left: x, top: y, zIndex: 70 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {!composerOpen ? (
        <button
          onMouseDown={(e) => {
            // Prevent Monaco from collapsing the selection on mousedown.
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => setComposerOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1.5 text-xs font-medium text-foreground shadow-md hover:bg-muted transition-colors"
        >
          <MessageSquarePlus size={13} />
          <span>{t('plans.comment_button')}</span>
        </button>
      ) : (
        <div className="w-80 rounded-md border border-border bg-popover p-2 shadow-lg">
          <div className="border-l-2 border-primary/50 pl-2 mb-2 text-[11px] italic text-muted-foreground line-clamp-2">
            "{quoteSnippet}"
          </div>
          <Textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                handleSave();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setComposerOpen(false);
                setBody('');
                setPending(null);
              }
            }}
            placeholder={t('plans.comment_placeholder')}
            className="text-xs resize-none h-20"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setComposerOpen(false);
                setBody('');
                setPending(null);
              }}
            >
              {t('plans.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={handleSave}
              disabled={!body.trim() || submitting}
            >
              {t('plans.save_comment')}
            </Button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
