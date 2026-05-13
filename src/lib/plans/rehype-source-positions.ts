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
import type { VFile } from 'vfile';

export function rehypeSourcePositions() {
  return (tree: Root, file?: VFile) => {
    const source = String(file?.value ?? '');
    visit(tree as unknown as Element, source);
  };
}

/** Mutable cursor passed down through synthetic descendants of a positioned
    ancestor (e.g., the hljs token spans inside a code block). Tracks how far
    we've consumed within `[anchorStart, anchorEnd)` so repeated token values
    map to their actual positions in the source. */
interface SearchCursor {
  anchorStart: number;
  anchorEnd: number;
  pos: number;
}

function visit(
  node: Element | Root,
  source: string,
  cursor?: SearchCursor,
): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;
  // If this element has its own position, it defines a fresh search context
  // for its descendants — fences and synthetic siblings outside this range
  // shouldn't interfere with the cursor.
  const myStart = (node as any).position?.start?.offset;
  const myEnd = (node as any).position?.end?.offset;
  const usesOwn = typeof myStart === 'number' && typeof myEnd === 'number';
  const childCursor: SearchCursor | undefined = usesOwn
    ? { anchorStart: myStart!, anchorEnd: myEnd!, pos: 0 }
    : cursor;
  // Iterate a snapshot so in-place replacement doesn't break the loop.
  const children = node.children as Array<RootContent | ElementContent>;
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as any;
    if (child.type === 'text') {
      let start: number | undefined = child.position?.start?.offset;
      let end: number | undefined = child.position?.end?.offset;
      if (
        (typeof start !== 'number' || typeof end !== 'number') &&
        childCursor &&
        typeof child.value === 'string' &&
        child.value.length > 0 &&
        source.length > 0
      ) {
        // Fallback: locate the text value inside the cursor's anchor range,
        // starting from the cursor's current position. Advances the cursor
        // past the match so subsequent repeated values (e.g., two `const`
        // tokens) land on their actual source positions.
        const idx = source.indexOf(
          child.value,
          childCursor.anchorStart + childCursor.pos,
        );
        const matchEnd = idx + child.value.length;
        if (idx >= 0 && matchEnd <= childCursor.anchorEnd) {
          start = idx;
          end = matchEnd;
          childCursor.pos = matchEnd - childCursor.anchorStart;
        }
      }
      if (typeof start !== 'number' || typeof end !== 'number') continue;
      const wrap: Element = {
        type: 'element',
        tagName: 'span',
        properties: {
          className: ['notter-src'],
          // Use canonical hast camelCase form; hast-util-to-jsx-runtime
          // serializes these back to `data-src-start` / `data-src-end` in the
          // DOM. The kebab form here can be dropped silently by property-info.
          dataSrcStart: String(start),
          dataSrcEnd: String(end),
        },
        children: [child],
      };
      (node.children as any[])[i] = wrap;
    } else if (child.type === 'element') {
      visit(child as Element, source, childCursor);
    }
  }
}
