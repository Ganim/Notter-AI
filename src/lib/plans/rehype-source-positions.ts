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

function visit(
  node: Element | Root,
  source: string,
  /** Parent's source range — used as a fallback for text nodes whose
      mdast→hast handler didn't carry positions (notably the inner text of
      block/inline code, which mdast-util-to-hast generates fresh from the
      `value` field). */
  parentStart?: number,
  parentEnd?: number,
): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;
  const myStart = (node as any).position?.start?.offset;
  const myEnd = (node as any).position?.end?.offset;
  const effectiveStart = typeof myStart === 'number' ? myStart : parentStart;
  const effectiveEnd = typeof myEnd === 'number' ? myEnd : parentEnd;
  // Iterate a snapshot so in-place replacement doesn't break the loop.
  const children = node.children as Array<RootContent | ElementContent>;
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as any;
    if (child.type === 'text') {
      let start: number | undefined = child.position?.start?.offset;
      let end: number | undefined = child.position?.end?.offset;
      if (
        (typeof start !== 'number' || typeof end !== 'number') &&
        typeof effectiveStart === 'number' &&
        typeof effectiveEnd === 'number' &&
        typeof child.value === 'string' &&
        child.value.length > 0 &&
        source.length > 0
      ) {
        // Fallback: locate the text value inside the parent's source slice.
        // First occurrence wins. Works reliably for code blocks because
        // their content is reproduced verbatim between the fences.
        const slice = source.slice(effectiveStart, effectiveEnd);
        const localIdx = slice.indexOf(child.value);
        if (localIdx >= 0) {
          start = effectiveStart + localIdx;
          end = start + child.value.length;
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
      visit(child as Element, source, effectiveStart, effectiveEnd);
    }
  }
}
