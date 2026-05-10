// src/lib/plans/frontmatter.ts
//
// Pure codec for the M4 plan-markdown format. Wraps `gray-matter` and adds
// strict schema validation. NO side effects — no fs, no store reads, no Tauri
// calls. Intentionally framework-agnostic so it can be unit-tested with vitest
// alone (no jsdom, no mocks beyond the package itself).
//
// Forward-compat: unknown frontmatter keys are preserved verbatim. Tools that
// add new metadata in later phases will round-trip through this codec without
// data loss.
import matter from 'gray-matter';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The strict schema for Notter plan-markdown frontmatter. Required keys are
 * subject_id, version_id, title, source, exported_at. Optional keys are
 * parent_version_id (null for the first version) and source_actor (null when
 * source is 'user' or 'import' from a non-actor origin).
 *
 * Note: this is a TypeScript view of the validated shape. The runtime parser
 * also accepts (and preserves) arbitrary extra keys via index signature.
 */
export interface ParsedFrontmatter {
  subject_id: string;
  version_id: string;
  parent_version_id: string | null;
  title: string;
  source: 'user' | 'ai' | 'import';
  source_actor: string | null;
  exported_at: string;
  // Forward-compat extras land here when present.
  [extraKey: string]: unknown;
}

export type FrontmatterErrorCode =
  | 'PARSE_ERROR'      // gray-matter / js-yaml threw on malformed YAML
  | 'MISSING_FIELD'    // a required key is absent
  | 'INVALID_UUID'     // subject_id or version_id is not uuid-shaped
  | 'INVALID_SOURCE';  // source is not one of user|ai|import

export class FrontmatterError extends Error {
  readonly code: FrontmatterErrorCode;
  readonly field?: string;

  constructor(code: FrontmatterErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'FrontmatterError';
    this.code = code;
    this.field = field;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── parsePlanMarkdown ────────────────────────────────────────────────────────

export interface ParseResult {
  frontmatter: ParsedFrontmatter;
  body: string;
}

export function parsePlanMarkdown(text: string): ParseResult {
  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(text);
  } catch (e: any) {
    throw new FrontmatterError(
      'PARSE_ERROR',
      `Frontmatter YAML is malformed: ${e?.message ?? String(e)}`,
    );
  }

  // gray-matter returns `data: {}` when there is no frontmatter at all.
  // We treat that as MISSING_FIELD on the first required key for a uniform
  // error path.
  const data = parsed.data as Record<string, unknown>;
  const body = parsed.content ?? '';

  // Required-key checks
  for (const required of ['subject_id', 'version_id', 'title', 'source', 'exported_at'] as const) {
    if (data[required] === undefined || data[required] === null || data[required] === '') {
      throw new FrontmatterError(
        'MISSING_FIELD',
        `Required frontmatter field "${required}" is missing`,
        required,
      );
    }
  }

  // UUID shape checks
  for (const idField of ['subject_id', 'version_id'] as const) {
    if (typeof data[idField] !== 'string' || !UUID_RE.test(data[idField] as string)) {
      throw new FrontmatterError(
        'INVALID_UUID',
        `Field "${idField}" must be a UUID; got ${JSON.stringify(data[idField])}`,
        idField,
      );
    }
  }

  // parent_version_id is optional but must be uuid-shaped when present
  if (data.parent_version_id !== undefined && data.parent_version_id !== null && data.parent_version_id !== '') {
    if (typeof data.parent_version_id !== 'string' || !UUID_RE.test(data.parent_version_id)) {
      throw new FrontmatterError(
        'INVALID_UUID',
        `Field "parent_version_id" must be a UUID or null`,
        'parent_version_id',
      );
    }
  }

  // Source whitelist
  if (!['user', 'ai', 'import'].includes(data.source as string)) {
    throw new FrontmatterError(
      'INVALID_SOURCE',
      `Field "source" must be one of user|ai|import; got ${JSON.stringify(data.source)}`,
      'source',
    );
  }

  // Build the validated frontmatter, preserving extras
  const fm: ParsedFrontmatter = {
    ...data,
    subject_id: data.subject_id as string,
    version_id: data.version_id as string,
    parent_version_id: (data.parent_version_id as string | null | undefined) ?? null,
    title: String(data.title),
    source: data.source as 'user' | 'ai' | 'import',
    source_actor: (data.source_actor as string | null | undefined) ?? null,
    exported_at: String(data.exported_at),
  };

  return { frontmatter: fm, body };
}

// ── stringifyPlanMarkdown ────────────────────────────────────────────────────

export interface StringifyArgs {
  frontmatter: ParsedFrontmatter;
  body: string;
}

export function stringifyPlanMarkdown({ frontmatter, body }: StringifyArgs): string {
  // gray-matter's stringify takes (content, data). It writes YAML by default.
  // We pass through the full frontmatter object — including any extras from
  // the index signature — so round-trips don't lose forward-compat keys.
  return matter.stringify(body ?? '', frontmatter as Record<string, unknown>);
}
