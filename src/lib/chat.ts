import { invoke } from '@tauri-apps/api/core';
import type { AgentProfile, AIProvider } from '@/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  content: string;
  error?: string;
}

async function proxyFetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<string> {
  return await invoke('llm_request', {
    payload: { url, method, headers, body },
  });
}

function buildOllamaRequest(model: string, messages: ChatMessage[]): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: 'http://localhost:11434/api/chat',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'llama3.2',
      messages,
      stream: false,
      options: { temperature: 0.3 },
    }),
  };
}

function buildOpenAIRequest(model: string, apiKey: string, messages: ChatMessage[]): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages,
      temperature: 0.3,
    }),
  };
}

function buildAnthropicRequest(model: string, apiKey: string, messages: ChatMessage[]): { url: string; headers: Record<string, string>; body: string } {
  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      messages: nonSystemMsgs,
    }),
  };
}

function buildGeminiRequest(model: string, apiKey: string, messages: ChatMessage[]): { url: string; headers: Record<string, string>; body: string } {
  const systemMsg = messages.find((m) => m.role === 'system');
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system');
  const contents = nonSystemMsgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
      contents,
      generationConfig: { temperature: 0.3 },
    }),
  };
}

function parseOllamaResponse(raw: string): string {
  const data = JSON.parse(raw);
  return data.message?.content || '';
}

function parseOpenAIResponse(raw: string): string {
  const data = JSON.parse(raw);
  return data.choices?.[0]?.message?.content || '';
}

function parseAnthropicResponse(raw: string): string {
  const data = JSON.parse(raw);
  return data.content?.[0]?.text || '';
}

function parseGeminiResponse(raw: string): string {
  const data = JSON.parse(raw);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

const REQUEST_BUILDERS: Record<AIProvider, (model: string, apiKey: string, messages: ChatMessage[]) => { url: string; headers: Record<string, string>; body: string }> = {
  ollama: (model, _apiKey, messages) => buildOllamaRequest(model, messages),
  openai: buildOpenAIRequest,
  anthropic: buildAnthropicRequest,
  gemini: buildGeminiRequest,
};

const RESPONSE_PARSERS: Record<AIProvider, (raw: string) => string> = {
  ollama: parseOllamaResponse,
  openai: parseOpenAIResponse,
  anthropic: parseAnthropicResponse,
  gemini: parseGeminiResponse,
};

export async function sendChat(profile: AgentProfile, messages: ChatMessage[]): Promise<ChatResponse> {
  try {
    if (profile.provider !== 'ollama' && !profile.apiKey) {
      return { content: '', error: `API key not configured for ${profile.provider}` };
    }

    const builder = REQUEST_BUILDERS[profile.provider];
    if (!builder) {
      return { content: '', error: `Unsupported provider: ${profile.provider}` };
    }

    const { url, headers, body } = builder(profile.model, profile.apiKey, messages);
    const raw = await proxyFetch(url, 'POST', headers, body);
    const parser = RESPONSE_PARSERS[profile.provider];
    const content = parser(raw);

    if (!content) {
      return { content: '', error: 'Empty response from provider' };
    }

    return { content };
  } catch (e: any) {
    return { content: '', error: e.message || String(e) };
  }
}

export async function fetchOllamaModels(): Promise<string[]> {
  try {
    const raw = await proxyFetch('http://localhost:11434/api/tags', 'GET', {}, '');
    const data = JSON.parse(raw);
    return (data.models || []).map((m: any) => m.name as string);
  } catch {
    return [];
  }
}
