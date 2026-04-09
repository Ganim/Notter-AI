import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn<(arg: unknown) => Promise<unknown>>();
const writeExecStateMock = vi.fn<(arg: unknown) => Promise<void>>();
const writeMcpConfigMock = vi.fn<(arg: unknown) => Promise<string>>(
  async () => 'C:/mcp-config.json',
);
const ensureDirMock = vi.fn<() => Promise<string>>(
  async () => 'C:/appdata/exec-state',
);
const startBridgeMock = vi.fn<(arg: unknown) => { stop: () => void }>(
  () => ({ stop: vi.fn() }),
);

vi.mock('@/lib/executor/spawn-claude', () => ({
  spawnClaudeExecutor: (arg: unknown) => spawnMock(arg),
}));
vi.mock('@/lib/executor/exec-state', () => ({
  writeExecState: (arg: unknown) => writeExecStateMock(arg),
}));
vi.mock('@/lib/executor/mcp-config', () => ({
  writeMcpConfigFile: (arg: unknown) => writeMcpConfigMock(arg),
  ensureExecStateDir: () => ensureDirMock(),
}));
vi.mock('@/lib/executor/state-bridge', () => ({
  startStateBridge: (arg: unknown) => startBridgeMock(arg),
}));

type FakeAction = {
  id: string;
  status: string;
  projectName: string;
  projectPath?: string;
  tasks: unknown[];
};

const actions: FakeAction[] = [];
const updateActionMock = vi.fn((id: string, patch: Record<string, unknown>) => {
  const a = actions.find((x) => x.id === id);
  if (a) Object.assign(a, patch);
});

import {
  startQueueWorker,
  __resetQueueWorkerForTests,
} from '@/lib/executor/queue-worker';

beforeEach(() => {
  actions.length = 0;
  spawnMock.mockReset();
  writeExecStateMock.mockReset();
  writeMcpConfigMock.mockClear();
  ensureDirMock.mockClear();
  startBridgeMock.mockClear();
  updateActionMock.mockClear();
  __resetQueueWorkerForTests();
});

describe('queue-worker', () => {
  it('picks a queued action, spawns claude, and marks done on exit 0', async () => {
    actions.push({
      id: 'act-1',
      status: 'queued',
      projectName: 'p',
      projectPath: 'D:/p',
      tasks: [],
    });
    spawnMock.mockResolvedValue({
      waitForExit: async () => 0,
      kill: async () => {},
    });

    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(writeExecStateMock).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalled();
    expect(actions[0].status).toBe('done');
  });

  it('marks action failed when claude exits non-zero', async () => {
    actions.push({
      id: 'act-2',
      status: 'queued',
      projectName: 'p',
      projectPath: 'D:/p',
      tasks: [],
    });
    spawnMock.mockResolvedValue({
      waitForExit: async () => 5,
      kill: async () => {},
    });
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(actions[0].status).toBe('failed');
  });

  it('ignores actions that are not queued', async () => {
    actions.push({
      id: 'act-3',
      status: 'plan_review',
      projectName: 'p',
      tasks: [],
    });
    spawnMock.mockResolvedValue({
      waitForExit: async () => 0,
      kill: async () => {},
    });
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnMock).not.toHaveBeenCalled();
    expect(actions[0].status).toBe('plan_review');
  });

  it('is idempotent: calling startQueueWorker twice does not double-run', async () => {
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('transitions action.status to running before spawning', async () => {
    actions.push({
      id: 'act-4',
      status: 'queued',
      projectName: 'p',
      projectPath: 'D:/p',
      tasks: [],
    });
    let statusWhenSpawned: string | undefined;
    spawnMock.mockImplementation(async () => {
      statusWhenSpawned = actions[0].status;
      return { waitForExit: async () => 0, kill: async () => {} };
    });
    await startQueueWorker({
      serverAbsolutePath: 'D:/server.js',
      intervalMs: 5,
      getActions: () => actions as never,
      updateAction: updateActionMock as never,
      updateTask: vi.fn(),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(statusWhenSpawned).toBe('running');
  });
});
