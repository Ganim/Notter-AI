// src/lib/planning/__tests__/prompt-critic.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { runPromptCriticStage } from '../stages/prompt-critic';
import type { ActionTask } from '@/types/actions';
import type { LLMResponse } from '@/lib/llm';

let lastRunInput: unknown = null;
let runImpl: () => Promise<LLMResponse> = async () => ({
  text: '{"tasks":[]}',
  tokenUsage: {
    worker: 'claude-code',
    inputTokens: 0,
    outputTokens: 0,
    timestamp: 0,
  },
  durationMs: 0,
  tokenUsageReported: false,
});

vi.mock('@/lib/llm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm')>('@/lib/llm');
  return {
    ...actual,
    getWorker: vi.fn(() => ({
      name: 'claude-code',
      run: vi.fn((input: unknown) => {
        lastRunInput = input;
        return runImpl();
      }),
    })),
  };
});

function okResponse(text: string): LLMResponse {
  return {
    text,
    tokenUsage: {
      worker: 'claude-code',
      inputTokens: 400,
      outputTokens: 200,
      timestamp: 1_700_000_000_000,
    },
    durationMs: 9999,
    tokenUsageReported: true,
  };
}

function task(
  id: string,
  title: string,
  overrides: Partial<ActionTask> = {},
): ActionTask {
  return {
    id,
    objective: title,
    prompt: `raw ${id}`,
    rawPrompt: `raw ${id}`,
    agentId: '',
    modelTag: '',
    terminalId: '',
    status: 'waiting',
    returnText: '',
    securityFlags: [],
    dataFlags: [],
    ...overrides,
  };
}

function makeInput(tasks: ActionTask[]) {
  return {
    actionId: 'a1',
    rawMarkdown: '# note',
    project: { name: 'p', path: 'D:/p' },
    existingTasks: tasks,
  };
}

describe('runPromptCriticStage', () => {
  beforeEach(() => {
    lastRunInput = null;
  });

  it('merges refinedPrompt + trustLevel and mirrors prompt for v1 UI', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            {
              id: 't1',
              refinedPrompt: 'You will add a toggle to the settings panel...',
              trustLevel: 'semi',
            },
          ],
        }),
      );

    const out = await runPromptCriticStage(
      makeInput([task('t1', 'Add toggle')]),
    );
    expect(out.stageName).toBe('prompt_critic');
    expect(out.tasks[0].refinedPrompt).toBe(
      'You will add a toggle to the settings panel...',
    );
    expect(out.tasks[0].trustLevel).toBe('semi');
    // v1 mirror
    expect(out.tasks[0].prompt).toBe(out.tasks[0].refinedPrompt);
  });

  it('uses claude-code worker and PROMPT_CRITIC_PROMPT', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', refinedPrompt: 'x', trustLevel: 'auto' },
          ],
        }),
      );
    await runPromptCriticStage(makeInput([task('t1', 'Fix typo')]));
    const call = lastRunInput as { systemPrompt: string; prompt: string };
    expect(call.systemPrompt).toContain('refine development task prompts');
    expect(call.prompt).toContain('Fix typo');
  });

  it('forwards both securityFlags and dataFlags into the user prompt', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', refinedPrompt: 'x', trustLevel: 'semi' },
          ],
        }),
      );
    await runPromptCriticStage(
      makeInput([
        task('t1', 'Upload', {
          securityFlags: ['sanitize filename'],
          dataFlags: ['retention policy'],
        }),
      ]),
    );
    const call = lastRunInput as { prompt: string };
    expect(call.prompt).toContain('sanitize filename');
    expect(call.prompt).toContain('retention policy');
  });

  it('applies trust floor: auto + flags → semi', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', refinedPrompt: 'x', trustLevel: 'auto' },
          ],
        }),
      );
    const out = await runPromptCriticStage(
      makeInput([
        task('t1', 'Upload', {
          securityFlags: ['sanitize filename'],
        }),
      ]),
    );
    expect(out.tasks[0].trustLevel).toBe('semi');
  });

  it('does NOT alter trust when classifier returns semi', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', refinedPrompt: 'x', trustLevel: 'semi' },
          ],
        }),
      );
    const out = await runPromptCriticStage(
      makeInput([
        task('t1', 'Upload', {
          securityFlags: ['sanitize filename'],
        }),
      ]),
    );
    expect(out.tasks[0].trustLevel).toBe('semi');
  });

  it('does NOT alter trust when classifier says auto AND no flags', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', refinedPrompt: 'x', trustLevel: 'auto' },
          ],
        }),
      );
    const out = await runPromptCriticStage(
      makeInput([task('t1', 'Fix typo')]),
    );
    expect(out.tasks[0].trustLevel).toBe('auto');
  });

  it('preserves manual classification with flags', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', refinedPrompt: 'x', trustLevel: 'manual' },
          ],
        }),
      );
    const out = await runPromptCriticStage(
      makeInput([
        task('t1', 'Migrate schema', { dataFlags: ['backfill required'] }),
      ]),
    );
    expect(out.tasks[0].trustLevel).toBe('manual');
  });

  it('throws schema_error on unknown trustLevel', async () => {
    runImpl = async () =>
      okResponse(
        JSON.stringify({
          tasks: [
            { id: 't1', refinedPrompt: 'x', trustLevel: 'bogus' },
          ],
        }),
      );
    await expect(
      runPromptCriticStage(makeInput([task('t1', 'x')])),
    ).rejects.toMatchObject({
      reason: 'schema_error',
      stage: 'prompt_critic',
    });
  });
});
