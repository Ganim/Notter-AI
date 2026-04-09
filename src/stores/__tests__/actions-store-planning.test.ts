// src/stores/__tests__/actions-store-planning.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  exists: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn(async () => 'C:\\test\\'),
}));

// Mock the planning library. runPipeline is the only thing the store
// needs — we drive it directly from tests to simulate stages + failures.
const runPipelineMock = vi.fn();
vi.mock('@/lib/planning', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/planning')>('@/lib/planning');
  return {
    ...actual,
    runPipeline: (...args: unknown[]) => runPipelineMock(...args),
  };
});

import { useActionsStore } from '@/stores/actions-store';
import type { Action, ActionTask, PlanStageName } from '@/types/actions';
import {
  PipelineError,
  type PipelineProgressHandler,
  type StageRunResult,
} from '@/lib/planning';

function makeTask(
  id: string,
  patch: Partial<ActionTask> = {},
): ActionTask {
  return {
    id,
    objective: `title-${id}`,
    prompt: `p-${id}`,
    agentId: '',
    modelTag: '',
    terminalId: '',
    status: 'waiting',
    returnText: '',
    ...patch,
  };
}

function makeAction(id: string, overrides: Partial<Action> = {}): Action {
  return {
    id,
    projectName: 'notter',
    subjectName: 'sub.md',
    title: `action ${id}`,
    summary: '',
    originalMarkdown: '# add dark mode',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    ...overrides,
  };
}

function makeStageResult(
  stageName: PlanStageName,
  tasks: ActionTask[],
): StageRunResult {
  return {
    stageName,
    tasks,
    tokenUsage: {
      worker: 'gemini-cli',
      inputTokens: 10,
      outputTokens: 5,
      timestamp: 0,
    },
    durationMs: 100,
    rawOutput: `{"stage":"${stageName}"}`,
  };
}

const project = { name: 'notter', path: 'D:/proj/notter' };

beforeEach(() => {
  useActionsStore.setState({
    actions: [],
    selectedActionId: null,
    loaded: false,
  });
  runPipelineMock.mockReset();
});

