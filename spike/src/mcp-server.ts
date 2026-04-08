// spike/src/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'notter-spike', version: '0.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Returns the input message verbatim. Used to verify MCP tool calls work.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo back' },
        },
        required: ['message'],
      },
    },
    {
      name: 'block',
      description: 'Sleeps for the given number of milliseconds before returning. Used to verify MCP tool blocking.',
      inputSchema: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: 'Milliseconds to sleep' },
        },
        required: ['ms'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo') {
    const message = (args as { message: string }).message;
    return {
      content: [{ type: 'text', text: `echo: ${message}` }],
    };
  }

  if (name === 'block') {
    const ms = (args as { ms: number }).ms;
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const elapsed = Date.now() - start;
    return {
      content: [{ type: 'text', text: `blocked for ${elapsed}ms` }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('notter-spike MCP server ready\n');
