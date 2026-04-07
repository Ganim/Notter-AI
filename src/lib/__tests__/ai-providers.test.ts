import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import { generateCloud, CLOUD_PROVIDERS } from '@/lib/ai-providers';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CLOUD_PROVIDERS registry', () => {
  it('exposes 4 providers with required fields', () => {
    expect(CLOUD_PROVIDERS).toHaveLength(4);
    for (const p of CLOUD_PROVIDERS) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.defaultModel).toBeTruthy();
      expect(p.docsUrl).toMatch(/^https?:\/\//);
    }
  });

  it('Claude default model has the correct shape (no broken claude-sonnet-4-6)', () => {
    const claude = CLOUD_PROVIDERS.find((p) => p.id === 'claude');
    expect(claude).toBeDefined();
    expect(claude!.defaultModel).not.toBe('claude-sonnet-4-6');
    expect(claude!.defaultModel).toMatch(/^claude-/);
  });
});

describe('generateCloud — gemini', () => {
  it('builds the correct URL with key in query string', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }] } }] }),
    );
    const out = await generateCloud('gemini', 'gemini-2.0-flash', 'AIza-test', 'hi');
    expect(out).toBe('hello');
    const call = vi.mocked(invoke).mock.calls[0];
    const payload = (call[1] as { payload: { url: string; method: string; body: string } }).payload;
    expect(payload.url).toContain('generativelanguage.googleapis.com');
    expect(payload.url).toContain('gemini-2.0-flash');
    expect(payload.url).toContain('AIza-test');
    expect(payload.method).toBe('POST');
    const body = JSON.parse(payload.body);
    expect(body.contents[0].parts[0].text).toBe('hi');
  });

  it('throws when text field is missing from response', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({ candidates: [] }));
    await expect(generateCloud('gemini', 'm', 'k', 'p')).rejects.toThrow(/missing text/);
  });
});

describe('generateCloud — claude', () => {
  it('sends x-api-key header and parses content[0].text', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      JSON.stringify({ content: [{ text: 'claude says hi' }] }),
    );
    const out = await generateCloud('claude', 'claude-sonnet-4-5', 'sk-ant-test', 'hello');
    expect(out).toBe('claude says hi');
    const call = vi.mocked(invoke).mock.calls[0];
    const payload = (call[1] as { payload: { url: string; headers: Record<string, string>; body: string } }).payload;
    expect(payload.url).toBe('https://api.anthropic.com/v1/messages');
    expect(payload.headers['x-api-key']).toBe('sk-ant-test');
    expect(payload.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(payload.body);
    expect(body.model).toBe('claude-sonnet-4-5');
    expect(body.messages[0].content).toBe('hello');
  });
});

describe('generateCloud — openai', () => {
  it('sends Authorization Bearer and parses choices[0].message.content', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      JSON.stringify({ choices: [{ message: { content: 'gpt response' } }] }),
    );
    const out = await generateCloud('openai', 'gpt-4o-mini', 'sk-test', 'hi');
    expect(out).toBe('gpt response');
    const call = vi.mocked(invoke).mock.calls[0];
    const payload = (call[1] as { payload: { url: string; headers: Record<string, string>; body: string } }).payload;
    expect(payload.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(payload.headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(payload.body);
    expect(body.response_format.type).toBe('json_object');
  });
});

describe('generateCloud — deepseek', () => {
  it('uses deepseek endpoint with same OpenAI-compatible shape', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      JSON.stringify({ choices: [{ message: { content: 'ds response' } }] }),
    );
    const out = await generateCloud('deepseek', 'deepseek-chat', 'sk-test', 'hi');
    expect(out).toBe('ds response');
    const call = vi.mocked(invoke).mock.calls[0];
    const payload = (call[1] as { payload: { url: string } }).payload;
    expect(payload.url).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});

describe('generateCloud — error paths', () => {
  it('throws when apiKey is empty', async () => {
    await expect(generateCloud('gemini', 'm', '', 'p')).rejects.toThrow(/API key is not set/);
    await expect(generateCloud('claude', 'm', '   ', 'p')).rejects.toThrow(/API key is not set/);
  });
});
