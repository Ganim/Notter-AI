import { invoke } from '@tauri-apps/api/core';

export type CloudProviderId = 'gemini' | 'claude' | 'openai' | 'deepseek';
export type ProviderId = 'ollama' | CloudProviderId;

export interface ProviderPreset {
  id: CloudProviderId;
  name: string;
  defaultModel: string;
  docsUrl: string;
  keyPlaceholder: string;
}

export const CLOUD_PROVIDERS: ProviderPreset[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    defaultModel: 'gemini-2.0-flash',
    docsUrl: 'https://aistudio.google.com/apikey',
    keyPlaceholder: 'AIza...',
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    defaultModel: 'claude-sonnet-4-5-20250929',
    docsUrl: 'https://console.anthropic.com/',
    keyPlaceholder: 'sk-ant-...',
  },
  {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    defaultModel: 'gpt-4o-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    docsUrl: 'https://platform.deepseek.com/',
    keyPlaceholder: 'sk-...',
  },
];

interface LlmRequestPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

async function llmRequest(payload: LlmRequestPayload): Promise<string> {
  return await invoke<string>('llm_request', { payload });
}

export async function generateCloud(
  providerId: CloudProviderId,
  model: string,
  apiKey: string,
  prompt: string,
): Promise<string> {
  if (!apiKey.trim()) {
    throw new Error(`${providerId}: API key is not set`);
  }

  switch (providerId) {
    case 'gemini': {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model,
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      });
      const raw = await llmRequest({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const parsed = JSON.parse(raw);
      const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== 'string') {
        throw new Error('Gemini response missing text field');
      }
      return text;
    }

    case 'claude': {
      const url = 'https://api.anthropic.com/v1/messages';
      const body = JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = await llmRequest({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body,
      });
      const parsed = JSON.parse(raw);
      const text = parsed?.content?.[0]?.text;
      if (typeof text !== 'string') {
        throw new Error('Claude response missing content[0].text');
      }
      return text;
    }

    case 'openai':
    case 'deepseek': {
      const url =
        providerId === 'openai'
          ? 'https://api.openai.com/v1/chat/completions'
          : 'https://api.deepseek.com/v1/chat/completions';
      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      });
      const raw = await llmRequest({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body,
      });
      const parsed = JSON.parse(raw);
      const text = parsed?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error(`${providerId} response missing choices[0].message.content`);
      }
      return text;
    }
  }
}
