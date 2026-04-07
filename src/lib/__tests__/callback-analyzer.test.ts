import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ai-client', () => ({
  generateText: vi.fn(),
}));

import * as aiClient from '@/lib/ai-client';
import {
  buildCallbackPrompt,
  parseAnalysisResponse,
  analyzeTaskFeedback,
  buildFollowUpTasks,
} from '@/lib/callback-analyzer';
import type { Action, ActionTask } from '@/types/actions';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeAction(): Action {
  return {
    id: 'a1',
    projectName: 'p',
    subjectName: 's.md',
    title: 'Test',
    summary: 'Goal',
    originalMarkdown: '',
    status: 'waiting',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };
}

function makeTask(): ActionTask {
  return {
    id: 't1',
    objective: 'Install',
    prompt: 'npm install',
    agentId: '',
    modelTag: 'm',
    terminalId: '',
    status: 'done',
    returnText: '',
  };
}

describe('buildCallbackPrompt', () => {
  it('includes action title, task info and feedback', () => {
    const prompt = buildCallbackPrompt({
      action: makeAction(),
      task: makeTask(),
      feedback: 'ERROR: missing package',
      providerId: 'ollama',
      modelTag: 'm',
    });
    expect(prompt).toContain('Test');
    expect(prompt).toContain('Install');
    expect(prompt).toContain('npm install');
    expect(prompt).toContain('ERROR: missing package');
    expect(prompt).toContain('<feedback>');
  });
});

describe('parseAnalysisResponse', () => {
  it('parses complete response', () => {
    const raw = JSON.stringify({ complete: true, reason: 'done', newTasks: [] });
    const out = parseAnalysisResponse(raw);
    expect(out.complete).toBe(true);
    expect(out.newTasks).toHaveLength(0);
  });

  it('parses incomplete response with follow-ups', () => {
    const raw = JSON.stringify({
      complete: false,
      reason: 'missing dep',
      newTasks: [{ objective: 'Install X', prompt: 'npm i x' }],
    });
    const out = parseAnalysisResponse(raw);
    expect(out.complete).toBe(false);
    expect(out.newTasks).toHaveLength(1);
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"complete":true,"reason":"","newTasks":[]}\n```';
    const out = parseAnalysisResponse(raw);
    expect(out.complete).toBe(true);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAnalysisResponse('not json')).toThrow();
  });

  it('throws when "complete" field is missing', () => {
    const raw = JSON.stringify({ reason: 'X', newTasks: [] });
    expect(() => parseAnalysisResponse(raw)).toThrow(/missing required boolean field "complete"/);
  });

  it('throws when "complete" is not a boolean', () => {
    const raw = JSON.stringify({ complete: 'yes', reason: '', newTasks: [] });
    expect(() => parseAnalysisResponse(raw)).toThrow(/missing required boolean field "complete"/);
  });

  it('extracts JSON from prose-wrapped response', () => {
    const raw = 'Sure thing! Here:\n{"complete":true,"reason":"ok","newTasks":[]}\nThanks';
    const out = parseAnalysisResponse(raw);
    expect(out.complete).toBe(true);
  });

  it('filters out tasks missing both objective and prompt', () => {
    const raw = JSON.stringify({
      complete: false,
      reason: '',
      newTasks: [
        { objective: 'ok', prompt: 'cmd' },
        { objective: '', prompt: '' },
      ],
    });
    const out = parseAnalysisResponse(raw);
    expect(out.newTasks).toHaveLength(1);
  });
});

describe('analyzeTaskFeedback', () => {
  it('routes through generateText and returns parsed result', async () => {
    vi.mocked(aiClient.generateText).mockResolvedValueOnce(
      JSON.stringify({ complete: false, reason: 'err', newTasks: [{ objective: 'o', prompt: 'p' }] }),
    );
    const result = await analyzeTaskFeedback({
      action: makeAction(),
      task: makeTask(),
      feedback: 'error',
      providerId: 'ollama',
      modelTag: 'm',
    });
    expect(result.complete).toBe(false);
    expect(result.newTasks).toHaveLength(1);
    expect(aiClient.generateText).toHaveBeenCalled();
  });
});

describe('buildFollowUpTasks', () => {
  it('creates ActionTask objects with unique ids and default status', () => {
    const tasks = buildFollowUpTasks(
      [
        { objective: 'o1', prompt: 'p1' },
        { objective: 'o2', prompt: 'p2' },
      ],
      'qwen3-vl:4b',
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).not.toBe(tasks[1].id);
    expect(tasks[0].status).toBe('waiting');
    expect(tasks[0].modelTag).toBe('qwen3-vl:4b');
  });
});
