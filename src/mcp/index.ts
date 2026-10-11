import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ToolOutcome } from '../tools/result.js';
import { TOOLS } from '../tools/registry.js';
import { runTool } from '../tools/tool.js';
import { VERSION } from '../version.js';

// The map tools as an MCP server over stdio. stdout carries JSON-RPC only: log to stderr.

// Tool calls still running, so a shutdown can let them finish their write and drop their lock.
const running = new Set<Promise<unknown>>();

export async function settleRunningCalls(): Promise<void> {
  await Promise.allSettled([...running]);
}

export function toCallToolResult(outcome: ToolOutcome<unknown>): CallToolResult {
  if (!outcome.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: outcome.error }) }] };
  const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(outcome.data) }];
  if (outcome.png !== undefined) content.push({ type: 'image', data: Buffer.from(outcome.png).toString('base64'), mimeType: 'image/png' });
  return { content, structuredContent: outcome.data as Record<string, unknown> };
}

// serveStdio may call this more than once per connection, so it only builds the server.
export function createServer(): McpServer {
  const server = new McpServer({ name: 'wa-agent-engine', version: VERSION });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, outputSchema: tool.output, annotations: tool.annotations },
      async (args: unknown) => {
        const call = runTool(tool, args);
        running.add(call);
        try {
          return toCallToolResult(await call);
        } finally {
          running.delete(call);
        }
      },
    );
  }
  return server;
}

export function startMcpServer(): { close(): Promise<void> } {
  const handle = serveStdio(() => createServer());
  console.error(`wa-agent-engine ${VERSION}: MCP server on stdio`);
  return handle;
}
