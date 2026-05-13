# View-Mode Comments — Source-Position Fix

**Date:** 2026-05-13
**Components:** `src/components/plans/InlineCommentTrigger.tsx`, `src/components/plans/useAnchorHighlights.ts`, `src/components/PlannerTab.tsx`, new `src/lib/plans/rehype-source-positions.ts`

## Problem

Two user-visible defects in view mode:

1. **Intermittent "Comentar" trigger.** Selecting text in the rendered preview shows the comment bubble for some selections but not others.
2. **Missing anchor highlights.** Comments created on text that contains any markdown formatting never paint a `<mark>` overlay in view mode, even though `useViewModeAnchorHighlights` runs.

## Root cause

Both defects share one cause: the view-mode logic compares **rendered DOM text** against the **raw markdown source**, but they diverge whenever inline formatting is present.

- Source: `**Lorem** ipsum`
- DOM text content: `Lorem ipsum`

Specifically:

- `InlineCommentTrigger.tsx:146` does `findAnchor(subjectContent, { quote: sel.toString(), prefix: null, suffix: null })`. `findAnchor` returns `null` when the selection's plain text doesn't appear verbatim in `subjectContent`. → trigger hidden.
- `useAnchorHighlights.ts:206` does `text.includes(c.anchorQuote!)` over each DOM text node. The stored quote is a slice of the source (so it carries the `**`, `*`, `[label](url)`, etc.); the text node is rendered output without those markers. → no wrap.

Both code paths assume `subjectContent === DOM.textContent`. That's only true for selections that touch no inline formatting and no block markers (bullets, heading prefixes).

## Goal

Make the view-mode commenting surface as reliable as the edit-mode one:

- Selection in the preview → always offers the comment trigger when the selection produces a non-empty source range.
- Existing anchors → always paint a `<mark>` overlay where the source range maps in the rendered DOM, regardless of formatting crossed.
- No schema change. Existing comment rows keep working.

## Approach

Annotate every rendered DOM text node with its **source byte range** via a rehype plugin running after `remark-gfm`. With those data attributes in place, both selection-to-source resolution and source-to-DOM range mapping become local DOM walks.

### Why this approach

- **Single source of truth.** Source offsets are the only representation; DOM is a derivable view.
- **Schema-stable.** `anchorQuote/Prefix/Suffix` stays as-is; resolution still uses `findAnchor`.
- **Edit mode unchanged.** Monaco decorations already use source offsets — no touch.
- **No remark/rehype refactor.** The plugin is additive; everything else in the render pipeline is untouched.

## Components

### 1. `src/lib/plans/rehype-source-positions.ts` (new)

A tiny rehype plugin that walks the hast tree and wraps every text node in a `<span class="notter-src" data-src-start="N" data-src-end="M">`, where N/M are the byte offsets carried on `node.position.start.offset` / `position.end.offset` (preserved by `remark-rehype` by default).

```ts
import type { Root, Text, Element } from 'hast';
import { visit } from 'unist-util-visit';

export function rehypeSourcePositions() {
  return (tree: Root) => {
    visit(tree, 'text', (node: Text, index, parent) => {
      const pos = (node as any).position;
      if (!pos || index == null || !parent) return;
      const wrap: Element = {
        type: 'element',
        tagName: 'span',
        properties: {
          className: ['notter-src'],
          'data-src-start': String(pos.start.offset),
          'data-src-end': String(pos.end.offset),
        },
        children: [node],
      };
      (parent.children as any[])[index] = wrap;
    });
  };
}
```

Wire into the existing ReactMarkdown call in `PlannerTab.tsx:730`:

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  rehypePlugins={[rehypeSourcePositions]}
>
  {editorValue}
