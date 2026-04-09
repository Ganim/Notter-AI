// src/lib/planning/__tests__/orchestrator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runPipeline } from '../orchestrator';
import { PipelineError, type StageRunResult } from '../types';
import type { ActionTask, PlanStageName } from '@/types/actions';

// Mock the 4 stage modules so we can drive the orchestrator directly
// without invoking workers or validators.

const extractMock = vi.fn();
const securityMock = vi.fn();
const dataMock = vi.fn();
const promptCriticMock = vi.fn();

vi.mock('../stages/extract', () => ({
  runExtractStage: (...args: unknown[]) => extractMock(...args),
}));
vi.mock('../stages/security', () => ({
  runSecurityStage: (...args: unknown[]) => securityMock(...args),
}));
vi.mock('../stages/data-consistency', () => ({
  runDataStage: (...args: unknown[]) => dataMock(...args),
}));
vi.mock('../stages/prompt-critic', () => ({
  runPromptCriticStage: (...args: unknown[]) => promptCriticMock(...args),
}));

function makeTask(id: string, patch: Partial<ActionTask> = {}): ActionTask {
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

function makeResult(
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
    rawOutput: `{"ok":true,"stage":"${stageName}"}`,
  };
}

const baseInput = {
  actionId: 'a1',
  rawMarkdown: '# note',
  project: { name: 'p', path: 'D:/p' },
};

