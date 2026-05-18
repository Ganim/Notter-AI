import { describe, it, expect } from 'vitest';
import {
  subjectIdentifier,
  parseIdentifier,
  isValidTagShape,
  isReservedTag,
  type SubjectLike,
  type ProjectLike,
} from '../identifiers';

describe('identifiers', () => {
  describe('subjectIdentifier', () => {
    it('returns "tag-seq" when both tag and seq are present', () => {
      const project: ProjectLike = { tag: 'flow' };
      const subject: SubjectLike = { seq: 3 };
      expect(subjectIdentifier(subject, project)).toBe('flow-3');
    });

    it('returns "" when tag is missing', () => {
      const project: ProjectLike = { tag: null };
      const subject: SubjectLike = { seq: 3 };
      expect(subjectIdentifier(subject, project)).toBe('');
    });

    it('returns "" when tag is undefined', () => {
      const project: ProjectLike = { tag: undefined };
      const subject: SubjectLike = { seq: 3 };
      expect(subjectIdentifier(subject, project)).toBe('');
    });

    it('returns "" when seq is missing', () => {
      const project: ProjectLike = { tag: 'flow' };
      const subject: SubjectLike = { seq: null };
      expect(subjectIdentifier(subject, project)).toBe('');
    });

    it('returns "" when seq is undefined', () => {
      const project: ProjectLike = { tag: 'flow' };
      const subject: SubjectLike = { seq: undefined };
      expect(subjectIdentifier(subject, project)).toBe('');
    });

    it('returns "" when seq is 0', () => {
      const project: ProjectLike = { tag: 'flow' };
      const subject: SubjectLike = { seq: 0 };
      expect(subjectIdentifier(subject, project)).toBe('');
    });

    it('handles large seq numbers', () => {
      const project: ProjectLike = { tag: 'archive' };
      const subject: SubjectLike = { seq: 99999 };
      expect(subjectIdentifier(subject, project)).toBe('archive-99999');
    });
  });

  describe('parseIdentifier', () => {
    it('parses "flow-3" into { tag: "flow", seq: 3 }', () => {
      const result = parseIdentifier('flow-3');
      expect(result).toEqual({ tag: 'flow', seq: 3 });
    });

    it('parses "a1-42" into { tag: "a1", seq: 42 }', () => {
      const result = parseIdentifier('a1-42');
      expect(result).toEqual({ tag: 'a1', seq: 42 });
    });

    it('parses "x8y7z6w5-1" into { tag: "x8y7z6w5", seq: 1 }', () => {
      const result = parseIdentifier('x8y7z6w5-1');
      expect(result).toEqual({ tag: 'x8y7z6w5', seq: 1 });
    });

    it('returns null for "flow" (no seq)', () => {
      expect(parseIdentifier('flow')).toBeNull();
    });

    it('returns null for "FLOW-3" (uppercase tag)', () => {
      expect(parseIdentifier('FLOW-3')).toBeNull();
    });

    it('returns null for "flow-" (no seq number)', () => {
      expect(parseIdentifier('flow-')).toBeNull();
    });

    it('returns null for "toolongtag-3" (tag 9 chars)', () => {
      expect(parseIdentifier('toolongtag-3')).toBeNull();
    });

    it('returns null for "a-3" (tag 1 char)', () => {
      expect(parseIdentifier('a-3')).toBeNull();
    });

    it('returns null for "flow-abc" (seq not a number)', () => {
      expect(parseIdentifier('flow-abc')).toBeNull();
    });

    it('returns null for "flow-3.5" (seq is float)', () => {
      expect(parseIdentifier('flow-3.5')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseIdentifier('')).toBeNull();
    });

    it('returns null for string with leading/trailing spaces', () => {
      expect(parseIdentifier(' flow-3')).toBeNull();
      expect(parseIdentifier('flow-3 ')).toBeNull();
    });
  });

  describe('isValidTagShape', () => {
    it('accepts "fl" (2 chars)', () => {
      expect(isValidTagShape('fl')).toBe(true);
    });

    it('accepts "flow" (4 chars)', () => {
      expect(isValidTagShape('flow')).toBe(true);
    });

    it('accepts "flow1234" (8 chars)', () => {
      expect(isValidTagShape('flow1234')).toBe(true);
    });

    it('accepts "a0" (2 chars, mixed)', () => {
      expect(isValidTagShape('a0')).toBe(true);
    });

    it('rejects "a" (1 char)', () => {
      expect(isValidTagShape('a')).toBe(false);
    });

    it('rejects "toolongtag" (9 chars)', () => {
      expect(isValidTagShape('toolongtag')).toBe(false);
    });

    it('rejects "Flow" (uppercase)', () => {
      expect(isValidTagShape('Flow')).toBe(false);
    });

    it('rejects "FLOW" (all uppercase)', () => {
      expect(isValidTagShape('FLOW')).toBe(false);
    });

    it('rejects "flo w" (space)', () => {
      expect(isValidTagShape('flo w')).toBe(false);
    });

    it('rejects "flow-1" (dash)', () => {
      expect(isValidTagShape('flow-1')).toBe(false);
    });

    it('rejects "flow_1" (underscore)', () => {
      expect(isValidTagShape('flow_1')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidTagShape('')).toBe(false);
    });

    it('rejects string with special characters', () => {
      expect(isValidTagShape('flow!')).toBe(false);
      expect(isValidTagShape('flow@')).toBe(false);
      expect(isValidTagShape('flow#')).toBe(false);
    });
  });

  describe('isReservedTag', () => {
    it('flags "new" as reserved', () => {
      expect(isReservedTag('new')).toBe(true);
    });

    it('flags "archived" as reserved', () => {
      expect(isReservedTag('archived')).toBe(true);
    });

    it('flags "settings" as reserved', () => {
      expect(isReservedTag('settings')).toBe(true);
    });

    it('flags "inbox" as reserved', () => {
      expect(isReservedTag('inbox')).toBe(true);
    });

    it('flags "all" as reserved', () => {
      expect(isReservedTag('all')).toBe(true);
    });

    it('does not flag "flow" as reserved', () => {
      expect(isReservedTag('flow')).toBe(false);
    });

    it('does not flag "archive" (not "archived") as reserved', () => {
      expect(isReservedTag('archive')).toBe(false);
    });

    it('does not flag "newproject" as reserved', () => {
      expect(isReservedTag('newproject')).toBe(false);
    });

    it('is case-sensitive; "NEW" is not reserved', () => {
      expect(isReservedTag('NEW')).toBe(false);
    });

    it('does not flag empty string as reserved', () => {
      expect(isReservedTag('')).toBe(false);
    });
  });

});
