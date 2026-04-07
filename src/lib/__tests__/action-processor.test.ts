import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ollama', () => ({
  generate: vi.fn(),
}));

import * as ollama from '@/lib/ollama';
import { buildUserPrompt, parseAiResponse, processNoteToAction } from '@/lib/action-processor';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildUserPrompt', () => {
  it('includes project, subject and note content', () => {
    const prompt = buildUserPrompt({
      projectName: 'proj',
      subjectName: 'sub.md',
      noteMarkdown: '# Hello',
      modelTag: 'q:4b',
    });
    expect(prompt).toContain('proj');
    expect(prompt).toContain('sub.md');
    expect(prompt).toContain('# Hello');
    expect(prompt).toContain('<note>');
  });
});

describe('parseAiResponse', () => {
  it('parses raw JSON', () => {
    const raw = JSON.stringify({
      title: 'Do X',
      summary: 'A summary',
      tasks: [
        { objective: 'Install deps', prompt: 'npm install' },
        { objective: 'Run tests', prompt: 'npm test' },
      ],
    });
    const out = parseAiResponse(raw);
    expect(out.title).toBe('Do X');
    expect(out.tasks).toHaveLength(2);
    expect(out.tasks[0].prompt).toBe('npm install');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"title":"X","summary":"S","tasks":[]}\n```';
    const out = parseAiResponse(raw);
    expect(out.title).toBe('X');
  });

  it('strips plain backticks fences', () => {
    const raw = '```\n{"title":"X","summary":"S","tasks":[]}\n```';
    const out = parseAiResponse(raw);
    expect(out.title).toBe('X');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseAiResponse('not json')).toThrow();
  });

  it('throws when response has no usable fields', () => {
    expect(() => parseAiResponse('{}')).toThrow('did not contain any usable fields');
  });

  it('filters out tasks missing objective and prompt', () => {
    const raw = JSON.stringify({
      title: 'X',
      summary: 'S',
      tasks: [
        { objective: 'good', prompt: 'cmd' },
        { objective: '', prompt: '' },
        { objective: 'ok', prompt: '' },
      ],
    });
    const out = parseAiResponse(raw);
    expect(out.tasks).toHaveLength(2);
  });

  it('handles non-string fields gracefully', () => {
    const raw = JSON.stringify({ title: 123, summary: null, tasks: [{ objective: 'ok', prompt: 'x' }] });
    const out = parseAiResponse(raw);
    expect(out.title).toBe('');
    expect(out.summary).toBe('');
    expect(out.tasks).toHaveLength(1);
  });
});

describe('processNoteToAction', () => {
  it('returns an Action built from the AI response', async () => {
    vi.mocked(ollama.generate).mockResolvedValueOnce(
      JSON.stringify({
        title: 'Setup auth',
        summary: 'Add login flow',
        tasks: [{ objective: 'Install passport', prompt: 'npm install passport' }],
      }),
    );

    const action = await processNoteToAction({
      projectName: 'p',
      subjectName: 's.md',
      noteMarkdown: 'Need auth',
      modelTag: 'qwen3-vl:4b',
    });

    expect(action.title).toBe('Setup auth');
    expect(action.summary).toBe('Add login flow');
    expect(action.tasks).toHaveLength(1);
    expect(action.tasks[0].prompt).toBe('npm install passport');
    expect(action.tasks[0].modelTag).toBe('qwen3-vl:4b');
    expect(action.tasks[0].status).toBe('waiting');
    expect(action.originalMarkdown).toBe('Need auth');
    expect(action.status).toBe('waiting');
  });

  it('falls back to default title when AI omits it', async () => {
    vi.mocked(ollama.generate).mockResolvedValueOnce(
      JSON.stringify({ summary: 'S', tasks: [{ objective: 'o', prompt: 'p' }] }),
    );
    const action = await processNoteToAction({
      projectName: 'p',
      subjectName: 's.md',
      noteMarkdown: 'n',
      modelTag: 'm',
    });
    expect(action.title).toBe('Process of s.md');
  });

  it('propagates AI errors', async () => {
    vi.mocked(ollama.generate).mockRejectedValueOnce(new Error('network down'));
    await expect(
      processNoteToAction({
        projectName: 'p',
        subjectName: 's',
        noteMarkdown: 'n',
        modelTag: 'm',
      }),
    ).rejects.toThrow('network down');
  });
});
