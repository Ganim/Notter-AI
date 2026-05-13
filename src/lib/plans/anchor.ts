// src/lib/plans/anchor.ts
//
// Inline-comment anchor utilities. A comment anchors to a snippet of the
// subject's markdown body via three pieces stored on the row:
//   - quote   : the exact selected text (≤ 500 chars)
//   - prefix  : up to 32 chars of context immediately before the selection
//   - suffix  : up to 32 chars of context immediately after the selection
//
// `findAnchor` resolves the anchor against the *current* draft. Edits that
// shift the snippet around are tolerated; only the disappearance of the
// quoted text itself causes the lookup to fail (caller marks the comment
// archived in that case).

export const MAX_QUOTE_LEN = 500;
export const ANCHOR_CONTEXT_LEN = 32;

export interface CommentAnchor {
  quote: string;
  prefix: string | null;
  suffix: string | null;
}

export interface AnchorRange {
  start: number;
  end: number;
}

/**
 * Find the anchor's location in `content`. Returns the range, or `null` if
 * the quoted text can't be located. Strategy (in order):
 *   1. Search for `prefix + quote + suffix` (exact match on the full window).
 *   2. Search for `quote` alone — if exactly one match, take it.
 *   3. Search for `quote` and pick the match whose surrounding text has the
 *      best overlap with prefix/suffix (handles edits that nudged the
 *      surrounding text but kept the quote intact).
 *   4. Give up.
 */
export function findAnchor(content: string, anchor: CommentAnchor): AnchorRange | null {
  if (!anchor.quote) return null;

  // (1) prefix + quote + suffix exact match.
  if (anchor.prefix || anchor.suffix) {
    const window = (anchor.prefix ?? '') + anchor.quote + (anchor.suffix ?? '');
    const idx = content.indexOf(window);
    if (idx !== -1) {
      const start = idx + (anchor.prefix?.length ?? 0);
      return { start, end: start + anchor.quote.length };
    }
  }

  // (2) quote-only — unique match wins outright.
  const allMatches = findAllOccurrences(content, anchor.quote);
  if (allMatches.length === 1) {
    const start = allMatches[0];
    return { start, end: start + anchor.quote.length };
  }
  if (allMatches.length === 0) return null;

  // (3) score by prefix/suffix overlap, return best.
  let best: { idx: number; score: number } | null = null;
  for (const idx of allMatches) {
    const before = content.slice(Math.max(0, idx - ANCHOR_CONTEXT_LEN), idx);
    const after = content.slice(idx + anchor.quote.length, idx + anchor.quote.length + ANCHOR_CONTEXT_LEN);
    const score =
      suffixOverlap(before, anchor.prefix ?? '') + prefixOverlap(after, anchor.suffix ?? '');
    if (best === null || score > best.score) best = { idx, score };
  }
  if (best && best.score > 0) {
    return { start: best.idx, end: best.idx + anchor.quote.length };
  }

  // No context match either: prefer the first occurrence rather than nothing.
  // This keeps highlights visible after non-trivial draft edits where the
  // quote is still around but its neighbors changed.
  const start = allMatches[0];
  return { start, end: start + anchor.quote.length };
}

/**
 * Build an anchor from a selection inside `content`. Clips the quote to
 * MAX_QUOTE_LEN and grabs ANCHOR_CONTEXT_LEN chars on each side.
 *
 * Returns `null` when the selection is empty / out of bounds — caller
 * should bail out of the comment composer in that case.
 */
export function buildAnchorFromSelection(
  content: string,
  start: number,
  end: number,
): CommentAnchor | null {
  if (start < 0 || end > content.length || end <= start) return null;
  const rawQuote = content.slice(start, end);
  if (!rawQuote.trim()) return null;

  const quote = rawQuote.length > MAX_QUOTE_LEN ? rawQuote.slice(0, MAX_QUOTE_LEN) : rawQuote;
  const prefix = content.slice(Math.max(0, start - ANCHOR_CONTEXT_LEN), start) || null;
  const suffixEnd = Math.min(content.length, end + ANCHOR_CONTEXT_LEN);
  const suffix = content.slice(end, suffixEnd) || null;

  return { quote, prefix, suffix };
}

/**
 * 1-based line number for a character offset in `content`. Out-of-range
 * offsets clamp to the closest end (a missing snippet shouldn't crash the
 * UI badge — it just shows as line 1 or last-line).
 */
export function offsetToLine(content: string, offset: number): number {
  if (offset <= 0) return 1;
  const cap = Math.min(offset, content.length);
  let line = 1;
  for (let i = 0; i < cap; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

// ── helpers ────────────────────────────────────────────────────────────────

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

/** Length of the longest suffix of `a` that equals a suffix of `b`. */
function suffixOverlap(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the longest prefix of `a` that equals a prefix of `b`. */
function prefixOverlap(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[n] === b[n]) n++;
  return n;
}
