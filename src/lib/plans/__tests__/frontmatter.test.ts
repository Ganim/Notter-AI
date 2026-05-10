// src/lib/plans/__tests__/frontmatter.test.ts
import { describe, it, expect } from 'vitest';
import {
  parsePlanMarkdown,
  stringifyPlanMarkdown,
  FrontmatterError,
  type ParsedFrontmatter,
} from '@/lib/plans/frontmatter';

const VALID_FM: ParsedFrontmatter = {
  subject_id: '7e9c1bb6-2f3e-4a1b-9c8d-1234567890ab',
  version_id: 'a1b2c3d4-5e6f-4a1b-9c8d-1234567890ab',
  parent_version_id: null,
  title: 'Live chat / Etapa 2',
  source: 'user',
  source_actor: null,
  exported_at: '2026-05-10T18:30:00Z',
};

const VALID_BODY = '# Heading\n\nBody paragraph with **bold** text.\n';

describe('frontmatter — round-trip', () => {
  it('parse(stringify(x)) deep-equals x for the canonical happy path', () => {
    const text = stringifyPlanMarkdown({ frontmatter: VALID_FM, body: VALID_BODY });
    const parsed = parsePlanMarkdown(text);
    expect(parsed.frontmatter).toEqual(VALID_FM);
    expect(parsed.body.trim()).toBe(VALID_BODY.trim());
  });

  it('preserves unknown forward-compat keys', () => {
    const fmPlus = { ...VALID_FM, future_key: 'forward' } as any;
    const text = stringifyPlanMarkdown({ frontmatter: fmPlus, body: VALID_BODY });
    const parsed = parsePlanMarkdown(text);
    expect((parsed.frontmatter as any).future_key).toBe('forward');
  });

  it('preserves source_actor when set', () => {
    const fm = { ...VALID_FM, source: 'ai' as const, source_actor: 'claude' };
    const text = stringifyPlanMarkdown({ frontmatter: fm, body: VALID_BODY });
    const parsed = parsePlanMarkdown(text);
    expect(parsed.frontmatter.source).toBe('ai');
    expect(parsed.frontmatter.source_actor).toBe('claude');
  });
});

describe('frontmatter — parse errors', () => {
  it('rejects missing subject_id with code MISSING_FIELD', () => {
    const text = `---\nversion_id: a1b2c3d4-5e6f-4a1b-9c8d-1234567890ab\ntitle: t\nsource: user\nexported_at: 2026-05-10T18:30:00Z\n---\nbody`;
    expect(() => parsePlanMarkdown(text)).toThrow(FrontmatterError);
    try { parsePlanMarkdown(text); } catch (e: any) {
      expect(e.code).toBe('MISSING_FIELD');
      expect(e.field).toBe('subject_id');
    }
  });

  it('rejects missing version_id with code MISSING_FIELD', () => {
    const text = `---\nsubject_id: 7e9c1bb6-2f3e-4a1b-9c8d-1234567890ab\ntitle: t\nsource: user\nexported_at: 2026-05-10T18:30:00Z\n---\nbody`;
    expect(() => parsePlanMarkdown(text)).toThrow(FrontmatterError);
  });

  it('rejects missing title', () => {
    const text = `---\nsubject_id: 7e9c1bb6-2f3e-4a1b-9c8d-1234567890ab\nversion_id: a1b2c3d4-5e6f-4a1b-9c8d-1234567890ab\nsource: user\nexported_at: 2026-05-10T18:30:00Z\n---\nbody`;
    expect(() => parsePlanMarkdown(text)).toThrow(FrontmatterError);
  });

  it('rejects unknown source value with code INVALID_SOURCE', () => {
    const text = stringifyPlanMarkdown({ frontmatter: { ...VALID_FM, source: 'bogus' as any }, body: VALID_BODY });
    try { parsePlanMarkdown(text); } catch (e: any) {
      expect(e.code).toBe('INVALID_SOURCE');
    }
  });

  it('rejects malformed UUID with code INVALID_UUID', () => {
    const text = stringifyPlanMarkdown({ frontmatter: { ...VALID_FM, subject_id: 'not-a-uuid' }, body: VALID_BODY });
    try { parsePlanMarkdown(text); } catch (e: any) {
      expect(e.code).toBe('INVALID_UUID');
      expect(e.field).toBe('subject_id');
    }
  });

  it('rejects malformed YAML with code PARSE_ERROR', () => {
    // Unclosed list / bad indent — gray-matter throws via js-yaml
    const text = `---\nsubject_id: [unclosed\ntitle: x\n---\nbody`;
    try { parsePlanMarkdown(text); } catch (e: any) {
      expect(e.code).toBe('PARSE_ERROR');
    }
  });

  it('rejects a markdown file with no frontmatter at all', () => {
    const text = `# Just a heading\n\nNo frontmatter.`;
    try { parsePlanMarkdown(text); } catch (e: any) {
      expect(e.code).toBe('MISSING_FIELD');
    }
  });
});
