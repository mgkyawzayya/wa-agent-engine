import { isWaEngineError, type ErrorBody } from '../core/errors.js';

// What every tool returns, whichever surface (MCP or CLI) calls it: the result, or a coded
// error body. A PNG travels beside the result so MCP can attach it as an image block.

export type ToolOutcome<T> = { ok: true; data: T; png?: Uint8Array } | { ok: false; error: ErrorBody };

export function toolOk<T>(data: T, png?: Uint8Array): ToolOutcome<T> {
  return png === undefined ? { ok: true, data } : { ok: true, data, png };
}

// Coded engine errors pass through as they are. Anything else is reported as INTERNAL with
// its message only: no stack trace, no environment, no file content.
export function toolError(err: unknown): ToolOutcome<never> {
  if (isWaEngineError(err)) return { ok: false, error: err.toJSON() };
  return { ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) } };
}

// Runs a tool body, turning a thrown error into a coded error body.
export async function attempt<T>(body: () => Promise<ToolOutcome<T>>): Promise<ToolOutcome<T>> {
  try {
    return await body();
  } catch (err) {
    return toolError(err);
  }
}
