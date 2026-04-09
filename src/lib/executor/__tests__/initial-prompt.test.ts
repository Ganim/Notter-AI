import { describe, it, expect } from 'vitest';
import { buildInitialPrompt } from '@/lib/executor/initial-prompt';

describe('buildInitialPrompt', () => {
  it('includes the action id and the mandatory workflow steps', () => {
    const p = buildInitialPrompt('act-xyz');
    expect(p).toContain('act-xyz');
    expect(p).toContain('notter.get_next_task');
    expect(p).toContain('notter.mark_done');
    expect(p).toContain('notter.report_progress');
    expect(p).toContain('notter.ask_user');
    expect(p).toContain('trust_level');
    expect(p).toContain('{"done": true}');
  });

  it('produces a single string (no markdown headers)', () => {
    const p = buildInitialPrompt('act-1');
    expect(p.startsWith('#')).toBe(false);
    expect(p.length).toBeGreaterThan(100);
    expect(p.length).toBeLessThan(2000);
  });
});
