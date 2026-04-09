#!/usr/bin/env node
// notter-mcp-server/src/server.ts
//
// Phase E: entry point for the Notter MCP server. Spawned by claude-code
// via --mcp-config; communicates over stdio using @modelcontextprotocol/sdk.
//
// CLI args:
//   --action-id <id>   (required)  — scopes this server instance to a single Action
//   --state-dir <path> (optional)  — override the exec-state directory; defaults to
//                                    AGENTTRACK_STATE_DIR env var, then process.cwd()/exec-state
//
// The server reads/writes $STATE_DIR/<id>.json on every tool call.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getNextTask } from './tools/get-next-task.js';
import { reportProgress } from './tools/report-progress.js';
import { markDone } from './tools/mark-done.js';
import { getProjectContext } from './tools/get-project-context.js';
import { askUser } from './tools/ask-user.js';

interface ParsedArgs {
  actionId: string;
  stateDir: string;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  let actionId: string | undefined;
  let stateDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action-id') actionId = argv[++i];
    else if (argv[i] === '--state-dir') stateDir = argv[++i];
  }
  if (!actionId) {
    console.error('[notter-mcp-server] --action-id is required');
    process.exit(1);
  }
  stateDir =
    stateDir ??
    process.env.AGENTTRACK_STATE_DIR ??
    `${process.cwd()}/exec-state`;
  return { actionId, stateDir };
}

const { actionId, stateDir } = parseArgs();

const server = new Server(
  { name: 'notter', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'notter.get_next_task',
      description:
        'Return the next pending task for this Action. Returns {done:true} when all tasks are complete.',
      inputSchema: {
        type: 'object',
        properties: { action_id: { type: 'string' } },
        required: ['action_id'],
      },
    },
    {
      name: 'notter.report_progress',
      description:
        'Update a running task with a short human-readable status.',
      inputSchema: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
          task_id: { type: 'string' },
          status: { type: 'string', enum: ['running', 'blocked_hitl'] },
          summary: { type: 'string' },
        },
        required: ['action_id', 'task_id', 'status', 'summary'],
      },
    },
    {
      name: 'notter.mark_done',
      description:
        'Finalize a task with summary, files_changed, and optional tests_run/error_message.',
      inputSchema: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
          task_id: { type: 'string' },
          summary: { type: 'string' },
          files_changed: { type: 'array', items: { type: 'string' } },
          tests_run: { type: 'array' },
          error_message: { type: 'string' },
        },
        required: ['action_id', 'task_id', 'summary', 'files_changed'],
      },
    },
    {
      name: 'notter.get_project_context',
      description:
        'Return project path, name, and summaries of prior tasks completed in this Action.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          include_file_tree: { type: 'boolean' },
        },
        required: ['project_id'],
      },
    },
    {
      name: 'notter.ask_user',
      description:
        'Ask the human operator a question and wait for their answer. (Phase E: stubbed to always return "proceed".)',
      inputSchema: {
        type: 'object',
        properties: {
          action_id: { type: 'string' },
          task_id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['action_id', 'task_id', 'question'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (name) {
      case 'notter.get_next_task':
        result = getNextTask(stateDir, { action_id: a.action_id as string });
        break;
      case 'notter.report_progress':
        result = reportProgress(stateDir, {
          action_id: a.action_id as string,
          task_id: a.task_id as string,
          status: a.status as 'running' | 'blocked_hitl',
          summary: a.summary as string,
        });
        break;
      case 'notter.mark_done':
        result = markDone(stateDir, {
          action_id: a.action_id as string,
          task_id: a.task_id as string,
          summary: a.summary as string,
          files_changed: a.files_changed as string[],
          tests_run: a.tests_run as
            | { command: string; passed: boolean; output?: string }[]
            | undefined,
          error_message: a.error_message as string | undefined,
        });
        break;
      case 'notter.get_project_context':
        result = getProjectContext(stateDir, {
          project_id: a.project_id as string,
          include_file_tree: a.include_file_tree as boolean | undefined,
        });
        break;
      case 'notter.ask_user':
        result = askUser({
          action_id: a.action_id as string,
          task_id: a.task_id as string,
          question: a.question as string,
          options: a.options as string[] | undefined,
        });
        break;
      default:
        throw new Error(`unknown tool: ${name}`);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `notter-mcp-server error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[notter-mcp-server] ready (actionId=${actionId} stateDir=${stateDir})`,
);
