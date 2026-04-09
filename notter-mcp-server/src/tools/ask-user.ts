// notter-mcp-server/src/tools/ask-user.ts
//
// Phase E — Tool 5 of 5: ask_user (STUB).
// Always returns { answer: 'proceed', timeout: false }. Phase F replaces
// this with a real HITL modal that blocks the tool response until the
// user answers. The initial prompt instructs claude to call this for
// manual-trust tasks, so keeping the stub means those tasks run through
// without a gate — documented known limitation.

export interface AskUserInput {
  action_id: string;
  task_id: string;
  question: string;
  options?: string[];
}

export interface AskUserOut {
  answer: string;
  timeout: boolean;
}

export function askUser(input: AskUserInput): AskUserOut {
  // eslint-disable-next-line no-console
  console.error(
    `[notter-mcp-server] ask_user stub returning 'proceed' for question: ${input.question}`,
  );
  return { answer: 'proceed', timeout: false };
}
