import type { AgentProfile, TaskPriority } from '@/types';
import { sendChat, type ChatMessage } from '@/lib/chat';

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

function extractTasks(content: string): TranslatedTask[] {
  let parsed: any;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      parsed = JSON.parse(match[1].trim());
    } else {
      const jsonMatch = content.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Cannot find JSON in response: ${content.slice(0, 200)}`);
      }
    }
  }

  let tasksArray: any[];
  if (Array.isArray(parsed)) {
    tasksArray = parsed;
  } else if (parsed.tasks && Array.isArray(parsed.tasks)) {
    tasksArray = parsed.tasks;
  } else if (parsed.title) {
    tasksArray = [parsed];
  } else {
    throw new Error(`Unexpected response structure. Keys: ${Object.keys(parsed).join(', ')}`);
  }

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
    const messages: ChatMessage[] = [
      { role: 'system', content: TRANSLATOR_PROMPT },
      { role: 'user', content: `Here is the note to translate into tasks:\n\n${noteContent}` },
    ];

    const response = await sendChat(profile, messages);

    if (response.error) {
      return { tasks: [], error: response.error };
    }

    const tasks = extractTasks(response.content);
    if (tasks.length === 0) {
      return { tasks: [], error: 'No tasks extracted from the note.' };
    }

    return { tasks };
  } catch (e: any) {
    return { tasks: [], error: e.message };
  }
}
