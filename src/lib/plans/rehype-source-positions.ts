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
