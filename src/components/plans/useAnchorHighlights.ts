// src/components/plans/useAnchorHighlights.ts
//
// Resolves comment anchors against the current draft and side-effects the
// highlight overlays:
//   • Edit mode  → Monaco deltaDecorations (incl. the active variant when
//                  the user clicks an anchored region; clears + re-applies on
//                  every comments / activeCommentId change).
//   • View mode  → wraps matching text nodes in the preview container with
//                  <mark class="notter-anchor-highlight" data-comment-id>.
//                  Container click → setActiveCommentId(<id>).
//
// Also auto-archives any comment whose anchor can't be located in the
// current draft anymore, so orphaned highlights silently disappear from
// both surfaces (the comment row stays in Supabase for AI context).
import { useEffect, useRef } from 'react';
import { useSubjectVersionsStore } from '@/stores/subject-versions-store';
import { usePlannerStore } from '@/stores/planner-store';
import { findAnchor } from '@/lib/plans/anchor';

export interface ResolvedHighlight {
  commentId: string;
  start: number;
  end: number;
}

/**
 * Compute live anchor ranges from the current comments slice + draft content.
 * Returns the list and (as a side effect) auto-archives orphans on the store.
 */
function useResolvedHighlights(): ResolvedHighlight[] {
  const subjectContent = usePlannerStore((s) => s.subjectContent);
  const comments = useSubjectVersionsStore((s) => s.comments);
  const setCommentArchived = useSubjectVersionsStore((s) => s.setCommentArchived);

  const resolved: ResolvedHighlight[] = [];
  const orphans: string[] = [];
  for (const c of comments) {
    if (c.resolved || c.archived) continue;
    if (!c.anchorQuote) continue;
    const r = findAnchor(subjectContent, {
      quote: c.anchorQuote,
      prefix: c.anchorPrefix,
      suffix: c.anchorSuffix,
    });
    if (r) resolved.push({ commentId: c.id, start: r.start, end: r.end });
    else orphans.push(c.id);
  }

  useEffect(() => {
    if (orphans.length === 0) return;
    const t = setTimeout(() => {
      for (const id of orphans) setCommentArchived(id, true);
    }, 1500);
    return () => clearTimeout(t);
  }, [orphans.join(','), setCommentArchived]);

  return resolved;
}

/**
 * Apply Monaco decorations for non-archived anchored comments. Also wires a
 * mousedown listener so clicks inside an anchored region focus the
 * corresponding comment card. No-op while monacoEditor is null.
 */
export function useMonacoAnchorHighlights(monacoEditor: any | null) {
  const highlights = useResolvedHighlights();
  const activeCommentId = useSubjectVersionsStore((s) => s.activeCommentId);
  const setActiveCommentId = useSubjectVersionsStore((s) => s.setActiveCommentId);
  const decorationIdsRef = useRef<string[]>([]);
  const highlightsRef = useRef<ResolvedHighlight[]>([]);

  // Keep the latest resolved ranges around for the mousedown handler. We
  // can't close over `highlights` directly because the listener registers
  // once per editor mount.
  useEffect(() => {
    highlightsRef.current = highlights;
  }, [highlights]);

  // Apply / refresh decorations whenever resolution changes or the active
  // selection changes (active variant gets a different class).
  useEffect(() => {
    if (!monacoEditor) return;
    const monacoNs: any = (window as any).monaco;
    if (!monacoNs) return;
    const model = monacoEditor.getModel();
    if (!model) return;

    const decorations = highlights.map((h) => {
      const startPos = model.getPositionAt(h.start);
      const endPos = model.getPositionAt(h.end);
      const isActive = h.commentId === activeCommentId;
      return {
        range: new monacoNs.Range(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column,
        ),
        options: {
          className: isActive
            ? 'notter-anchor-highlight notter-anchor-highlight-active'
            : 'notter-anchor-highlight',
          stickiness: 1,
          hoverMessage: { value: '💬 anchored comment' },
        },
      };
    });

    decorationIdsRef.current = monacoEditor.deltaDecorations(
      decorationIdsRef.current,
      decorations,
    );
  }, [monacoEditor, highlights, activeCommentId]);

  // Mousedown → if the click position falls inside an anchored range, focus
  // that comment card (and the active variant of the highlight). Listener
  // registers once per editor instance; reads `highlightsRef` for live data.
  useEffect(() => {
    if (!monacoEditor) return;
    const dispose = monacoEditor.onMouseDown((e: any) => {
      const pos = e.target?.position;
      if (!pos) return;
      const model = monacoEditor.getModel();
      if (!model) return;
      const offset = model.getOffsetAt(pos);
      // Smallest range wins on overlap so tightly-anchored comments take
      // precedence over broader ones encompassing them.
      let best: ResolvedHighlight | null = null;
      let bestLen = Infinity;
      for (const h of highlightsRef.current) {
        if (offset >= h.start && offset < h.end) {
          const len = h.end - h.start;
          if (len < bestLen) {
            best = h;
            bestLen = len;
          }
        }
      }
      if (best) setActiveCommentId(best.commentId);
    });
    return () => dispose.dispose();
  }, [monacoEditor, setActiveCommentId]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (monacoEditor && decorationIdsRef.current.length > 0) {
        try {
          monacoEditor.deltaDecorations(decorationIdsRef.current, []);
        } catch {
          // editor already disposed
        }
      }
    };
  }, [monacoEditor]);
}

