import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AUTOMAP_LAYER_NAME, checkSkills, frontmatterProblems, mentionProblems, parseFrontmatter } from '../../scripts/check-skills.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);

async function script(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', ...args], { cwd: REPO_ROOT });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const problemsOf = (text: string, folder: string): string[] => frontmatterProblems(parseFrontmatter(text), folder);

describe('frontmatter', () => {
  test('spec fields with quoted values and a metadata map pass', () => {
    const text = [
      '---',
      'name: demo-skill',
      'description: "Draws demo maps: use it for demos."',
      "license: 'Apache-2.0'",
      'compatibility: Needs Node.js 26',
      'metadata:',
      '  author: someone',
      '  version: "1.0"',
      '---',
      '# Demo',
    ].join('\n');
    expect(problemsOf(text, 'demo-skill')).toEqual([]);
  });

  test('values a YAML parser would misread are refused', () => {
    const text = ['---', 'name: demo-skill', 'description: >', '  folded', 'metadata:', '  version: 1.0', '---'].join('\n');
    const problems = problemsOf(text, 'demo-skill');
    expect(problems).toContainEqual(expect.stringContaining('block scalars'));
    expect(problems).toContainEqual(expect.stringContaining('YAML reads "1.0" as a number'));
  });

  test('missing fields, a bad name and an over-long compatibility are reported', () => {
    const text = ['---', 'name: Bad--Name', `compatibility: ${'x'.repeat(501)}`, '---'].join('\n');
    const problems = problemsOf(text, 'bad-name');
    expect(problems).toContainEqual(expect.stringContaining('must be 1-64 lowercase letters'));
    expect(problems).toContainEqual(expect.stringContaining('must match its folder name "bad-name"'));
    expect(problems).toContainEqual('frontmatter needs a description');
    expect(problems).toContainEqual(expect.stringContaining('compatibility must be 1-500 characters'));
  });

  test('a file without frontmatter is reported', () => {
    expect(problemsOf('# No frontmatter', 'demo')).toContainEqual('SKILL.md must start with a --- frontmatter line');
  });
});

test('the shipped skills pass every check', async () => {
  expect(await checkSkills()).toEqual([]);
});

describe('a broken skills folder', () => {
  let dir: string;
  let skills: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wa-skills-'));
    skills = join(dir, 'skills');
    const design = join(skills, 'wa-map-design');
    await mkdir(join(design, 'references', 'a'), { recursive: true });
    await mkdir(join(skills, 'no-skill-md'), { recursive: true });
    await mkdir(join(skills, 'bad--name'), { recursive: true });
    await writeFile(join(design, 'references', 'prefab-catalog.md'), '# An old catalog\n');
    await writeFile(join(design, 'references', 'a', 'b.md'), '# Too deep\n');
    await writeFile(join(design, 'references', 'good.md'), 'Run `validate_wa_map`, then the `render` command.\n');
    const body = [
      '---',
      'name: wa-map',
      'description: Draws maps: badly',
      'allowed-tools: Bash',
      '---',
      'Call `paint_map`, or `build_room_from_dsl` with `zoom_margin`, and handle `MAP_CHANGED_ON_DISK` and NO_SUCH_CODE.',
      '',
      '```bash',
      "npx -y wa-agent-engine@0.3.0 paint --input '{}'",
      "npx -y wa-agent-engine@0.3.0 validate --input '{}'",
      '```',
      '',
      '```json',
      '{"mapCopyright": "Built with wa-agent-engine from the starter kit"}',
      '```',
      '',
      'See [good](references/good.md), [missing](references/missing.md), [outside](../../README.md), [deep](references/a/b.md) and [web](https://example.com).',
      ...Array.from({ length: 500 }, (_, i) => `Filler line ${i}.`),
      '',
    ].join('\n');
    await writeFile(join(design, 'SKILL.md'), body);
    await writeFile(join(skills, 'bad--name', 'SKILL.md'), '---\nname: bad--name\ndescription: A skill with a bad name.\n---\n');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('fails with one problem per broken rule, and nothing on the valid parts', async () => {
    const problems = await checkSkills(skills);
    const expected = [
      'skills/wa-map-design/SKILL.md: name "wa-map" must match its folder name "wa-map-design"',
      'skills/wa-map-design/SKILL.md: frontmatter line 3: this plain value is not a valid YAML string',
      'skills/wa-map-design/SKILL.md: frontmatter field "allowed-tools" is not a spec field',
      'skills/wa-map-design/SKILL.md: mentions "paint_map", which is not an MCP tool',
      'skills/wa-map-design/SKILL.md: mentions "NO_SUCH_CODE", which is not an error or validation code',
      'skills/wa-map-design/SKILL.md: mentions the CLI command "paint", which does not exist',
      'skills/wa-map-design/SKILL.md: link "references/missing.md" does not resolve to a file',
      'skills/wa-map-design/SKILL.md: link "../../README.md" leaves the skill folder',
      'skills/wa-map-design/SKILL.md: link "references/a/b.md" is more than one folder deep',
      'skills/wa-map-design/SKILL.md: has 517 lines; keep SKILL.md under 500 lines',
      'skills/wa-map-design/references/prefab-catalog.md: the prefab catalog is stale',
      'skills/no-skill-md: has no SKILL.md',
      'skills/bad--name/SKILL.md: name "bad--name" must be 1-64 lowercase letters',
    ];
    for (const text of expected) expect(problems).toContainEqual(expect.stringContaining(text));
    const valid = [
      'mentions "build_room_from_dsl"',
      'mentions "zoom_margin"',
      'mentions "MAP_CHANGED_ON_DISK"',
      'command "validate"',
      'command "from"',
      'link "references/good.md"',
      'link "https://example.com"',
      'references/good.md:',
    ];
    for (const text of valid) expect(problems.filter((p) => p.includes(text))).toEqual([]);
  });

  test('the script exits 1 with the problem list, and 0 on the shipped skills', async () => {
    const broken = await script(['scripts/check-skills.ts', '--skills-dir', skills]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toContain('problem(s)');
    expect(broken.stderr).toContain('mentions the CLI command "paint"');
    const shipped = await script(['scripts/check-skills.ts']);
    expect(shipped).toMatchObject({ code: 0, stdout: 'check-skills: all skills pass\n' });
  });

  test('gen-prefab-reference --check exits 1 on a stale catalog and 0 on the committed one', async () => {
    const stale = await script(['scripts/gen-prefab-reference.ts', '--check', '--file', join(skills, 'wa-map-design', 'references', 'prefab-catalog.md')]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain('the prefab catalog is stale');
    const missing = await script(['scripts/gen-prefab-reference.ts', '--check', '--file', join(dir, 'nothing.md')]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('the prefab catalog is missing');
    expect((await script(['scripts/gen-prefab-reference.ts', '--check'])).code).toBe(0);
  });
});

describe('Tiled automapping layer names are not tools', () => {
  test('layer names pass; made-up tool-like names do not', () => {
    for (const name of ['input_floor', 'inputnot2_walls', 'output1_walls', 'rule_options', 'regions_input']) expect(AUTOMAP_LAYER_NAME.test(name), name).toBe(true);
    for (const name of ['inputfoo_bar', 'outputs_wa_zone', 'automap_maps', 'render_map']) expect(AUTOMAP_LAYER_NAME.test(name), name).toBe(false);
    expect(mentionProblems('Paint `input_floor` and `rule_options`, then call `automap_map`.')).toEqual([]);
    expect(mentionProblems('Call `automap_mapp`.')).toHaveLength(1);
  });
});
