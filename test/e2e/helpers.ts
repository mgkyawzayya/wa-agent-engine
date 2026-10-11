import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);

// The bin from source, as an agent would start it: `wa-agent-engine mcp`.
export async function connectMcp(): Promise<Client> {
  const client = new Client({ name: 'wa-agent-engine-e2e', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli/index.ts', 'mcp'],
      cwd: REPO_ROOT,
      env: getDefaultEnvironment(),
      stderr: 'pipe',
    }),
  );
  return client;
}

export interface CliResult {
  code: number;
  json: unknown;
  stderr: string;
}

export async function runCli(command: string, input: unknown): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', command, '--input', JSON.stringify(input)], {
      cwd: REPO_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, json: JSON.parse(stdout) as unknown, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    let json: unknown;
    try {
      json = JSON.parse(e.stdout);
    } catch {
      json = undefined;
    }
    return { code: e.code, json, stderr: e.stderr };
  }
}

// The JSON error body of an isError result. The SDK's own shape errors are plain text, which
// comes back as the message of an INVALID_INPUT body.
export function errorOf(result: { isError?: boolean | undefined; content?: unknown }): { code: string; message: string; details?: unknown } {
  const [first] = result.content as { type: string; text: string }[];
  try {
    return (JSON.parse(first!.text) as { error: { code: string; message: string } }).error;
  } catch {
    return { code: 'INVALID_INPUT', message: first!.text };
  }
}