describe('actions-store — planning pipeline', () => {
  describe('startPlanning', () => {
    it('happy path: 4 stage commits → plan_review', async () => {
      const action = makeAction('a1');
      useActionsStore.setState({ actions: [action] });

      const t1 = [makeTask('t1')];
      const t2 = [makeTask('t1', { securityFlags: [] })];
      const t3 = [makeTask('t1', { dataFlags: [] })];
      const t4 = [
        makeTask('t1', { refinedPrompt: 'r', trustLevel: 'semi' }),
      ];

      runPipelineMock.mockImplementationOnce(
        async (
          _input: unknown,
          onProgress: PipelineProgressHandler,
        ) => {
          await onProgress(makeStageResult('extract', t1));
          await onProgress(makeStageResult('security', t2));
          await onProgress(makeStageResult('data_consistency', t3));
          await onProgress(makeStageResult('prompt_critic', t4));
          return t4;
        },
      );

      await useActionsStore.getState().startPlanning('a1', project);

      const a = useActionsStore.getState().actions[0];
      expect(a.status).toBe('plan_review');
      expect(a.planStages).toHaveLength(4);
      expect(a.planStages!.every((s) => s.status === 'done')).toBe(true);
      expect(a.tasks).toBe(t4);
      // Each stage should have tokenUsage recorded
      expect(a.planStages![0].tokenUsage?.worker).toBe('gemini-cli');
    });

    it('sets status=planning and seeds planStages immediately', async () => {
      const action = makeAction('a1');
      useActionsStore.setState({ actions: [action] });

      let statusDuringPipeline: string | undefined;
      runPipelineMock.mockImplementationOnce(
        async (_input: unknown, onProgress: PipelineProgressHandler) => {
          statusDuringPipeline =
            useActionsStore.getState().actions[0].status;
          await onProgress(makeStageResult('extract', [makeTask('t1')]));
          await onProgress(
            makeStageResult('security', [makeTask('t1')]),
          );
          await onProgress(
            makeStageResult('data_consistency', [makeTask('t1')]),
          );
          await onProgress(
            makeStageResult('prompt_critic', [makeTask('t1')]),
          );
          return [makeTask('t1')];
        },
      );

      await useActionsStore.getState().startPlanning('a1', project);
      expect(statusDuringPipeline).toBe('planning');
    });

    it('stage failure: partial commits, action → failed', async () => {
      const action = makeAction('a1');
      useActionsStore.setState({ actions: [action] });

      const t1 = [makeTask('t1')];
      runPipelineMock.mockImplementationOnce(
        async (_input: unknown, onProgress: PipelineProgressHandler) => {
          await onProgress(makeStageResult('extract', t1));
          throw new PipelineError({
            stage: 'security',
            reason: 'llm_error',
            message: 'codex rate limited',
          });
        },
      );

      await useActionsStore.getState().startPlanning('a1', project);

      const a = useActionsStore.getState().actions[0];
      expect(a.status).toBe('failed');
      expect(a.tasks).toBe(t1); // extract commit persisted
      const extract = a.planStages!.find((s) => s.name === 'extract');
      const security = a.planStages!.find((s) => s.name === 'security');
      expect(extract?.status).toBe('done');
      expect(security?.status).toBe('failed');
      expect(security?.errorMessage).toMatch(/rate limited/);
    });

    it('double-start is a no-op while status=planning', async () => {
      const action = makeAction('a1', { status: 'planning' });
      useActionsStore.setState({ actions: [action] });

      await useActionsStore.getState().startPlanning('a1', project);
      expect(runPipelineMock).not.toHaveBeenCalled();
    });

    it('returns silently when actionId does not exist', async () => {
      await useActionsStore.getState().startPlanning('ghost', project);
      expect(runPipelineMock).not.toHaveBeenCalled();
    });
  });

  describe('retryPlanStage', () => {
    it('resumes from the requested stage with existing tasks', async () => {
      const partial = makeAction('a1', {
        status: 'failed',
        projectPath: 'D:/proj/notter',
        tasks: [makeTask('t1', { securityFlags: [] })],
        planStages: [
          { name: 'extract', status: 'done' },
          { name: 'security', status: 'done' },
          {
            name: 'data_consistency',
            status: 'failed',
            errorMessage: 'previous boom',
          },
          { name: 'prompt_critic', status: 'pending' },
        ],
      });
      useActionsStore.setState({ actions: [partial] });

      let capturedInput: unknown;
      runPipelineMock.mockImplementationOnce(
        async (input: unknown, onProgress: PipelineProgressHandler) => {
          capturedInput = input;
          await onProgress(
            makeStageResult('data_consistency', [
              makeTask('t1', { dataFlags: ['x'] }),
            ]),
          );
          await onProgress(
            makeStageResult('prompt_critic', [
              makeTask('t1', {
                dataFlags: ['x'],
                refinedPrompt: 'r',
                trustLevel: 'semi',
              }),
            ]),
          );
          return [];
        },
      );

      await useActionsStore
        .getState()
        .retryPlanStage('a1', 'data_consistency');

      expect((capturedInput as { resumeFrom?: string }).resumeFrom).toBe(
        'data_consistency',
      );
      expect(
        (capturedInput as { existingTasks?: unknown[] }).existingTasks,
      ).toHaveLength(1);

      const a = useActionsStore.getState().actions[0];
      expect(a.status).toBe('plan_review');
      expect(
        a.planStages!.find((s) => s.name === 'data_consistency')?.status,
      ).toBe('done');
      expect(
        a.planStages!.find((s) => s.name === 'prompt_critic')?.status,
      ).toBe('done');
    });

    it('writes failure to the retried stage on retry failure', async () => {
      const action = makeAction('a1', {
        status: 'failed',
        tasks: [makeTask('t1')],
        planStages: [
          { name: 'extract', status: 'done' },
          {
            name: 'security',
            status: 'failed',
            errorMessage: 'first boom',
          },
          { name: 'data_consistency', status: 'pending' },
          { name: 'prompt_critic', status: 'pending' },
        ],
      });
      useActionsStore.setState({ actions: [action] });

      runPipelineMock.mockImplementationOnce(async () => {
        throw new PipelineError({
          stage: 'security',
          reason: 'llm_error',
          message: 'second boom',
        });
      });

      await useActionsStore.getState().retryPlanStage('a1', 'security');

      const a = useActionsStore.getState().actions[0];
      expect(a.status).toBe('failed');
      const security = a.planStages!.find((s) => s.name === 'security')!;
      expect(security.status).toBe('failed');
      expect(security.errorMessage).toMatch(/second boom/);
    });
  });

  describe('approvePlan', () => {
    it('transitions plan_review → queued and flips all tasks to pending', async () => {
      const action = makeAction('a1', {
        status: 'plan_review',
        tasks: [
          makeTask('t1', { status: 'waiting' }),
          makeTask('t2', { status: 'waiting' }),
        ],
      });
      useActionsStore.setState({ actions: [action] });

      await useActionsStore.getState().approvePlan('a1');
      const a = useActionsStore.getState().actions[0];
      expect(a.status).toBe('queued');
      expect(a.tasks.every((t) => t.status === 'pending')).toBe(true);
    });

    it('is a no-op when status is not plan_review', async () => {
      const action = makeAction('a1', { status: 'draft' });
      useActionsStore.setState({ actions: [action] });
      await useActionsStore.getState().approvePlan('a1');
      expect(useActionsStore.getState().actions[0].status).toBe('draft');
    });
  });

  describe('rejectPlan', () => {
    it('transitions plan_review → rejected and records reason on last stage', async () => {
      const action = makeAction('a1', {
        status: 'plan_review',
        planStages: [
          { name: 'extract', status: 'done' },
          { name: 'security', status: 'done' },
          { name: 'data_consistency', status: 'done' },
          { name: 'prompt_critic', status: 'done' },
        ],
      });
      useActionsStore.setState({ actions: [action] });

      await useActionsStore
        .getState()
        .rejectPlan('a1', 'prompts not good enough');

      const a = useActionsStore.getState().actions[0];
      expect(a.status).toBe('rejected');
      expect(a.planStages![3].errorMessage).toBe('prompts not good enough');
    });

    it('is a no-op when status is not plan_review', async () => {
      const action = makeAction('a1', { status: 'queued' });
      useActionsStore.setState({ actions: [action] });
      await useActionsStore.getState().rejectPlan('a1');
      expect(useActionsStore.getState().actions[0].status).toBe('queued');
    });
  });
});
