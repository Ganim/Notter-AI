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
