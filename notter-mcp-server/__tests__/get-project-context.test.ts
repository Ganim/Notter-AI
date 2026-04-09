import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveState, type ExecStateFile } from '../src/state.js';
import { getProjectContext } from '../src/tools/get-project-context.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'notter-gpc-'));
});

function seed(): void {
  const state: ExecStateFile = {
    actionId: 'act-1',
    projectPath: 'D:/my/project',
    projectName: 'my-project',
    tasks: [],
    priorTaskSummaries: [
      { title: 'First task', summary: 'Created initial scaffold' },
      { title: 'Second task', summary: 'Added config file' },
    ],
  };
  saveState(tmpDir, state);
}

describe('get_project_context', () => {
  it('returns path, name, and priorTaskSummaries', () => {
    seed();
    const out = getProjectContext(tmpDir, {
      project_id: 'act-1',
      include_file_tree: false,
    });
    expect(out.path).toBe('D:/my/project');
    expect(out.name).toBe('my-project');
    expect(out.is_greenfield).toBe(false);
    expect(out.prior_tasks).toHaveLength(2);
    expect(out.prior_tasks[0].title).toBe('First task');
  });

  it('throws when the action state is missing', () => {
    expect(() =>
      getProjectContext(tmpDir, { project_id: 'ghost' }),
    ).toThrow(/not found/i);
  });

  it('omits file_tree in Phase E even when requested', () => {
    seed();
    const out = getProjectContext(tmpDir, {
      project_id: 'act-1',
      include_file_tree: true,
    });
    expect(out.file_tree).toBeUndefined();
  });
});