describe('runPipeline', () => {
  beforeEach(() => {
    extractMock.mockReset();
    securityMock.mockReset();
    dataMock.mockReset();
    promptCriticMock.mockReset();
  });

  it('runs all 4 stages sequentially and fires onProgress for each', async () => {
    const t1 = [makeTask('t1')];
    const t2 = [makeTask('t1', { securityFlags: ['x'] })];
    const t3 = [
      makeTask('t1', { securityFlags: ['x'], dataFlags: ['y'] }),
    ];
    const t4 = [
      makeTask('t1', {
        securityFlags: ['x'],
        dataFlags: ['y'],
        refinedPrompt: 'final',
        trustLevel: 'semi',
      }),
    ];

    extractMock.mockResolvedValueOnce(makeResult('extract', t1));
    securityMock.mockResolvedValueOnce(makeResult('security', t2));
    dataMock.mockResolvedValueOnce(makeResult('data_consistency', t3));
    promptCriticMock.mockResolvedValueOnce(makeResult('prompt_critic', t4));

    const progress = vi.fn();
    const result = await runPipeline(baseInput, progress);

    expect(extractMock).toHaveBeenCalledOnce();
    expect(securityMock).toHaveBeenCalledOnce();
    expect(dataMock).toHaveBeenCalledOnce();
    expect(promptCriticMock).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledTimes(4);
    expect(progress.mock.calls[0][0].stageName).toBe('extract');
    expect(progress.mock.calls[3][0].stageName).toBe('prompt_critic');
    expect(result).toBe(t4);
  });

  it('passes the previous stage output into the next stage', async () => {
    const t1 = [makeTask('t1')];
    const t2 = [makeTask('t1', { securityFlags: [] })];
    const t3 = [makeTask('t1', { dataFlags: [] })];
    const t4 = [makeTask('t1', { refinedPrompt: 'r', trustLevel: 'auto' })];

    extractMock.mockResolvedValueOnce(makeResult('extract', t1));
    securityMock.mockResolvedValueOnce(makeResult('security', t2));
    dataMock.mockResolvedValueOnce(makeResult('data_consistency', t3));
    promptCriticMock.mockResolvedValueOnce(makeResult('prompt_critic', t4));

    await runPipeline(baseInput, vi.fn());

    // security received the extract output
    expect(securityMock.mock.calls[0][0].existingTasks).toBe(t1);
    // data received the security output
    expect(dataMock.mock.calls[0][0].existingTasks).toBe(t2);
    // prompt-critic received the data output
    expect(promptCriticMock.mock.calls[0][0].existingTasks).toBe(t3);
  });

  it('resumes from a specific stage and skips earlier ones', async () => {
    const existing = [makeTask('t1', { securityFlags: [] })];
    const dataOut = [
      makeTask('t1', { securityFlags: [], dataFlags: ['z'] }),
    ];
    const criticOut = [
      makeTask('t1', {
        securityFlags: [],
        dataFlags: ['z'],
        refinedPrompt: 'r',
        trustLevel: 'semi',
      }),
    ];

    dataMock.mockResolvedValueOnce(makeResult('data_consistency', dataOut));
    promptCriticMock.mockResolvedValueOnce(
      makeResult('prompt_critic', criticOut),
    );

    const progress = vi.fn();
    const result = await runPipeline(
      {
        ...baseInput,
        resumeFrom: 'data_consistency',
        existingTasks: existing,
      },
      progress,
    );

    expect(extractMock).not.toHaveBeenCalled();
    expect(securityMock).not.toHaveBeenCalled();
    expect(dataMock).toHaveBeenCalledOnce();
    expect(promptCriticMock).toHaveBeenCalledOnce();
    expect(progress).toHaveBeenCalledTimes(2);
    expect(result).toBe(criticOut);
  });

  it('propagates stage failure and does NOT fire onProgress for the failed stage', async () => {
    const t1 = [makeTask('t1')];
    extractMock.mockResolvedValueOnce(makeResult('extract', t1));
    const err = new PipelineError({
      stage: 'security',
      reason: 'llm_error',
      message: 'boom',
    });
    securityMock.mockRejectedValueOnce(err);

    const progress = vi.fn();
    await expect(runPipeline(baseInput, progress)).rejects.toBe(err);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress.mock.calls[0][0].stageName).toBe('extract');
  });

  it('throws cancelled when AbortSignal fires before start', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runPipeline(baseInput, vi.fn(), { signal: ac.signal }),
    ).rejects.toMatchObject({
      name: 'PipelineError',
      reason: 'cancelled',
    });
    expect(extractMock).not.toHaveBeenCalled();
  });

  it('throws cancelled when AbortSignal fires between stages', async () => {
    const t1 = [makeTask('t1')];
    const ac = new AbortController();
    extractMock.mockImplementationOnce(async () => {
      ac.abort();
      return makeResult('extract', t1);
    });

    const progress = vi.fn();
    await expect(
      runPipeline(baseInput, progress, { signal: ac.signal }),
    ).rejects.toMatchObject({ reason: 'cancelled', stage: 'security' });
    expect(progress).toHaveBeenCalledTimes(1); // extract committed
    expect(securityMock).not.toHaveBeenCalled();
  });

  it('throws validation_error when resumeFrom has no existingTasks', async () => {
    await expect(
      runPipeline(
        { ...baseInput, resumeFrom: 'security' },
        vi.fn(),
      ),
    ).rejects.toMatchObject({
      reason: 'validation_error',
      stage: 'security',
    });
  });

  it('awaits onProgress (supports async handlers)', async () => {
    const t1 = [makeTask('t1')];
    const t2 = [makeTask('t1', { securityFlags: [] })];
    const t3 = [makeTask('t1', { dataFlags: [] })];
    const t4 = [
      makeTask('t1', { refinedPrompt: 'r', trustLevel: 'auto' }),
    ];
    extractMock.mockResolvedValueOnce(makeResult('extract', t1));
    securityMock.mockResolvedValueOnce(makeResult('security', t2));
    dataMock.mockResolvedValueOnce(makeResult('data_consistency', t3));
    promptCriticMock.mockResolvedValueOnce(makeResult('prompt_critic', t4));

    const order: string[] = [];
    const progress = vi.fn(async (r: StageRunResult) => {
      order.push(`start-${r.stageName}`);
      await new Promise((res) => setTimeout(res, 1));
      order.push(`end-${r.stageName}`);
    });

    await runPipeline(baseInput, progress);
    // Every start is followed by its end before the next start begins.
    expect(order).toEqual([
      'start-extract',
      'end-extract',
      'start-security',
      'end-security',
      'start-data_consistency',
      'end-data_consistency',
      'start-prompt_critic',
      'end-prompt_critic',
    ]);
  });
});
