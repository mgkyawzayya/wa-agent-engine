// Checks the agent skills in skills/ against the agentskills.io format and against the engine
// they describe, so a skill can never send an agent to a tool, command, code, or file that
// does not exist.
//
//   npx tsx scripts/check-skills.ts [--skills-dir <dir>]
//
// Exits 0 when every check passes, else 1 with one line per problem.
//
// The checks:
// - SKILL.md frontmatter uses spec fields only (name, description, license, compatibility,
//   metadata) with valid values, and name matches the folder;
// - each SKILL.md is under 500 lines;
// - every MCP tool (snake_case word) and CLI command (a code line that runs
//   `wa-agent-engine <command>`, or a command in backticks next to the word "command") is in
//   the tool table;
// - every error or validation code (UPPER_SNAKE word) is a real code;
// - every relative link resolves, inside the skill folder and at most one folder deep;
// - the generated prefab catalog of wa-map-design is up to date.
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ERROR_CODES } from '../src/core/errors.js';
import { VALIDATION_CODES } from '../src/core/validator.js';
import { WA_ZONE_PROPERTY_NAMES } from '../src/schemas/wa.schema.js';
import { TOOLS } from '../src/tools/registry.js';
import { CATALOG_IN_SKILLS, staleCatalogProblem } from './gen-prefab-reference.js';

export const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
// The spec asks for SKILL.md to stay under 500 lines.
export const MAX_SKILL_LINES = 499;

const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const COMMANDS = new Set([...TOOLS.map((t) => t.command), 'mcp']);
const CODES = new Set<string>([...ERROR_CODES, ...VALIDATION_CODES]);
// snake_case words the docs may use that are not MCP tools: WA property names, the zones layer,
// and Codex configuration keys.
const NON_TOOL_IDENTIFIERS = new Set<string>([...WA_ZONE_PROPERTY_NAMES.filter((n) => n.includes('_')), 'wa_zones', 'mcp_servers', 'startup_timeout_sec']);
// UPPER_SNAKE words the docs may use that are not codes: the exported code lists and the
// sample script's environment variable. Add a word here only if it is not a code.
const NON_CODE_IDENTIFIERS = new Set<string>(['ERROR_CODES', 'VALIDATION_CODES', 'WA_AGENT_ENGINE']);

const SNAKE_WORD = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const UPPER_SNAKE_WORD = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
// A command line that runs the CLI, bare or through npx, in a code block or code span.
const CLI_CALL = /^[ \t]*(?:\$[ \t]+)?(?:npx[ \t]+(?:(?:-y|--yes)[ \t]+)?)?wa-agent-engine(?:@[0-9A-Za-z.+-]+)?[ \t]+([a-z][a-z0-9-]*)/gm;
const COMMAND_PHRASES = [/`([a-z][a-z0-9-]*)`[ \t]+command\b/g, /\bcommand[ \t]+`([a-z][a-z0-9-]*)`/g];
const LINK = /!?\[[^\]\n]*\]\(([^)\s]+)(?:[ \t]+"[^"\n]*")?\)/g;

// ---- frontmatter: the small YAML subset skills need, refusing anything it cannot read exactly ----

type FrontmatterValue = string | Map<string, string>;

interface Frontmatter {
  fields: Map<string, FrontmatterValue>;
  problems: string[];
}

// YAML would read these plain scalars as something other than a string.
const NON_STRING_SCALAR =
  /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/i;

