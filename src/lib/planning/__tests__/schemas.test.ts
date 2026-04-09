// src/lib/planning/__tests__/schemas.test.ts
import { describe, it, expect } from 'vitest';

import { PipelineError } from '../types';
import {
  validateExtractOutput,
  validateSecurityOutput,
  validateDataOutput,
  validatePromptCriticOutput,
} from '../schemas';

// ----- extract -----

describe('validateExtractOutput', () => {
  it('accepts a well-formed extract output', () => {
    const parsed = {
      tasks: [
        { id: 't1', title: 'Add dark mode toggle', rawPrompt: 'Wire up...' },
        { id: 't2', title: 'Persist preference', rawPrompt: 'Save to...' },
      ],
    };
    const out = validateExtractOutput(parsed);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('t1');
  });

  it('throws schema_error on missing tasks field', () => {
    expect(() => validateExtractOutput({})).toThrowError(PipelineError);
    try {
      validateExtractOutput({});
    } catch (e) {
      expect(e).toBeInstanceOf(PipelineError);
      expect((e as PipelineError).reason).toBe('schema_error');
      expect((e as PipelineError).stage).toBe('extract');
    }
  });

  it('throws on zero tasks', () => {
    expect(() => validateExtractOutput({ tasks: [] })).toThrow(
      /zero tasks/,
    );
  });

  it('throws on wrong-type id', () => {
    expect(() =>
      validateExtractOutput({
        tasks: [{ id: 5, title: 'x', rawPrompt: 'y' }],
      }),
    ).toThrow(/id missing or not a string/);
  });

  it('throws on title > 160 chars', () => {
    expect(() =>
      validateExtractOutput({
        tasks: [
          { id: 't1', title: 'a'.repeat(161), rawPrompt: 'y' },
        ],
      }),
    ).toThrow(/exceeds 160/);
  });

  it('accepts a 160-char title at the boundary', () => {
    const out = validateExtractOutput({
      tasks: [
        { id: 't1', title: 'a'.repeat(160), rawPrompt: 'y' },
      ],
    });
    expect(out[0].title).toHaveLength(160);
  });

  it('throws on empty rawPrompt', () => {
    expect(() =>
      validateExtractOutput({
        tasks: [{ id: 't1', title: 'ok', rawPrompt: '' }],
      }),
    ).toThrow(/rawPrompt missing or empty/);
  });

  it('throws on duplicated id', () => {
    expect(() =>
      validateExtractOutput({
        tasks: [
          { id: 't1', title: 'a', rawPrompt: 'p' },
          { id: 't1', title: 'b', rawPrompt: 'q' },
        ],
      }),
    ).toThrow(/duplicated/);
  });

  it('throws when root is not an object', () => {
    expect(() => validateExtractOutput('nope')).toThrow(/expected object/);
  });
});

// ----- security -----

describe('validateSecurityOutput', () => {
  const expected = new Set(['t1', 't2']);

  it('accepts matching ids with string flag arrays', () => {
    const out = validateSecurityOutput(
      {
        tasks: [
          { id: 't1', securityFlags: ['sanitize filename'] },
          { id: 't2', securityFlags: [] },
        ],
      },
      expected,
    );
    expect(out).toHaveLength(2);
    expect(out[0].securityFlags).toEqual(['sanitize filename']);
  });

  it('throws when a task id is unknown', () => {
    expect(() =>
      validateSecurityOutput(
        {
          tasks: [
            { id: 't1', securityFlags: [] },
            { id: 't999', securityFlags: [] },
          ],
        },
        expected,
      ),
    ).toThrow(/does not match/);
  });

  it('throws when tasks count mismatches', () => {
    expect(() =>
      validateSecurityOutput(
        { tasks: [{ id: 't1', securityFlags: [] }] },
        expected,
      ),
    ).toThrow(/expected 2 tasks, got 1/);
  });

  it('throws when securityFlags is not a string array', () => {
    expect(() =>
      validateSecurityOutput(
        {
          tasks: [
            { id: 't1', securityFlags: [1, 2] },
            { id: 't2', securityFlags: [] },
          ],
        },
        expected,
      ),
    ).toThrow(/securityFlags missing or not a string array/);
  });

  it('throws on missing tasks root', () => {
    expect(() => validateSecurityOutput({}, expected)).toThrow(
      /missing or non-array/,
    );
  });

  it('error has stage security', () => {
    try {
      validateSecurityOutput({}, expected);
    } catch (e) {
      expect((e as PipelineError).stage).toBe('security');
    }
  });
});

