import { invoke } from '@tauri-apps/api/core';
import type { AgentProfile, TaskPriority } from '@/types';

export interface TranslatedTask {
  title: string;
  description: string;
  priority: TaskPriority;
}

const TRANSLATOR_PROMPT = `You are a task translator. Your job is to read a rough note and extract structured tasks from it.

RULES:
1. Extract actionable tasks from the note content
2. Each task needs a clear title, a brief description, and a priority (low, medium, high)
3. If the note is vague, create broader tasks that capture the intent
4. Return ONLY valid JSON, no other text
5. Return between 1 and 10 tasks

OUTPUT FORMAT (strict JSON):
{
  "tasks": [
    { "title": "Task title here", "description": "Brief description", "priority": "medium" },
    { "title": "Another task", "description": "Description", "priority": "high" }
  ]
}`;

interface TranslatorResponse {
  tasks: TranslatedTask[];
  error?: string;
}

async function proxyFetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<string> {
  return await invoke('llm_request', {
    payload: { url, method, headers, body },
  });
}

async function callOllama(noteContent: string, model: string): Promise<string> {
  return proxyFetch(
    'http://localhost:11434/api/chat',
    'POST',
    { 'Content-Type': 'application/json' },
    JSON.stringify({
      model: model || 'llama3.2',
      messages: [
        { role: 'system', content: TRANSLATOR_PROMPT },
        { role: 'user', content: `Here is the note to translate into tasks:\n\n${noteContent}` },
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.3 },
    }),
  );
}

async function callOpenAI(noteContent: string, apiKey: string): Promise<string> {
  return proxyFetch(
    'https://api.openai.com/v1/chat/completions',
    'POST',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: TRANSLATOR_PROMPT },
        { role: 'user', content: `Here is the note to translate into tasks:\n\n${noteContent}` },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  );
}

async function callAnthropic(noteContent: string, apiKey: string): Promise<string> {
  return proxyFetch(
    'https://api.anthropic.com/v1/messages',
    'POST',
    {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: TRANSLATOR_PROMPT,
      messages: [
        { role: 'user', content: `Here is the note to translate into tasks:\n\n${noteContent}` },
      ],
    }),
  );
}

async function callGemini(noteContent: string, apiKey: string): Promise<string> {
  return proxyFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    'POST',
    { 'Content-Type': 'application/json' },
    JSON.stringify({
      contents: [{ parts: [{ text: `${TRANSLATOR_PROMPT}\n\nHere is the note to translate into tasks:\n\n${noteContent}` }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
    }),
  );
}

function parseOllamaResponse(raw: string): TranslatedTask[] {
  const data = JSON.parse(raw);
  const content = data.message?.content || '{}';
  return extractTasks(content);
}

function parseOpenAIResponse(raw: string): TranslatedTask[] {
  const data = JSON.parse(raw);
  const content = data.choices?.[0]?.message?.content || '{}';
  return extractTasks(content);
}

function parseAnthropicResponse(raw: string): TranslatedTask[] {
  const data = JSON.parse(raw);
  const content = data.content?.[0]?.text || '{}';
  return extractTasks(content);
}

function parseGeminiResponse(raw: string): TranslatedTask[] {
  const data = JSON.parse(raw);
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return extractTasks(content);
}

function extractTasks(content: string): TranslatedTask[] {
  console.log('[Translator] extractTasks input:', content.slice(0, 300));

  // Try parsing as-is first
  let parsed: any;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    // Try extracting from markdown code block
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      parsed = JSON.parse(match[1].trim());
    } else {
      // Try finding JSON object in the text
      const jsonMatch = content.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Cannot find JSON in response: ${content.slice(0, 200)}`);
      }
    }
  }

  // Handle case where the response IS the tasks array directly
  let tasksArray: any[];
  if (Array.isArray(parsed)) {
    tasksArray = parsed;
  } else if (parsed.tasks && Array.isArray(parsed.tasks)) {
    tasksArray = parsed.tasks;
  } else {
    // Maybe it returned a single task object
    if (parsed.title) {
      tasksArray = [parsed];
    } else {
      console.error('[Translator] Unexpected parsed structure:', parsed);
      throw new Error(`Unexpected response structure. Keys: ${Object.keys(parsed).join(', ')}`);
    }
  }

  console.log('[Translator] Tasks array before filter:', tasksArray);

  return tasksArray
    .filter((t: any) => t.title && typeof t.title === 'string')
    .map((t: any) => ({
      title: String(t.title).trim(),
      description: String(t.description || '').trim(),
      priority: (['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium') as TaskPriority,
    }));
}

export async function translateNote(profile: AgentProfile, noteContent: string): Promise<TranslatorResponse> {
  try {
    let raw: string;
    let tasks: TranslatedTask[];

    console.log('[Translator] Using provider:', profile.provider);

    switch (profile.provider) {
      case 'ollama':
        raw = await callOllama(noteContent, 'llama3.2');
        console.log('[Translator] Ollama raw response:', raw.slice(0, 500));
        tasks = parseOllamaResponse(raw);
        break;
      case 'openai':
        if (!profile.apiKey) throw new Error('OpenAI API key not configured');
        raw = await callOpenAI(noteContent, profile.apiKey);
        console.log('[Translator] OpenAI raw response:', raw.slice(0, 500));
        tasks = parseOpenAIResponse(raw);
        break;
      case 'anthropic':
        if (!profile.apiKey) throw new Error('Anthropic API key not configured');
        raw = await callAnthropic(noteContent, profile.apiKey);
        console.log('[Translator] Anthropic raw response:', raw.slice(0, 500));
        tasks = parseAnthropicResponse(raw);
        break;
      case 'gemini':
        if (!profile.apiKey) throw new Error('Gemini API key not configured');
        raw = await callGemini(noteContent, profile.apiKey);
        console.log('[Translator] Gemini raw response:', raw.slice(0, 500));
        tasks = parseGeminiResponse(raw);
        break;
      default:
        throw new Error(`Provider ${profile.provider} not supported`);
    }

    console.log('[Translator] Extracted tasks:', tasks.length, tasks);

    if (tasks.length === 0) throw new Error('No tasks extracted from the note. The AI may not have understood the format.');
    return { tasks };
  } catch (e: any) {
    console.error('[Translator] Error:', e);
    return { tasks: [], error: e.message };
  }
}