function parseScalar(raw: string, where: string, problems: string[]): string | undefined {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'string') return value;
    } catch {
      // reported below
    }
    problems.push(`${where}: the double-quoted value is not closed or has an escape this checker cannot read`);
    return undefined;
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'") || /(?<!')'(?!')/.test(text.slice(1, -1))) {
      problems.push(`${where}: the single-quoted value is not closed`);
      return undefined;
    }
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (text === '') {
    problems.push(`${where}: the value is empty`);
    return undefined;
  }
  if (/^[|>]/.test(text)) {
    problems.push(`${where}: block scalars (| or >) are not supported here; write the value on one line`);
    return undefined;
  }
  if (/^(?:[[\]{}&*!%@`,#]|[-?:](?:\s|$))/.test(text) || /:\s|:$|\s#/.test(text)) {
    problems.push(`${where}: this plain value is not a valid YAML string (it starts with a YAML indicator or holds ": " or " #"); quote it`);
    return undefined;
  }
  if (NON_STRING_SCALAR.test(text)) {
    problems.push(`${where}: YAML reads "${text}" as a number, boolean or null, not a string; quote it`);
    return undefined;
  }
  return text;
}

export function parseFrontmatter(text: string): Frontmatter {
  const all = text.split('\n');
  const problems: string[] = [];
  const fields = new Map<string, FrontmatterValue>();
  if (all[0]?.trimEnd() !== '---') return { fields, problems: ['SKILL.md must start with a --- frontmatter line'] };
  const end = all.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (end === -1) return { fields, problems: ['the frontmatter has no closing --- line'] };
  let nested: Map<string, string> | undefined;
  for (let i = 1; i < end; i++) {
    const line = all[i]!.trimEnd();
    const where = `frontmatter line ${i + 1}`;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const top = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (top !== null) {
      const key = top[1]!;
      const raw = top[2];
      nested = undefined;
      if (fields.has(key)) problems.push(`${where}: "${key}" appears twice`);
      if (raw === undefined || raw.trim() === '') {
        nested = new Map();
        fields.set(key, nested);
      } else {
        const value = parseScalar(raw, where, problems);
        if (value !== undefined) fields.set(key, value);
      }
      continue;
    }
    const child = /^[ \t]+([A-Za-z0-9_.-]+):[ \t]+(.*)$/.exec(line);
    if (child !== null && nested !== undefined) {
      const key = child[1]!;
      const raw = child[2]!;
      if (nested.has(key)) problems.push(`${where}: "${key}" appears twice`);
      const value = parseScalar(raw, where, problems);
      if (value !== undefined) nested.set(key, value);
      continue;
    }
    problems.push(`${where}: unsupported syntax; use "key: value" lines, and indented "key: value" lines under metadata`);
  }
  return { fields, problems };
}

export function frontmatterProblems(frontmatter: Frontmatter, folder: string): string[] {
  const problems = [...frontmatter.problems];
  const { fields } = frontmatter;
  for (const key of fields.keys()) {
    if (!SPEC_FIELDS.has(key)) problems.push(`frontmatter field "${key}" is not a spec field (allowed: ${[...SPEC_FIELDS].join(', ')})`);
  }
  const text = (key: string): string | undefined => {
    const value = fields.get(key);
    if (value instanceof Map) {
      problems.push(`frontmatter field "${key}" must be a string, not a map`);
      return undefined;
    }
    return value;
  };
  const name = text('name');
  if (name === undefined) {
    if (!fields.has('name')) problems.push('frontmatter needs a name');
  } else {
    if (name.length > 64 || !NAME_PATTERN.test(name)) {
      problems.push(`name "${name}" must be 1-64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen`);
    }
    if (name !== folder) problems.push(`name "${name}" must match its folder name "${folder}"`);
  }
  const description = text('description');
  if (description === undefined) {
    if (!fields.has('description')) problems.push('frontmatter needs a description');
  } else if (description.length < 1 || description.length > 1024) {
    problems.push(`description must be 1-1024 characters, not ${description.length}`);
  }
  if (fields.has('license') && text('license')?.trim() === '') problems.push('license must not be empty');
  const compatibility = fields.has('compatibility') ? text('compatibility') : undefined;
  if (compatibility !== undefined && (compatibility.length < 1 || compatibility.length > 500)) {
    problems.push(`compatibility must be 1-500 characters, not ${compatibility.length}`);
  }
  const metadata = fields.get('metadata');
  if (metadata !== undefined && !(metadata instanceof Map)) problems.push('metadata must be a map of string keys to string values');
  return problems;
}

// ---- markdown scanning ----

interface Segments {
  // Fenced code blocks and inline code spans.
  code: string[];
  // Everything else.
  prose: string;
}

export function splitCode(markdown: string): Segments {
  const code: string[] = [];
  const prose: string[] = [];
  let fence: string | undefined;
  let block: string[] = [];
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && marker !== undefined) {
      fence = marker;
      block = [];
      continue;
    }
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        code.push(block.join('\n'));
        fence = undefined;
      } else {
        block.push(line);
      }
      continue;
    }
    prose.push(line.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1/g, (_match, _ticks: string, inner: string) => {
      code.push(inner);
      return ' ';
    }));
  }
  if (fence !== undefined) code.push(block.join('\n'));
  return { code, prose: prose.join('\n') };
}

function unique(matches: Iterable<RegExpMatchArray>, group = 0): string[] {
  return [...new Set([...matches].map((m) => m[group]!))];
}

export function mentionProblems(markdown: string): string[] {
  const problems: string[] = [];
  const { code } = splitCode(markdown);
  for (const word of unique(markdown.matchAll(SNAKE_WORD))) {
    if (!TOOL_NAMES.has(word) && !NON_TOOL_IDENTIFIERS.has(word)) {
      problems.push(`mentions "${word}", which is not an MCP tool (tools: ${[...TOOL_NAMES].join(', ')}); if it is not meant as a tool, add it to NON_TOOL_IDENTIFIERS in scripts/check-skills.ts`);
    }
  }
  for (const word of unique(markdown.matchAll(UPPER_SNAKE_WORD))) {
    if (!CODES.has(word) && !NON_CODE_IDENTIFIERS.has(word)) {
      problems.push(`mentions "${word}", which is not an error or validation code; if it is not meant as a code, add it to NON_CODE_IDENTIFIERS in scripts/check-skills.ts`);
    }
  }
  const commands = new Set<string>();
  for (const segment of code) for (const m of segment.matchAll(CLI_CALL)) commands.add(m[1]!);
  for (const pattern of COMMAND_PHRASES) for (const m of markdown.matchAll(pattern)) commands.add(m[1]!);
  for (const command of commands) {
    if (!COMMANDS.has(command)) problems.push(`mentions the CLI command "${command}", which does not exist (commands: ${[...COMMANDS].join(', ')})`);
  }
  return problems;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Relative links must resolve inside the skill folder (an installed skill is copied on its
// own) and at most one folder below its root, as the spec asks.
export async function linkProblems(markdown: string, file: string, skillDir: string, options: { anyDepth?: boolean } = {}): Promise<string[]> {
  const problems: string[] = [];
  for (const target of unique(splitCode(markdown).prose.matchAll(LINK), 1)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    let path: string;
    try {
      path = decodeURIComponent(target.replace(/[?#].*$/, ''));
    } catch {
      problems.push(`link "${target}" is not a valid URL path`);
      continue;
    }
    if (path === '') continue;
    const abs = resolve(dirname(file), path);
    const inSkill = relative(skillDir, abs);
    if (isAbsolute(path) || inSkill.startsWith('..') || isAbsolute(inSkill)) {
      problems.push(`link "${target}" leaves the skill folder; an installed skill only has its own files`);
      continue;
    }
    if (options.anyDepth !== true && inSkill.split(sep).length > 2) problems.push(`link "${target}" is more than one folder deep; keep references one level below SKILL.md`);
    if (!(await exists(abs))) problems.push(`link "${target}" does not resolve to a file`);
  }
  return problems;
}

async function markdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files.sort();
}

export async function checkSkills(skillsDir: string = SKILLS_DIR): Promise<string[]> {
  const root = dirname(resolve(skillsDir));
  const shown = (path: string): string => relative(root, path).split(sep).join('/');
  const problems: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [`${skillsDir}: the skills folder cannot be read`];
  }
  const skills = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (skills.length === 0) problems.push(`${shown(skillsDir)}: no skills found`);
  for (const skill of skills) {
    const skillDir = join(skillsDir, skill);
    const skillFile = join(skillDir, 'SKILL.md');
    if (!(await exists(skillFile))) {
      problems.push(`${shown(skillDir)}: has no SKILL.md`);
      continue;
    }
    for (const file of await markdownFiles(skillDir)) {
      const text = await readFile(file, 'utf8');
      const report = (list: string[]): void => {
        for (const p of list) problems.push(`${shown(file)}: ${p}`);
      };
      if (file === skillFile) {
        report(frontmatterProblems(parseFrontmatter(text), skill));
        const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
        if (lines > MAX_SKILL_LINES) report([`has ${lines} lines; keep SKILL.md under 500 lines and move detail into references/`]);
      }
      report(mentionProblems(text));
      report(await linkProblems(text, file, skillDir));
    }
  }
  // The README and docs/ describe the same tools and codes, so they are held to the same names
  // and their links must resolve inside the repository.
  const docsDir = join(root, 'docs');
  const docs = [join(root, 'README.md'), ...((await exists(docsDir)) ? await markdownFiles(docsDir) : [])];
  for (const file of docs) {
    if (!(await exists(file))) continue;
    const text = await readFile(file, 'utf8');
    for (const p of [...mentionProblems(text), ...(await linkProblems(text, file, root, { anyDepth: true }))]) problems.push(`${shown(file)}: ${p}`);
  }
  if (skills.includes('wa-map-design')) {
    const catalog = join(skillsDir, CATALOG_IN_SKILLS);
    const problem = await staleCatalogProblem(catalog);
    if (problem !== undefined) problems.push(`${shown(catalog)}: ${problem}`);
  }
  return problems;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { 'skills-dir': { type: 'string' } }, strict: true, allowPositionals: false });
    const problems = await checkSkills(values['skills-dir'] ?? SKILLS_DIR);
    if (problems.length > 0) {
      console.error(`check-skills: ${problems.length} problem(s)\n${problems.map((p) => `- ${p}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('check-skills: all skills pass');
    }
  } catch (err) {
    console.error(`check-skills: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
