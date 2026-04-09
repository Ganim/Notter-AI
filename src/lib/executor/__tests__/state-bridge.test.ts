import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockedState: unknown = null;
vi.mock('@/lib/executor/exec-state', () => ({
  readExecState: vi.fn(async () => mockedState),
  writeExecState: vi.fn(async () => {}),
  execStatePath: vi.fn(async () => 'C:/x.json'),
}));

import { startStateBridge } from '@/lib/executor/state-bridge';
import type { ExecStateFile } from '@/lib/executor/types';

beforeEach(() => {
  mockedState = null;
});

function sample(
  status: 'pending' | 'running' | 'done' | 'failed',
  summary?: string,
): ExecStateFile {
  return {
    actionId: 'act-1',
    projectPath: 'D:/p',
    projectName: 'p',
    tasks: [
      {
        id: 't1',
        title: 'One',
        refinedPrompt: 'x',
        securityFlags: [],
        dataFlags: [],
        trustLevel: 'semi',
        status,
        summary,
        result: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    priorTaskSummaries: [],
  };
}

describe('startStateBridge', () => {
  it('calls onChange when a tracked field flips', async () => {
    mockedState = sample('pending');
    const onChange = vi.fn();
    const bridge = startStateBridge({
      actionId: 'act-1',
      intervalMs: 5,
      onChange,
    });
    await new Promise((r) => setTimeout(r, 10));
    mockedState = sample('running', 'working...');
    await new Promise((r) => setTimeout(r, 15));
    bridge.stop();
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.tasks[0].status).toBe('running');
  });

  it('does NOT call onChange when the state is unchanged', async () => {
    mockedState = sample('running');
    const onChange = vi.fn();
    const bridge = startStateBridge({
      actionId: 'act-1',
      intervalMs: 5,
      onChange,
    });
    await new Promise((r) => setTimeout(r, 20));
    bridge.stop();
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('stop() halts the polling loop', async () => {
    mockedState = sample('pending');
    const onChange = vi.fn();
    const bridge = startStateBridge({
      actionId: 'act-1',
      intervalMs: 5,
      onChange,
    });
    bridge.stop();
    const before = onChange.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(onChange.mock.calls.length).toBe(before);
  });
});
