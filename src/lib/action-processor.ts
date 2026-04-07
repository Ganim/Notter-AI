import { generateText } from '@/lib/ai-client';
import type { ProviderId } from '@/lib/ai-providers';
import type { Action, ActionTask } from '@/types/actions';

export interface ProcessInput {
  projectName: string;
  subjectName: string;
  noteMarkdown: string;
  providerId: ProviderId;
  modelTag: string;
  apiKey?: string;
}

export interface RawAiResponse {
  title?: unknown;
  summary?: unknown;
  tasks?: unknown;
}

interface RawTask {
  objective?: unknown;
  prompt?: unknown;
}

const SYSTEM_PROMPT = `You are an AI assistant that analyzes Markdown notes written by a developer and extracts a structured plan of actionable shell/terminal tasks.

You MUST respond with a single valid JSON object matching exactly this schema and nothing else (no prose, no markdown fencing, no explanation):

{
  "title": string,          // A short, descriptive title for the overall action (max 70 chars)
  "summary": string,        // A paragraph of markdown summarizing the work (100-300 words)
  "tasks": [                // An array of 1 to 10 tasks, in the order they should be executed
    {
      "objective": string,  // A short goal line for this task (max 80 chars)
      "prompt": string      // The exact command or sequence of commands to run in a terminal
    }
  ]
}

Rules:
- The "prompt" field MUST contain runnable terminal commands, never free-form text.
- If the note is vague, infer reasonable commands based on the context.
- Never wrap the JSON in markdown code fences.
- Never include any text before or after the JSON.
- If you cannot extract any tasks, return an empty "tasks" array with a descriptive "summary".`;

export function buildUserPrompt(input: ProcessInput): string {
  return `Analyze the following Markdown note from the "${input.projectName}" project (subject: ${input.subjectName}) and return the structured JSON plan as instructed.

<note>
${input.noteMarkdown}
</note>`;
}

export function extractJson(raw: string): string {
  // Strategy 1: strip code fences if response is fence-wrapped
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Strategy 2: slice from first '{' to last '}' to drop any prose around the JSON
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

export function parseAiResponse(raw: string): { title: string; summary: string; tasks: Array<{ objective: string; prompt: string }> } {
  const cleaned = extractJson(raw);

  let parsed: RawAiResponse;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`AI did not return valid JSON: ${(e as Error).message}. Raw: ${cleaned.slice(0, 200)}`);
  }

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const rawTasks = Array.isArray(parsed.tasks) ? (parsed.tasks as RawTask[]) : [];

  const tasks = rawTasks
    .map((t) => ({
      objective: typeof t.objective === 'string' ? t.objective.trim() : '',
      prompt: typeof t.prompt === 'string' ? t.prompt.trim() : '',
    }))
    .filter((t) => t.objective || t.prompt);

  if (!title && !summary && tasks.length === 0) {
    throw new Error('AI response did not contain any usable fields');
  }

  return { title, summary, tasks };
}

function makeId(prefix: string): string {
  // crypto.randomUUID is available in Tauri webview (Chromium)
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function processNoteToAction(input: ProcessInput): Promise<Action> {
  const userPrompt = buildUserPrompt(input);
  const fullPrompt = `${SYSTEM_PROMPT}\n\n${userPrompt}`;

  const rawResponse = await generateText({
    providerId: input.providerId,
    model: input.modelTag,
    apiKey: input.apiKey,
    prompt: fullPrompt,
  });
  const { title, summary, tasks: rawTasks } = parseAiResponse(rawResponse);

  const now = new Date().toISOString();
  const actionId = makeId('action');

  const tasks: ActionTask[] = rawTasks.map((t) => ({
    id: makeId('task'),
    objective: t.objective,
    prompt: t.prompt,
    agentId: '',
    modelTag: input.modelTag,
    terminalId: '',
    status: 'waiting',
    returnText: '',
  }));

  return {
    id: actionId,
    projectName: input.projectName,
    subjectName: input.subjectName,
    title: title || `Process of ${input.subjectName}`,
    summary,
    originalMarkdown: input.noteMarkdown,
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
    tasks,
  };
}
