# View-Mode Comments Source-Position Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make view-mode commenting and anchor highlights reliable by routing the resolution through source byte offsets — fixing the intermittent "Comentar" trigger and the missing-highlights-on-formatted-text issues.

**Architecture:** A new rehype plugin wraps every rendered text node in a `<span class="notter-src" data-src-start data-src-end>`. A helper resolves DOM Range ↔ source offsets via those data-attrs. `InlineCommentTrigger`'s view-mode handler and `useViewModeAnchorHighlights`'s wrap pass switch to source-offset–based logic. Edit mode and the comment schema are untouched.

**Tech Stack:** TypeScript, React 19, react-markdown 10, remark-gfm, rehype (manual hast traversal), Monaco editor, Vite/Tauri, Tailwind `prose`.

**Note on tests:** Per the spec, no automated tests are added in v1 (matches the absence of vitest coverage for `useAnchorHighlights` today). Each task has a **manual verify** step using the running Tauri dev session. The implementer should keep the app open in view mode on a subject with mixed formatting throughout.

**Atomic delivery:** Single commit at the end of Task 7 covering all changes. Do not commit intermediate tasks.

---

## Task 1: Create the rehype plugin

**Files:**
- Create: `src/lib/plans/rehype-source-positions.ts`

- [ ] **Step 1: Write the plugin**

Manual hast traversal (no new dep — avoids adding `unist-util-visit`):

```ts
// src/lib/plans/rehype-source-positions.ts
//
// Rehype plugin: wraps every hast text node in a
// `<span class="notter-src" data-src-start data-src-end>` carrying the byte
// offsets of that text in the original markdown source. Used by view-mode
// commenting + highlighting to round-trip selections through the source
// without doing fuzzy text matching.
//
// remark-rehype preserves `node.position` on hast nodes by default; we copy
// `position.start.offset` / `position.end.offset` onto the wrapper element.

import type { Root, Element, RootContent, ElementContent } from 'hast';

export function rehypeSourcePositions() {
  return (tree: Root) => {
    visit(tree as unknown as Element);
  };
}

function visit(node: Element | Root): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;
  // Iterate a snapshot so in-place replacement doesn't break the loop.
  const children = node.children as Array<RootContent | ElementContent>;
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as any;
    if (child.type === 'text' && child.position) {
      const start = child.position.start?.offset;
      const end = child.position.end?.offset;
      if (typeof start !== 'number' || typeof end !== 'number') continue;
      const wrap: Element = {
        type: 'element',
        tagName: 'span',
        properties: {
          className: ['notter-src'],
          'data-src-start': String(start),
          'data-src-end': String(end),
        },
        children: [child],
      };
      (node.children as any[])[i] = wrap;
    } else if (child.type === 'element') {
      visit(child as Element);
    }
  }
}
```

- [ ] **Step 2: Manual verify (compile)**

Save and confirm Vite HMR picks it up with no TS errors. Watch the dev-server output for the next file change.

---

## Task 2: Wire the plugin into ReactMarkdown

**Files:**
- Modify: `src/components/PlannerTab.tsx:730` (the `<ReactMarkdown>` call)
- Modify: `src/components/PlannerTab.tsx` imports

- [ ] **Step 1: Add import**

Near the top of `PlannerTab.tsx` (the other `@/lib/plans/*` imports already live in the imports block — group with them):

```ts
import { rehypeSourcePositions } from '@/lib/plans/rehype-source-positions';
```

- [ ] **Step 2: Pass to ReactMarkdown**

Change line 730 from:

```tsx
<ReactMarkdown remarkPlugins={[remarkGfm]}>{editorValue}</ReactMarkdown>
```

to:

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeSourcePositions]}
>
  {editorValue}
</ReactMarkdown>
```

- [ ] **Step 3: Manual verify (DevTools)**

In the running Tauri app: switch to view mode on any subject. Right-click any rendered text → Inspect. Confirm the text node is wrapped in `<span class="notter-src" data-src-start="N" data-src-end="M">` where N and M are byte offsets into the markdown source.

Expected: every visible piece of text in the preview lives inside a `.notter-src` span. The span is visually invisible (no CSS).

---

## Task 3: Add the DOM-range → source-range helper

**Files:**
- Create: `src/lib/plans/dom-source-range.ts`

- [ ] **Step 1: Write the helper**

```ts
// src/lib/plans/dom-source-range.ts
//
// Convert a DOM Range living inside the view-mode preview container into
// source byte offsets. Relies on the `.notter-src` spans injected by
// rehype-source-positions: every rendered text node is wrapped in a span
// whose `data-src-start` / `data-src-end` carry its byte range in the
// original markdown source.

export interface SourceRange {
  start: number;
  end: number;
}

export function rangeToSourceOffsets(
  range: Range,
  container: HTMLElement,
): SourceRange | null {
  if (!container.contains(range.commonAncestorContainer)) return null;
  const start = resolveEndpoint(range.startContainer, range.startOffset, 'start');
  const end = resolveEndpoint(range.endContainer, range.endOffset, 'end');
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}

