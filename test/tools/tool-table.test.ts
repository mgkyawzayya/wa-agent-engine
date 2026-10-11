import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { toolOk } from '../../src/tools/result.js';
import { TOOLS } from '../../src/tools/registry.js';
import { runTool, type ToolEntry } from '../../src/tools/tool.js';

// The rendered image is replaced, so the inline-size rule can be checked without drawing a
// huge map.
const renderMap = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/renderer.js', () => ({ renderMap }));
const { MAX_INLINE_PNG_BYTES, renderMapPreviewTool } = await import('../../src/tools/render-map-preview.js');

afterEach(() => renderMap.mockReset());

const fake = (data: unknown): ToolEntry =>
  ({
    name: 'fake_tool',
    command: 'fake',
    title: 'Fake',
    description: 'Returns what it is given',
    input: z.strictObject({}),
    output: z.strictObject({ count: z.number() }),
    annotations: {},
    run: async () => toolOk(data),
  }) as unknown as ToolEntry;

describe('every result is held to the output schema it advertises', () => {
  test('a matching result passes as it is', async () => {
    expect(await runTool(fake({ count: 1 }), {})).toEqual({ ok: true, data: { count: 1 } });
  });

  test('an extra key or a wrong type is an INTERNAL error on both surfaces', async () => {
    for (const data of [{ count: 1, extra: true }, { count: 'one' }]) {
      expect(await runTool(fake(data), {})).toEqual({
        ok: false,
        error: { code: 'INTERNAL', message: 'fake_tool produced a result that does not match its output schema' },
      });
    }
  });
});

describe('render_map_preview inlines only images an agent can take', () => {
  const result = { pngPath: '.wa-preview/venue@1x.png', width: 64, height: 64, bytes: 0, sha256: 'x' };

  test('an image at the limit comes back inline, a larger one by path only', async () => {
    renderMap.mockResolvedValueOnce({ ...result, png: new Uint8Array(MAX_INLINE_PNG_BYTES) });
    const small = await renderMapPreviewTool.run({ projectDir: '/p', mapPath: 'venue.tmj' });
    expect(small.ok && small.png?.length).toBe(MAX_INLINE_PNG_BYTES);

    renderMap.mockResolvedValueOnce({ ...result, png: new Uint8Array(MAX_INLINE_PNG_BYTES + 1) });
    const large = await renderMapPreviewTool.run({ projectDir: '/p', mapPath: 'venue.tmj' });
    expect(large).toEqual({ ok: true, data: result });
  });

  test('the limit is 5 MiB once base64-encoded', () => {
    expect(Math.ceil(MAX_INLINE_PNG_BYTES / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
});

test('place_prefab lists every built-in prefab id, so agents need no failing call to find them', async () => {
  const set = JSON.parse(await readFile(new URL('../../assets/sets/wa-starter-office/set.json', import.meta.url), 'utf8')) as { prefabs: { id: string }[] };
  const description = TOOLS.find((t) => t.name === 'place_prefab')!.description;
  for (const { id } of set.prefabs) expect(description).toContain(id);
});

test('every tool declares that it reaches nothing outside the project', () => {
  for (const tool of TOOLS) expect(tool.annotations.openWorldHint).toBe(false);
});