</ReactMarkdown>
```

The `.notter-src` span is visually invisible (no CSS; behaves as inline text). Its sole purpose is carrying data attributes.

### 2. Range → source offsets resolver (new helper)

Added to `useAnchorHighlights.ts` (or a small `src/lib/plans/dom-source-range.ts` if it grows):

```ts
function rangeToSourceOffsets(
  range: Range,
  container: HTMLElement,
): { start: number; end: number } | null {
  function resolveEnd(node: Node, offset: number, which: 'start' | 'end'): number | null {
    if (node.nodeType === Node.TEXT_NODE) {
      const span = (node.parentElement as HTMLElement | null);
      if (!span || !span.dataset.srcStart) return null;
      return Number(span.dataset.srcStart) + offset;
    }
    // Element container: offset indexes children. Use the nth child's start,
    // or the prior child's end if offset === childCount.
    const el = node as Element;
    // For start: take first descendant .notter-src of child at offset
    // For end: take last descendant .notter-src of child at offset-1
    const target = which === 'start' && offset < el.childNodes.length
      ? el.childNodes[offset]
      : (offset > 0 ? el.childNodes[offset - 1] : null);
    if (!(target instanceof HTMLElement)) return null;
    const spans = target.classList.contains('notter-src')
      ? [target]
      : Array.from(target.querySelectorAll('.notter-src'));
    if (spans.length === 0) return null;
    const span = which === 'start' ? spans[0] : spans[spans.length - 1];
    const attr = which === 'start' ? span.dataset.srcStart : span.dataset.srcEnd;
    return attr != null ? Number(attr) : null;
  }
  if (!container.contains(range.commonAncestorContainer)) return null;
  const start = resolveEnd(range.startContainer, range.startOffset, 'start');
  const end = resolveEnd(range.endContainer, range.endOffset, 'end');
  if (start == null || end == null || end <= start) return null;
  return { start, end };
}
```

The element-offset branch is the trickiest part (when selection boundaries land between children, not inside a text node). Strategy: look at the child at `offset` for its start, or the child at `offset-1` for its end. Walk into descendant `.notter-src` to find the first/last span if the immediate child isn't one.

### 3. `InlineCommentTrigger.tsx` view-mode handler (rewrite)

Replace the existing `findAnchor`-based block (lines 121-169) with:

```ts
const range = sel.getRangeAt(0);
const container = previewContainerRef.current;
if (!container) return;
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
setPending({ anchor, x: rect.right, y: rect.bottom });
```

Result: selection in view mode produces the **same** kind of anchor as in edit mode (source-flavored quote, prefix/suffix from source), and the trigger appears whenever the selection has a valid source range.

### 4. `useViewModeAnchorHighlights` (rewrite the wrap pass, lines 177-224)

New algorithm:

1. Unwrap all prior `<mark.notter-anchor-highlight>` and normalize (unchanged).
2. Resolve every eligible comment to source offsets via `findAnchor(subjectContent, anchor)` (already done elsewhere; we'll lift the result via `useResolvedHighlights`).
3. For each resolved `{ start, end, commentId }`:
   1. Query all `.notter-src` spans inside the container whose `[data-src-start, data-src-end)` interval **overlaps** `[start, end)`.
   2. For each overlapping span, compute the slice of its text node corresponding to the overlap:
      - `localStart = max(0, start - spanStart)`
      - `localEnd = min(spanLen, end - spanStart)`
      - Split the text node at `localStart` and `localEnd`; wrap the middle piece in `<mark class="notter-anchor-highlight" data-comment-id={commentId}>`.
4. Re-apply the active variant class for `activeCommentId`.

Multi-span selections (anchor spans several formatted regions) get multiple `<mark>` fragments, all sharing the same `data-comment-id` — the click delegation already handles that.

### 5. `previewContainerRef` lifetime

The ref already exists (`PlannerTab.tsx:727`) and is wired to both `InlineCommentTrigger` and `useViewModeAnchorHighlights`. No change needed.

## Edge cases

| Case | Behavior |
|---|---|
| Selection entirely inside one text node (e.g., plain prose) | Single `.notter-src` ancestor; resolver returns its start + offset. Works. |
| Selection crosses `**bold**` | Range spans two adjacent text nodes (one inside `<strong>`, one outside), each in its own `.notter-src`. Resolver picks up each end. Source range covers the source bytes including the `**` markers. Anchor stores the source slice (with `**`). On re-render, highlight wraps both spans. |
| Selection across block boundaries (paragraph → heading) | Source range spans both blocks (including the inter-block newlines). Anchor stored. Highlight paints in both rendered blocks. |
| Markdown escape (`\*`) | Source has 2 chars, mdast text node has 1 char. Span's data-src-start/end reflects source length (2), text node length is 1. Mapping math is off by 1 for any selection that crosses an escape. **Documented limitation**, not a regression. |
| Code blocks | Text nodes inside `<pre><code>` get wrapped too (the rehype plugin doesn't discriminate). Commenting in code blocks works the same way. |
| Existing comments with formatting-bearing quotes | Still resolved via `findAnchor` (unchanged). Now also paint correctly because the resolver no longer requires text-node containment. |
| Existing comments anchored to text that no longer exists | `findAnchor` returns `null` → auto-archive after 1.5s (existing behavior, unchanged). |
| Selection collapses to nothing (cursor click) | `range.isCollapsed` short-circuits earlier; resolver never runs. |
| Selection bridges out of the preview container | `container.contains(range.commonAncestorContainer)` is false → resolver returns `null` → trigger stays hidden. |

## Test plan

Manual checks against the running Tauri app, with a subject that has a mix of formatting:

```
Hello **bold** world.

