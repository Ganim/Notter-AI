// src/components/plans/useAnchorHighlights.ts
//
// Resolves comment anchors against the current draft and side-effects the
// highlight overlays:
//   • Edit mode  → Monaco deltaDecorations.
//   • View mode  → wraps matching text nodes in the preview container
//                  with <mark class="notter-anchor-highlight">.
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

  // Resolution result + a debounce-friendly handle for archive sweeps.
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

  // Side-effect archiving — debounced so a transient typing dip (user
  // mid-edit deleting then re-typing) doesn't immediately archive.
  useEffect(() => {
    if (orphans.length === 0) return;
    const t = setTimeout(() => {
      for (const id of orphans) setCommentArchived(id, true);
    }, 1500);
    return () => clearTimeout(t);
    // The deps drive when the timer arms; we re-evaluate orphans every
    // render and only commit if they've stayed orphaned for ≥ debounce.
  }, [orphans.join(','), setCommentArchived]);

  return resolved;
}

/**
 * Apply Monaco decorations for non-archived anchored comments. No-op while
 * monacoEditor is null (editor not mounted yet).
 */
export function useMonacoAnchorHighlights(monacoEditor: any | null) {
  const highlights = useResolvedHighlights();
  const decorationIdsRef = useRef<string[]>([]);

  useEffect(() => {
    if (!monacoEditor) return;
    const monacoNs: any = (window as any).monaco;
    if (!monacoNs) return;
    const model = monacoEditor.getModel();
    if (!model) return;

    const decorations = highlights.map((h) => {
      const startPos = model.getPositionAt(h.start);
      const endPos = model.getPositionAt(h.end);
      return {
        range: new monacoNs.Range(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column,
        ),
        options: {
          className: 'notter-anchor-highlight',
          stickiness: 1, // grows-with-edits-on-both-sides
          hoverMessage: { value: '💬 anchored comment' },
        },
      };
    });

    decorationIdsRef.current = monacoEditor.deltaDecorations(
      decorationIdsRef.current,
      decorations,
    );
  }, [monacoEditor, highlights]);

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
 * Apply <mark>-wrapped highlights to the rendered markdown container.
 * Skips anchors whose quote doesn't survive within a single text node
 * (e.g. spans markdown formatting) — the comment card still renders in the
 * side panel, just without an overlay.
 *
 * Re-runs whenever `subjectContent` (proxy for re-render) or comments change.
 */
export function useViewModeAnchorHighlights(
  containerRef: React.RefObject<HTMLDivElement | null>,
  /** Render-cycle key — pass `subjectContent` so re-renders re-apply marks. */
  contentKey: string,
) {
  const comments = useSubjectVersionsStore((s) => s.comments);
  // Only render highlights for comments that resolved in the source. We don't
  // re-use useResolvedHighlights here because it works on source offsets;
  // view-mode highlighting needs the *quote* to live inside a single rendered
  // text node, which is a different (stricter) filter applied per node.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    // Step 1: unwrap any <mark.notter-anchor-highlight> from a previous run
    // so we always start from a clean DOM. ReactMarkdown's re-render usually
    // takes care of this, but when only `comments` changed it doesn't.
    root
      .querySelectorAll('mark.notter-anchor-highlight')
      .forEach((m) => {
        const txt = document.createTextNode(m.textContent ?? '');
        m.replaceWith(txt);
      });
    // After replacing nodes, sibling text nodes may be adjacent — `normalize`
    // merges them so quote searches don't get split across boundaries.
    root.normalize();

    const quotes = comments
      .filter((c) => !c.resolved && !c.archived && c.anchorQuote)
      .map((c) => c.anchorQuote!) as string[];
    if (quotes.length === 0) return;

    // Step 2: walk text nodes and wrap the first occurrence of each quote
    // that lives entirely inside a single text node.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
      targets.push(node as Text);
      node = walker.nextNode();
    }

    for (const tn of targets) {
      const text = tn.nodeValue ?? '';
      if (!text) continue;
      const hit = quotes.find((q) => text.includes(q));
      if (!hit) continue;
      const idx = text.indexOf(hit);
      const before = text.slice(0, idx);
      const after = text.slice(idx + hit.length);
      const mark = document.createElement('mark');
      mark.className = 'notter-anchor-highlight';
      mark.textContent = hit;
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(mark);
      if (after) frag.appendChild(document.createTextNode(after));
      tn.replaceWith(frag);
    }
    // Effect re-runs whenever `contentKey` (markdown source) or comments
    // change. ReactMarkdown re-renders the container, blowing away our
    // <mark> nodes; we re-apply on top of the fresh DOM.
  }, [containerRef, contentKey, comments]);
}
