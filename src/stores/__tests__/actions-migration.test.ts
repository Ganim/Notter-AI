// src/stores/__tests__/actions-migration.test.ts
import { describe, it, expect } from 'vitest';
import { migrateActionsFile } from '@/stores/actions-migration';
import type { Action, ActionTask } from '@/types/actions';

function v1Task(overrides: Partial<ActionTask> = {}): ActionTask {
  return {
    id: 't1',
    objective: 'do thing',
    prompt: 'do thing in detail',
    agentId: '',
    modelTag: '',
    terminalId: '',
    status: 'waiting',
    returnText: '',
    ...overrides,
  };
}

function v1Action(overrides: Partial<Action> = {}): Action {
  return {
    id: 'a1',
    projectName: 'demo',
    subjectName: 'note.md',
    title: 'demo action',
    summary: '',
    originalMarkdown: '# demo',
    status: 'waiting',
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-01T12:30:00.000Z',
    tasks: [v1Task()],
    ...overrides,
  };
}

describe('migrateActionsFile', () => {
  it('returns empty v2 file for non-object input', () => {
    const r1 = migrateActionsFile(null);
    expect(r1.file).toEqual({ version: 2, actions: [] });
    expect(r1.migrated).toBe(false);

    const r2 = migrateActionsFile('not an object');
    expect(r2.file).toEqual({ version: 2, actions: [] });
    expect(r2.migrated).toBe(false);
  });

  it('passes through a v2 file unchanged with migrated=false', () => {
    const v2 = { version: 2, actions: [] };
    const r = migrateActionsFile(v2);
    expect(r.file).toEqual({ version: 2, actions: [] });
    expect(r.migrated).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('migrates a v1 file to v2 with the same number of actions', () => {
    const v1 = { version: 1, actions: [v1Action(), v1Action({ id: 'a2' })] };
    const r = migrateActionsFile(v1);
    expect(r.migrated).toBe(true);
    expect(r.file.version).toBe(2);
    expect(r.file.actions).toHaveLength(2);
  });

  it('treats missing version as v1', () => {
    const r = migrateActionsFile({ actions: [v1Action()] });
    expect(r.migrated).toBe(true);
    expect(r.file.version).toBe(2);
  });

  it('maps action statuses: waiting → draft', () => {
    const v1 = { version: 1, actions: [v1Action({ status: 'waiting' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].status).toBe('draft');
  });

  it('maps action statuses: processing → draft (deviates from spec, see migration comment)', () => {
    const v1 = { version: 1, actions: [v1Action({ status: 'processing' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].status).toBe('draft');
  });

  it('maps action statuses: done → done', () => {
    const v1 = { version: 1, actions: [v1Action({ status: 'done' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].status).toBe('done');
  });

  it('maps action statuses: skipped → cancelled', () => {
    const v1 = { version: 1, actions: [v1Action({ status: 'skipped' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].status).toBe('cancelled');
  });

  it('preserves all v1 Action fields', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    const a = r.file.actions[0];
    expect(a.id).toBe('a1');
    expect(a.projectName).toBe('demo');
    expect(a.subjectName).toBe('note.md');
    expect(a.title).toBe('demo action');
    expect(a.originalMarkdown).toBe('# demo');
    expect(a.createdAt).toBe('2026-04-01T12:00:00.000Z');
    expect(a.updatedAt).toBe('2026-04-01T12:30:00.000Z');
  });

  it('promotes projectName to projectId', () => {
    const v1 = { version: 1, actions: [v1Action({ projectName: 'foo' })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].projectId).toBe('foo');
  });

  it('leaves projectPath undefined and emits a warning', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].projectPath).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('projectPath unresolved'))).toBe(true);
  });

  it('initializes planStages and tokenUsage to empty arrays', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].planStages).toEqual([]);
    expect(r.file.actions[0].tokenUsage).toEqual([]);
  });

  it('mirrors createdAt/updatedAt as ms numbers', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    const a = r.file.actions[0];
    expect(a.createdAtMs).toBe(Date.parse('2026-04-01T12:00:00.000Z'));
    expect(a.updatedAtMs).toBe(Date.parse('2026-04-01T12:30:00.000Z'));
  });

  it('handles invalid timestamps by leaving ms fields undefined', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ createdAt: 'not a date', updatedAt: '' })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].createdAtMs).toBeUndefined();
    expect(r.file.actions[0].updatedAtMs).toBeUndefined();
  });

  it('maps task status: waiting → pending', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ status: 'waiting' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].status).toBe('pending');
  });

  it('maps task status: running → pending (no live terminal at migration time)', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ status: 'running' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].status).toBe('pending');
  });

  it('preserves task status: done', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ status: 'done' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].status).toBe('done');
  });

  it('preserves task status: failed', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ status: 'failed' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].status).toBe('failed');
  });

  it('populates rawPrompt from prompt', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ prompt: 'specific instruction' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].rawPrompt).toBe('specific instruction');
  });

  it('defaults task trustLevel to "semi"', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].trustLevel).toBe('semi');
  });

  it('defaults task securityFlags and dataFlags to empty arrays', () => {
    const v1 = { version: 1, actions: [v1Action()] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].securityFlags).toEqual([]);
    expect(r.file.actions[0].tasks[0].dataFlags).toEqual([]);
  });

  it('preserves returnText and surfaces it as result.summary when non-empty', () => {
    const v1 = {
      version: 1,
      actions: [v1Action({ tasks: [v1Task({ returnText: 'previous run output' })] })],
    };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].returnText).toBe('previous run output');
    expect(r.file.actions[0].tasks[0].result?.summary).toBe('previous run output');
    expect(r.file.actions[0].tasks[0].result?.filesChanged).toEqual([]);
    expect(r.file.actions[0].tasks[0].result?.testsRun).toEqual([]);
  });

  it('does not create a result object when returnText is empty', () => {
    const v1 = { version: 1, actions: [v1Action({ tasks: [v1Task({ returnText: '' })] })] };
    const r = migrateActionsFile(v1);
    expect(r.file.actions[0].tasks[0].result).toBeUndefined();
  });

  it('handles unknown version with empty result and warning', () => {
    const r = migrateActionsFile({ version: 99, actions: [] });
    expect(r.file).toEqual({ version: 2, actions: [] });
    expect(r.migrated).toBe(false);
    expect(r.warnings.some((w) => w.includes('Unknown version'))).toBe(true);
  });

  it('handles a v1 file with no actions array', () => {
    const r = migrateActionsFile({ version: 1 });
    expect(r.file).toEqual({ version: 2, actions: [] });
    expect(r.migrated).toBe(true);
  });
});