Plain second paragraph.

## A heading

- item one
- item *two* with emphasis
```

1. Edit mode → select "bold" in the source → comment → save. View mode → "bold" is highlighted in `<mark>` inside the rendered `<strong>`.
2. View mode → select "Hello bold world" (across the `<strong>`). Trigger appears. Save comment. Refresh. Highlight shows over both the "Hello " and "bold" and " world" runs.
3. View mode → select "*two*"'s rendered text ("two") inside the `<em>`. Trigger appears. Save. Highlight shows over the rendered emphasis text.
4. View mode → select the heading text. Trigger appears. Save. Highlight paints on the heading.
5. View mode → select across two paragraphs (paragraph 1 end → paragraph 2 start). Trigger appears. Source range spans the inter-paragraph blank line. Highlight paints two fragments.
6. View mode → click somewhere with no selection. No trigger (existing behavior preserved).
7. Existing comment on plain text → still highlights and clicking still focuses card.
8. Existing comment on `**bold**` whose anchorQuote contains `**` → still resolves via `findAnchor`, now also paints over the `<strong>` text.

## Out of scope

- **Escapes (`\*`, `\_`)** — off-by-N when the selection crosses an escape. Document; fix later if it bites.
- **Selection of generated content** — e.g., the `>` rendered for blockquotes. Rendered nodes that have no source position (synthetic) will not be inside a `.notter-src` and will resolve to `null`. Acceptable.
- **Performance on huge documents** — the rehype plugin runs once per `editorValue` change; the highlight pass already runs on every comments/active change. No perf issue expected at typical plan sizes (< 10k chars); revisit only if profiling flags it.
- **Tests** — none added in v1 (consistent with current absence of unit tests for `useAnchorHighlights`). Manual test plan above is the v1 verification surface.

## Risks

- **Selection rendering inside a `.notter-src` span.** Browsers render the span as inline non-styled content; user shouldn't notice. If a future style rule accidentally targets the span, selection geometry could shift by ~0px. Cheap to audit (no CSS on `.notter-src`).
- **TreeWalker is no longer used.** New algorithm uses `querySelectorAll('.notter-src')` plus overlap math. Simpler but a different shape from the existing code — review the wrap pass carefully.

## Effort

~150–200 lines of new/changed code across 4 files. Single-session implementation.