// ----- data -----

describe('validateDataOutput', () => {
  const expected = new Set(['t1']);

  it('accepts empty dataFlags array', () => {
    const out = validateDataOutput(
      { tasks: [{ id: 't1', dataFlags: [] }] },
      expected,
    );
    expect(out[0].dataFlags).toEqual([]);
  });

  it('throws on non-string entries in dataFlags', () => {
    expect(() =>
      validateDataOutput(
        { tasks: [{ id: 't1', dataFlags: ['ok', null] }] },
        expected,
      ),
    ).toThrow(/dataFlags missing or not a string array/);
  });

  it('error has stage data_consistency', () => {
    try {
      validateDataOutput({}, expected);
    } catch (e) {
      expect((e as PipelineError).stage).toBe('data_consistency');
    }
  });

  it('throws on duplicated id within output', () => {
    const dupExpected = new Set(['t1', 't2']);
    expect(() =>
      validateDataOutput(
        {
          tasks: [
            { id: 't1', dataFlags: [] },
            { id: 't1', dataFlags: [] },
          ],
        },
        dupExpected,
      ),
    ).toThrow(/duplicated/);
  });

  it('accepts populated dataFlags', () => {
    const out = validateDataOutput(
      {
        tasks: [
          { id: 't1', dataFlags: ['schema migration', 'index invalidation'] },
        ],
      },
      expected,
    );
    expect(out[0].dataFlags).toHaveLength(2);
  });
});

// ----- prompt critic -----

describe('validatePromptCriticOutput', () => {
  const expected = new Set(['t1', 't2']);

  it('accepts valid refined output', () => {
    const out = validatePromptCriticOutput(
      {
        tasks: [
          { id: 't1', refinedPrompt: 'Do X with ...', trustLevel: 'semi' },
          { id: 't2', refinedPrompt: 'Do Y with ...', trustLevel: 'auto' },
        ],
      },
      expected,
    );
    expect(out[0].trustLevel).toBe('semi');
    expect(out[1].trustLevel).toBe('auto');
  });

  it('throws on unknown trustLevel', () => {
    expect(() =>
      validatePromptCriticOutput(
        {
          tasks: [
            { id: 't1', refinedPrompt: 'x', trustLevel: 'YOLO' },
            { id: 't2', refinedPrompt: 'y', trustLevel: 'semi' },
          ],
        },
        expected,
      ),
    ).toThrow(/not one of auto\|semi\|manual/);
  });

  it('throws on empty refinedPrompt', () => {
    expect(() =>
      validatePromptCriticOutput(
        {
          tasks: [
            { id: 't1', refinedPrompt: '', trustLevel: 'auto' },
            { id: 't2', refinedPrompt: 'y', trustLevel: 'semi' },
          ],
        },
        expected,
      ),
    ).toThrow(/refinedPrompt missing or empty/);
  });

  it('accepts manual trustLevel', () => {
    const out = validatePromptCriticOutput(
      {
        tasks: [
          { id: 't1', refinedPrompt: 'migrate schema', trustLevel: 'manual' },
          { id: 't2', refinedPrompt: 'deploy', trustLevel: 'manual' },
        ],
      },
      expected,
    );
    expect(out.every((t) => t.trustLevel === 'manual')).toBe(true);
  });

  it('throws on missing trustLevel field', () => {
    expect(() =>
      validatePromptCriticOutput(
        {
          tasks: [
            { id: 't1', refinedPrompt: 'x' },
            { id: 't2', refinedPrompt: 'y', trustLevel: 'semi' },
          ],
        },
        expected,
      ),
    ).toThrow(/not one of auto\|semi\|manual/);
  });

  it('error has stage prompt_critic', () => {
    try {
      validatePromptCriticOutput({}, expected);
    } catch (e) {
      expect((e as PipelineError).stage).toBe('prompt_critic');
    }
  });
});
