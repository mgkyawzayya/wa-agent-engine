import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { TOOLS } from '../../src/tools/registry.js';
import { VERSION } from '../../src/version.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

// Every CLI example in the map-design skill runs, in the order the docs give, and every
// validation it shows comes back clean. Examples use "/path/to/map-starter-kit" for the project.

const SKILL = fileURLToPath(new URL('../../skills/wa-map-design/', import.meta.url));
const PLACEHOLDER = '/path/to/map-starter-kit';
// Pinned to this package's version, as the docs are.
const COMMAND = new RegExp(`npx -y wa-agent-engine@${VERSION.replaceAll('.', '\\.')} ([a-z]+) (?:--input '([\\s\\S]*?)'|--input-file (\\S+))`, 'g');

interface Step {
  command: string;
  input: string | { file: string };
}

// The commands of a markdown file in order, plus the JSON blocks it asks to save as files.
async function stepsOf(doc: string): Promise<{ steps: Step[]; files: Map<string, string> }> {
  const text = await readFile(join(SKILL, doc), 'utf8');
  const steps: Step[] = [];
  const files = new Map<string, string>();
  for (const block of text.matchAll(/(?:Save this input as `([^`]+)`:\s*)?```(\w*)\n([\s\S]*?)```/g)) {
    const [, saveAs, lang, body] = block;
    if (lang === 'json' && saveAs !== undefined) files.set(saveAs, body!);
    if (lang !== 'bash') continue;
    for (const m of body!.matchAll(COMMAND)) {
      if (m[1] === undefined || m[0].includes('<')) continue;
      steps.push({ command: m[1], input: m[2] ?? { file: m[3]! } });
    }
  }
  return { steps, files };
}

async function run(project: TempProject, docs: string[]): Promise<{ command: string; ok: boolean; result: unknown }[]> {
  const out: { command: string; ok: boolean; result: unknown }[] = [];
  for (const doc of docs) {
    const { steps, files } = await stepsOf(doc);
    for (const step of steps) {
      const raw = typeof step.input === 'string' ? step.input : files.get(step.input.file);
      if (raw === undefined) throw new Error(`${doc}: ${step.command} reads ${JSON.stringify(step.input)}, which the doc never shows`);
      const tool = TOOLS.find((t) => t.command === step.command);
      if (tool === undefined) throw new Error(`${doc}: unknown command ${step.command}`);
      const parsed = tool.input.safeParse(JSON.parse(raw.replaceAll(PLACEHOLDER, project.dir)));
      if (!parsed.success) throw new Error(`${doc}: ${step.command} input does not parse: ${parsed.error.message}`);
      const outcome = await tool.run(parsed.data);
      out.push({ command: `${doc} ${step.command}`, ok: outcome.ok, result: outcome.ok ? outcome.data : outcome.error });
    }
  }
  return out;
}

describe.each([
  ['the skill walkthrough and its zone examples', ['SKILL.md', 'references/zone-properties.md']],
  ['the DSL reference example', ['references/dsl-reference.md']],
  ['the VarCamp recipe', ['references/varcamp-venue-recipe.md']],
])('%s', (_name, docs) => {
  let project: TempProject;
  let results: { command: string; ok: boolean; result: unknown }[];
  beforeAll(async () => {
    project = await makeFullProject();
    results = await run(project, docs);
  }, 60_000);
  afterAll(() => project.cleanup());

  test('every command succeeds', () => {
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  test('every validation is clean', () => {
    const validations = results.filter((r) => r.command.endsWith(' validate'));
    expect(validations.length).toBeGreaterThan(0);
    for (const v of validations) expect(v.result).toMatchObject({ ok: true, errors: [], warnings: [] });
  });
});

test('the example parser sees the commands it should', async () => {
  const { steps, files } = await stepsOf('references/varcamp-venue-recipe.md');
  expect(steps.map((s) => s.command)).toEqual(expect.arrayContaining(['scaffold', 'build', 'prefab', 'zone', 'validate', 'render']));
  expect([...files.keys()]).toEqual(['varcamp.build.json']);
});
