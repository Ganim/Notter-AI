import { describe, it, expect } from 'vitest';
import { safeFsName, unsafeFsName } from '../safe-fs-name';

describe('safeFsName / unsafeFsName', () => {
  it('is identity for names without illegal characters', () => {
    const samples = ['Noter', 'My Project', 'projeto com acentos áéíóú', 'multi word name'];
    for (const s of samples) {
      expect(safeFsName(s)).toBe(s);
      expect(unsafeFsName(s)).toBe(s);
    }
  });

  it('escapes Windows-illegal characters reversibly', () => {
    const cases: [string, string][] = [
      ['Realtime 13:23:21',         'Realtime 13%3A23%3A21'],
      ['a/b',                       'a%2Fb'],
      ['a\\b',                      'a%5Cb'],
      ['<tag>',                     '%3Ctag%3E'],
      ['"quoted"',                  '%22quoted%22'],
      ['a|b',                       'a%7Cb'],
      ['why?',                      'why%3F'],
      ['star*name',                 'star%2Aname'],
    ];
    for (const [logical, expected] of cases) {
      expect(safeFsName(logical)).toBe(expected);
      expect(unsafeFsName(expected)).toBe(logical);
    }
  });

  it('escapes the percent character itself so round-trip is unambiguous', () => {
    expect(safeFsName('100% off')).toBe('100%25 off');
    expect(unsafeFsName('100%25 off')).toBe('100% off');
  });

  it('survives nested encoding (idempotent decoding)', () => {
    const logical = 'Texto aleatório 13:39:12.md';
    const encoded = safeFsName(logical);
    expect(encoded).toBe('Texto aleatório 13%3A39%3A12.md');
    expect(unsafeFsName(encoded)).toBe(logical);
  });

  it('handles already-encoded-looking strings without surprise', () => {
    // A logical name that happens to contain "%XX"-like patterns must
    // re-encode the % so we can decode it back without collision.
    const logical = 'fake %3A not a colon';
    const encoded = safeFsName(logical);
    expect(encoded).toBe('fake %253A not a colon');
    expect(unsafeFsName(encoded)).toBe(logical);
  });
});
