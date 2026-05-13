import { describe, it, expect } from 'vitest';
import {
  findAnchor,
  buildAnchorFromSelection,
  offsetToLine,
  ANCHOR_CONTEXT_LEN,
  MAX_QUOTE_LEN,
} from '@/lib/plans/anchor';

describe('findAnchor', () => {
  it('returns the unique-quote range when there is exactly one match', () => {
    const content = 'Hello, world! Some other text.';
    const r = findAnchor(content, { quote: 'world', prefix: null, suffix: null });
    expect(r).toEqual({ start: 7, end: 12 });
  });

  it('uses prefix+quote+suffix to disambiguate duplicate quotes', () => {
    const content = 'foo BAR baz BAR qux';
    const r = findAnchor(content, { quote: 'BAR', prefix: 'baz ', suffix: ' qux' });
    expect(r).toEqual({ start: 12, end: 15 });
  });

  it('falls back to context-overlap scoring when window match fails', () => {
    // Insert one char inside the suffix → the exact window no longer matches,
    // but prefix is still good and suffix mostly overlaps.
    const content = 'foo BAR baz BAR Xqux';
    const r = findAnchor(content, { quote: 'BAR', prefix: 'baz ', suffix: ' qux' });
    expect(r).toEqual({ start: 12, end: 15 });
  });

  it('returns null when the quote is missing entirely', () => {
    const r = findAnchor('nothing here', { quote: 'absent', prefix: null, suffix: null });
    expect(r).toBeNull();
  });

  it('returns null on empty quote', () => {
    const r = findAnchor('content', { quote: '', prefix: null, suffix: null });
    expect(r).toBeNull();
  });

  it('falls back to first occurrence when context scores tie at zero', () => {
    const content = 'aaa BAR aaa BAR aaa';
    const r = findAnchor(content, { quote: 'BAR', prefix: 'zzz', suffix: 'zzz' });
    expect(r).toEqual({ start: 4, end: 7 });
  });
});

describe('buildAnchorFromSelection', () => {
  it('captures quote + bounded prefix + bounded suffix', () => {
    const content = 'a'.repeat(100) + 'TARGET' + 'b'.repeat(100);
    const start = 100;
    const end = 106;
    const a = buildAnchorFromSelection(content, start, end);
    expect(a).not.toBeNull();
    expect(a!.quote).toBe('TARGET');
    expect(a!.prefix).toBe('a'.repeat(ANCHOR_CONTEXT_LEN));
    expect(a!.suffix).toBe('b'.repeat(ANCHOR_CONTEXT_LEN));
  });

  it('returns null for empty / whitespace-only selections', () => {
    const content = 'hello   world';
    expect(buildAnchorFromSelection(content, 5, 5)).toBeNull();
    expect(buildAnchorFromSelection(content, 5, 8)).toBeNull(); // 3 spaces
  });

  it('clips quote to MAX_QUOTE_LEN', () => {
    const content = 'x'.repeat(MAX_QUOTE_LEN + 50);
    const a = buildAnchorFromSelection(content, 0, content.length);
    expect(a).not.toBeNull();
    expect(a!.quote.length).toBe(MAX_QUOTE_LEN);
  });

  it('returns null on out-of-bounds ranges', () => {
    expect(buildAnchorFromSelection('abc', -1, 2)).toBeNull();
    expect(buildAnchorFromSelection('abc', 1, 99)).toBeNull();
    expect(buildAnchorFromSelection('abc', 2, 1)).toBeNull();
  });
});

describe('offsetToLine', () => {
  it('returns 1 for offset 0', () => {
    expect(offsetToLine('hello\nworld', 0)).toBe(1);
  });

  it('returns 1 for offsets inside the first line', () => {
    expect(offsetToLine('hello\nworld', 3)).toBe(1);
  });

  it('returns 2 immediately after the first newline', () => {
    expect(offsetToLine('hello\nworld', 6)).toBe(2);
  });

  it('counts every newline', () => {
    expect(offsetToLine('a\nb\nc\nd', 6)).toBe(4);
  });

  it('clamps out-of-range offsets', () => {
    expect(offsetToLine('a\nb', -5)).toBe(1);
    expect(offsetToLine('a\nb', 999)).toBe(2);
  });
});
