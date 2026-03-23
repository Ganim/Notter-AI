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

async function callOllama(noteContent: string, model: string): Promise<string> {
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'llama3.2',
      messages: [
        { role: 'system', content: TRANSLATOR_PROMPT },
        { role: 'user', content: `Here is the note to translate into tasks:\n\n${noteContent}` },
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return data.message?.content || '{}';
}

async function callOpenAI(noteContent: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: TRANSLATOR_PROMPT },
        { role: 'user', content: `Here is the note to translate into tasks:\n\n${noteContent}` },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '{}';
}

async function callAnthropic(noteContent: string, apiKey: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: TRANSLATOR_PROMPT,
      messages: [
        { role: 'user', content: `Here is the note to translate into tasks:\n\n${noteContent}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';
  return text;
}

async function callGemini(noteContent: string, apiKey: string): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${TRANSLATOR_PROMPT}\n\nHere is the note to translate into tasks:\n\n${noteContent}` }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
}

function parseResponse(raw: string): TranslatedTask[] {
  try {
    // Try extracting JSON from markdown code blocks
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = match ? match[1].trim() : raw.trim();
    const parsed = JSON.parse(jsonStr);

    if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
      throw new Error('No tasks array in response');
    }

    return parsed.tasks
      .filter((t: any) => t.title && typeof t.title === 'string')
      .map((t: any) => ({
        title: t.title,
        description: t.description || '',
        priority: (['low', 'medium', 'high'].includes(t.priority) ? t.priority : 'medium') as TaskPriority,
      }));
  } catch {
    throw new Error(`Failed to parse LLM response: ${raw.slice(0, 200)}`);
  }
}

export async function translateNote(profile: AgentProfile, noteContent: string): Promise<TranslatorResponse> {
  try {
    let raw: string;

    switch (profile.provider) {
      case 'ollama':
        raw = await callOllama(noteContent, 'llama3.2');
        break;
      case 'openai':
        if (!profile.apiKey) throw new Error('OpenAI API key not configured');
        raw = await callOpenAI(noteContent, profile.apiKey);
        break;
      case 'anthropic':
        if (!profile.apiKey) throw new Error('Anthropic API key not configured');
        raw = await callAnthropic(noteContent, profile.apiKey);
        break;
      case 'gemini':
        if (!profile.apiKey) throw new Error('Gemini API key not configured');
        raw = await callGemini(noteContent, profile.apiKey);
        break;
      default:
        throw new Error(`Provider ${profile.provider} not supported`);
    }

    const tasks = parseResponse(raw);
    if (tasks.length === 0) throw new Error('No tasks extracted from the note');
    return { tasks };
  } catch (e: any) {
    return { tasks: [], error: e.message };
  }
}
