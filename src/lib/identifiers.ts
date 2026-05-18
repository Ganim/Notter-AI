export interface SubjectLike {
  seq: number | null | undefined;
}

export interface ProjectLike {
  tag: string | null | undefined;
}

const RESERVED_TAGS = new Set(['new', 'archived', 'settings', 'inbox', 'all']);
const TAG_SHAPE = /^[a-z0-9]{2,8}$/;
const IDENTIFIER_SHAPE = /^([a-z0-9]{2,8})-(\d+)$/;

/**
 * Renders "tag-seq" or "" if either tag or seq is missing/falsy.
 */
export function subjectIdentifier(subject: SubjectLike, project: ProjectLike): string {
  if (!project.tag || !subject.seq) {
    return '';
  }
  return `${project.tag}-${subject.seq}`;
}

/**
 * Parses "flow-3" → { tag, seq } or null on invalid format.
 */
export function parseIdentifier(s: string): { tag: string; seq: number } | null {
  const match = s.match(IDENTIFIER_SHAPE);
  if (!match) {
    return null;
  }
  return {
    tag: match[1],
    seq: parseInt(match[2], 10),
  };
}

/**
 * Validates tag shape: 2–8 lowercase alphanumeric chars.
 */
export function isValidTagShape(s: string): boolean {
  return TAG_SHAPE.test(s);
}

/**
 * Checks if tag is reserved (new, archived, settings, inbox, all).
 */
export function isReservedTag(s: string): boolean {
  return RESERVED_TAGS.has(s);
}

