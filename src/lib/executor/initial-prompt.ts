// src/lib/executor/initial-prompt.ts
//
// Phase E: builds the initial prompt we inject into claude-code when we
// spawn the executor. The prompt is deliberately short and directive —
// claude-code performs best with clear stepwise instructions that
// reference the exact MCP tool names. Any style guidance that isn't
// operational lives in the system prompt of the planning stages, not
// here.

export function buildInitialPrompt(actionId: string): string {
  return [
    `You are the autonomous executor for action ${actionId}. Use the notter MCP tools to retrieve and complete tasks one at a time.`,
    '',
    'Workflow (follow literally):',
    `1. Call notter.get_next_task with action_id="${actionId}". If it returns {"done": true}, stop and exit.`,
    '2. If the task has trust_level="manual", call notter.ask_user first with the refined prompt and wait for confirmation.',
    '3. Follow refined_prompt literally. Respect security_flags and data_flags as hard constraints. Stay inside the project cwd.',
    '4. Call notter.report_progress as you make meaningful progress (file created, command run, etc.).',
    '5. When the task is complete, call notter.mark_done with a summary, files_changed list, and tests_run results if any. On failure, include error_message.',
    '6. Repeat from step 1 until get_next_task returns {"done": true}.',
    '',
    'Do not stop to explain what you are doing — call the MCP tools to report progress instead. When you reach done:true, you may write a final short summary and exit.',
  ].join('\n');
}