function resolveEndpoint(
  node: Node,
  offset: number,
  which: 'start' | 'end',
): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const span = node.parentElement;
    if (!span || !span.classList.contains('notter-src')) return null;
    const base = Number(span.getAttribute('data-src-start'));
    if (!Number.isFinite(base)) return null;
    return base + offset;
  }
  // Element container: `offset` indexes children. Walk to the nearest
  // .notter-src descendant of the relevant child.
  if (!(node instanceof HTMLElement)) return null;
  const targetIndex = which === 'start' && offset < node.childNodes.length
    ? offset
    : (offset > 0 ? offset - 1 : -1);
  if (targetIndex < 0) return null;
  const target = node.childNodes[targetIndex];
  if (!(target instanceof HTMLElement)) return null;
  const spans = target.classList.contains('notter-src')
    ? [target]
    : Array.from(target.querySelectorAll<HTMLElement>('.notter-src'));
  if (spans.length === 0) return null;
  const span = which === 'start' ? spans[0] : spans[spans.length - 1];
  const attr = which === 'start'
    ? span.getAttribute('data-src-start')
    : span.getAttribute('data-src-end');
  if (attr == null) return null;
  const v = Number(attr);
  return Number.isFinite(v) ? v : null;
}
```

- [ ] **Step 2: Manual verify (compile)**

Save, watch for TS errors in the dev server. No runtime behavior change yet.

---

## Task 4: Rewrite view-mode handler in InlineCommentTrigger

**Files:**
- Modify: `src/components/plans/InlineCommentTrigger.tsx:20` (imports)
- Modify: `src/components/plans/InlineCommentTrigger.tsx:122-169` (view-mode useEffect)

- [ ] **Step 1: Update imports**

Change line 20 from:

```ts
import { buildAnchorFromSelection, findAnchor } from '@/lib/plans/anchor';
```

to:

```ts
import { buildAnchorFromSelection } from '@/lib/plans/anchor';
import { rangeToSourceOffsets } from '@/lib/plans/dom-source-range';
```

(Remove the now-unused `findAnchor` import.)

- [ ] **Step 2: Replace the view-mode useEffect body**

Replace lines 122-169 (the entire `useEffect` block for view-mode selection) with:

```tsx
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
```

- [ ] **Step 3: Manual verify**

In the Tauri app, view mode on a subject containing **bold**, *italic*, headings, lists. Select:
- Plain prose ("Lorem ipsum") → trigger appears ✓
- Across a `**bold**` span → trigger appears ✓ (used to fail)
- Inside a heading → trigger appears ✓
- Inside a list item → trigger appears ✓

Don't save comments yet — just confirm the trigger surfaces. If it doesn't, check DevTools for the `.notter-src` parent of the text node and the resolved offsets.

---

## Task 5: Rewrite wrap pass in useViewModeAnchorHighlights

**Files:**
- Modify: `src/components/plans/useAnchorHighlights.ts:166-225` (the entire `useViewModeAnchorHighlights` function)

- [ ] **Step 1: Replace the function**

Replace lines 166-225 with:

```ts
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
```

- [ ] **Step 2: Verify the orphan-archive logic still runs**

The `useResolvedHighlights` hook at the top of the file (used by `useMonacoAnchorHighlights`) is what auto-archives orphans. The view-mode hook above doesn't call it, but `useMonacoAnchorHighlights` does — and that hook ALWAYS runs in `PlannerTab` (line 234), even while in view mode (the Monaco editor unmounts on isViewing but the hook still subscribes to the store). Since the hook side-effects via store mutations, archiving still works regardless of which mode is showing.

No code change in this step — just a sanity note that the rewrite doesn't regress orphan handling.

- [ ] **Step 3: Manual verify**

With existing comments already in the DB on a subject:

1. Switch to view mode. Confirm comments anchored on plain text show `<mark>` overlays.
2. Confirm comments anchored on **bold** / *italic* / list / heading text ALSO show overlays (this used to be broken).
3. Click an overlay → the corresponding comment card in the side panel gains the active ring; the overlay darkens.
4. Click a different overlay → focus switches.
5. Create a new comment in view mode (select formatted text, fill the composer, save) → the new mark appears immediately at the selection.

---

## Task 6: Smoke test against the spec's test plan

**Files:** none

- [ ] **Step 1: Run through the spec's manual test plan**

With a subject containing:

```
Hello **bold** world.

Plain second paragraph.

## A heading

- item one
- item *two* with emphasis
```

Verify each of the 8 cases in `docs/superpowers/specs/2026-05-13-view-mode-comments-fix-design.md#test-plan`. If any fails, debug before committing.

- [ ] **Step 2: Run the type-check / build**

```powershell
& "C:\Users\Guilherme\AppData\Roaming\fnm\node-versions\v24.15.0\installation\pnpm.cmd" build
```

Expected: build succeeds. If TS errors surface, fix them before committing.

If the Tauri dev session is still hot and shows no console errors, the build mainly catches type regressions in files not actively rendered.

---

## Task 7: Commit (single atomic commit)

**Files:** all of the above.

- [ ] **Step 1: Stage**

```bash
git add src/lib/plans/rehype-source-positions.ts src/lib/plans/dom-source-range.ts src/components/PlannerTab.tsx src/components/plans/InlineCommentTrigger.tsx src/components/plans/useAnchorHighlights.ts
```

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(planner): reliable view-mode comments via source-offset round-trip

Wrap every rendered markdown text node in `<span class="notter-src">`
carrying its source byte offsets (new rehype plugin). View-mode selection
and the highlight wrap pass now resolve via those offsets instead of
fuzzy-matching DOM text against the markdown source, which fixes the
intermittent "Comentar" trigger and the never-painting highlights on
formatted text. Edit mode and the comment schema are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Confirm clean tree**

```bash
git status
```

Expected: "nothing to commit, working tree clean".
