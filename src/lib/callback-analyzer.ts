import { generateText } from '@/lib/ai-client';
import type { ProviderId } from '@/lib/ai-providers';
import type { Action, ActionTask } from '@/types/actions';

export interface AnalyzeInput {
  action: Action;
  task: ActionTask;
  feedback: string;
  providerId: ProviderId;
  modelTag: string;
  apiKey?: string;
}

export interface AnalysisResult {
  complete: boolean;
  reason: string;
  newTasks: Array<{ objective: string; prompt: string }>;
}

const CALLBACK_SYSTEM_PROMPT = `You are an AI assistant analyzing the output of a shell/terminal task to determine if it completed successfully or if follow-up tasks are needed.

You MUST respond with a single valid JSON object matching this schema:

{
  "complete": boolean,        // true if the task appears fully done with no issues
  "reason": string,           // short explanation (max 200 chars)
  "newTasks": [               // 0 to 5 follow-up tasks if "complete" is false
    {
      "objective": string,    // short goal (max 80 chars)
      "prompt": string        // runnable terminal command(s)
    }
  ]
}

Rules:
- Never wrap the JSON in markdown code fences.
- Never include any text before or after the JSON.
- Only suggest follow-up tasks that make sense as direct continuations or fixes.
- If everything worked, set complete=true and newTasks=[].
- If output shows errors, parse them and suggest concrete remediation tasks.`;

export function buildCallbackPrompt(input: AnalyzeInput): string {
  return `Context action: "${input.action.title}"
Overall goal: ${input.action.summary || '(none)'}

Task attempted:
- Objective: ${input.task.objective}
- Command executed: ${input.task.prompt}

Feedback / output captured from terminal:
<feedback>
${input.feedback}
</feedback>

Analyze the feedback and return the JSON described by the system instructions.`;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseAnalysisResponse(raw: string): AnalysisResult {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Analyzer did not return valid JSON: ${(e as Error).message}`);
  }
  const complete = typeof parsed.complete === 'boolean' ? parsed.complete : false;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const rawTasks = Array.isArray(parsed.newTasks) ? parsed.newTasks : [];
  const newTasks = rawTasks
    .map((t) => ({
      objective:
        typeof (t as Record<string, unknown>).objective === 'string'
          ? ((t as Record<string, unknown>).objective as string).trim()
          : '',
      prompt:
        typeof (t as Record<string, unknown>).prompt === 'string'
          ? ((t as Record<string, unknown>).prompt as string).trim()
          : '',
    }))
    .filter((t) => t.objective || t.prompt);

  return { complete, reason, newTasks };
}

export async function analyzeTaskFeedback(input: AnalyzeInput): Promise<AnalysisResult> {
  const fullPrompt = `${CALLBACK_SYSTEM_PROMPT}\n\n${buildCallbackPrompt(input)}`;
  const raw = await generateText({
    providerId: input.providerId,
    model: input.modelTag,
    apiKey: input.apiKey,
    prompt: fullPrompt,
  });
  return parseAnalysisResponse(raw);
}

export function buildFollowUpTasks(
  templates: AnalysisResult['newTasks'],
  modelTag: string,
): ActionTask[] {
  return templates.map((t) => ({
    id: makeId('task'),
    objective: t.objective,
    prompt: t.prompt,
    agentId: '',
    modelTag,
    terminalId: '',
    status: 'waiting' as const,
    returnText: '',
  }));
}
