// src/lib/plans/__tests__/slug.test.ts
import { describe, it, expect } from 'vitest';
import { slugifyTitle } from '@/lib/plans/slug';

describe('slugifyTitle', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(slugifyTitle('Hello World')).toBe('hello-world');
  });

  it('strips accents', () => {
    expect(slugifyTitle('Anotação Importante')).toBe('anotacao-importante');
  });

  it('replaces non-alphanumeric chars with dashes', () => {
    expect(slugifyTitle('Live chat / Etapa 2')).toBe('live-chat-etapa-2');
  });

  it('collapses repeated dashes and trims leading/trailing dashes', () => {
    expect(slugifyTitle('  ---weird-/ /title---  ')).toBe('weird-title');
  });

  it('caps length at 64 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(64);
  });

  it('falls back to "untitled" when input is empty after sanitization', () => {
    expect(slugifyTitle('   ')).toBe('untitled');
    expect(slugifyTitle('???')).toBe('untitled');
  });
});