/**
 * Apply <mark>-wrapped highlights to the rendered markdown container. Each
 * mark gets `data-comment-id`; clicks bubble to a delegated listener on the
 * container that focuses the corresponding comment card.
 *
 * Resolution: every eligible comment's anchor is located in the current
 * subjectContent via findAnchor (returning source byte offsets), then mapped
 * to DOM via the `.notter-src` spans injected by rehype-source-positions.
 * Anchors that span multiple text nodes (e.g., crossing **bold**) get one
 * <mark> per overlapping span, all sharing the same data-comment-id.
 */
export function useViewModeAnchorHighlights(
  containerRef: React.RefObject<HTMLDivElement | null>,
  /** Render-cycle key — pass `subjectContent` so re-renders re-apply marks. */
  contentKey: string,
) {
  const subjectContent = usePlannerStore((s) => s.subjectContent);
  const comments = useSubjectVersionsStore((s) => s.comments);
  const activeCommentId = useSubjectVersionsStore((s) => s.activeCommentId);
  const setActiveCommentId = useSubjectVersionsStore((s) => s.setActiveCommentId);

  // Apply <mark> wrapping. Re-runs whenever content / comments / active id
  // change so the active variant repaints without needing a full rerender.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    // Step 1: unwrap any previous marks. The `.notter-src` spans wrapping
    // each text node are owned by rehype-source-positions and stay put —
    // we only undo the <mark> layer we added on top.
    root.querySelectorAll('mark.notter-anchor-highlight').forEach((m) => {
      const txt = document.createTextNode(m.textContent ?? '');
      m.replaceWith(txt);
    });
    root.normalize();

    // Step 2: resolve eligible comments to source byte ranges.
    type Resolved = { id: string; start: number; end: number; isActive: boolean };
    const ranges: Resolved[] = [];
    for (const c of comments) {
      if (c.resolved || c.archived || !c.anchorQuote) continue;
      const r = findAnchor(subjectContent, {
        quote: c.anchorQuote,
        prefix: c.anchorPrefix,
        suffix: c.anchorSuffix,
      });
      if (!r) continue;
      ranges.push({
        id: c.id,
        start: r.start,
        end: r.end,
        isActive: c.id === activeCommentId,
      });
    }
    if (ranges.length === 0) return;

    // Step 3: for each .notter-src span, find overlapping ranges and split
    // the text node into fragments, wrapping the overlapping slices in
    // <mark>.
    const spans = Array.from(root.querySelectorAll<HTMLElement>('.notter-src'));
    for (const span of spans) {
      const spanStart = Number(span.getAttribute('data-src-start'));
      const spanEnd = Number(span.getAttribute('data-src-end'));
      if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd)) continue;
      const textNode = span.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
      const nodeText = textNode.nodeValue ?? '';
      const nodeLen = nodeText.length;
      if (nodeLen === 0) continue;

      const overlaps = ranges
        .map((r) => {
          const oStart = Math.max(r.start, spanStart);
          const oEnd = Math.min(r.end, spanEnd);
          if (oEnd <= oStart) return null;
          return {
            id: r.id,
            isActive: r.isActive,
            localStart: Math.max(0, oStart - spanStart),
            localEnd: Math.min(nodeLen, oEnd - spanStart),
          };
        })
        .filter((x): x is { id: string; isActive: boolean; localStart: number; localEnd: number } => x !== null)
        .sort((a, b) => a.localStart - b.localStart);

      if (overlaps.length === 0) continue;

      // Rebuild span content as alternating text fragments and <mark>s.
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const ov of overlaps) {
        if (ov.localStart > cursor) {
          frag.appendChild(document.createTextNode(nodeText.slice(cursor, ov.localStart)));
        }
        const mark = document.createElement('mark');
        mark.className = ov.isActive
          ? 'notter-anchor-highlight notter-anchor-highlight-active'
          : 'notter-anchor-highlight';
        mark.setAttribute('data-comment-id', ov.id);
        mark.textContent = nodeText.slice(ov.localStart, ov.localEnd);
        frag.appendChild(mark);
        cursor = ov.localEnd;
      }
      if (cursor < nodeLen) {
        frag.appendChild(document.createTextNode(nodeText.slice(cursor)));
      }
      span.replaceChild(frag, textNode);
    }
  }, [containerRef, contentKey, subjectContent, comments, activeCommentId]);

  // Delegated click handler — set active when the user clicks anywhere on
  // a highlighted span. Registers once per container.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const handler = (e: MouseEvent) => {
      let el = e.target as HTMLElement | null;
      // Walk up a few levels in case the click landed on a nested inline node.
      for (let i = 0; el && i < 4; i++, el = el.parentElement) {
        const id = el.getAttribute?.('data-comment-id');
        if (id) {
          setActiveCommentId(id);
          return;
        }
      }
    };
    root.addEventListener('click', handler);
    return () => root.removeEventListener('click', handler);
  }, [containerRef, setActiveCommentId]);
}
