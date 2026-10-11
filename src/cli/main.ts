import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import type { ErrorBody } from '../core/errors.js';
import { settleRunningCalls, startMcpServer } from '../mcp/index.js';
import { TOOLS } from '../tools/registry.js';
import { runTool, type ToolEntry } from '../tools/tool.js';
import { VERSION } from '../version.js';

// The CLI over the same tool table as the MCP server. Input is one JSON object, output is
// JSON on stdout. Exit codes: 0 success, 1 tool error or invalid input (JSON error body on
// stdout), 2 unknown command or flag (message on stderr).

// How long a stopping MCP server waits for running tool calls to finish their write.
const SHUTDOWN_GRACE_MS = 5000;

const COMMAND_WIDTH = Math.max(...TOOLS.map((t) => t.command.length));

const USAGE = `wa-agent-engine ${VERSION}: draw WorkAdventure maps from a room layout.

Usage:
  wa-agent-engine <command> --input '<json>'
  wa-agent-engine <command> --input-file <path.json>
  wa-agent-engine <command> --input -          (JSON on stdin)
  wa-agent-engine <command> --help             (the command's input schema)
  wa-agent-engine mcp                          (start the MCP server on stdio)

Commands:
${TOOLS.map((t) => `  ${t.command.padEnd(COMMAND_WIDTH)} ${t.title} (MCP tool ${t.name})`).join('\n')}

Every input takes "projectDir" (absolute path to the map project, the folder with tilesets/);
the map commands also take "mapPath" (the .tmj file, relative to projectDir).`;

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error: ErrorBody): number {
  print({ error });
  return 1;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function commandHelp(tool: ToolEntry): string {
  const schema = JSON.stringify(z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' }), null, 2);
  return `wa-agent-engine ${tool.command}: ${tool.title}\n\n${tool.description}\n\nInput (JSON Schema):\n${schema}\n`;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === 'mcp') {
    if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) {
      process.stdout.write('wa-agent-engine mcp: start the MCP server on stdio (takes no arguments)\n');
      return 0;
    }
    if (rest.length > 0) {
      process.stderr.write(`wa-agent-engine mcp takes no arguments\n`);
      return 2;
    }
    const server = startMcpServer();
    // Stop reading requests, let running calls finish their atomic write and drop their lock,
    // then exit. A second signal ends the process at once.
    const stop = (): void => {
      const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
      void server
        .close()
        .then(() => Promise.race([settleRunningCalls(), deadline]))
        .finally(() => process.exit(0));
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
    return 0;
  }
  const tool = TOOLS.find((t) => t.command === command);
  if (tool === undefined) {
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
    return 2;
  }

  let values: { input?: string; 'input-file'?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { input: { type: 'string' }, 'input-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\nRun wa-agent-engine ${command} --help\n`);
    return 2;
  }
  if (values.help === true) {
    process.stdout.write(commandHelp(tool));
    return 0;
  }
  if ((values.input === undefined) === (values['input-file'] === undefined)) {
    return fail({ code: 'INVALID_INPUT', message: 'pass the input JSON with exactly one of --input <json>, --input - (stdin) or --input-file <path>' });
  }

  let text: string;
  try {
    text = values.input === '-' ? await readStdin() : values.input ?? (await readFile(values['input-file']!, 'utf8'));
  } catch {
    return fail({ code: 'INVALID_INPUT', message: `cannot read the input file ${values['input-file'] ?? ''}` });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail({ code: 'INVALID_INPUT', message: 'the input is not valid JSON' });
  }
  const parsed = tool.input.safeParse(json);
  if (!parsed.success) return fail({ code: 'INVALID_INPUT', message: z.prettifyError(parsed.error) });

  const outcome = await runTool(tool, parsed.data);
  if (!outcome.ok) return fail(outcome.error);
  print(outcome.data);
  return 0;
}
