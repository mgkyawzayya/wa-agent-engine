import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RuleMap, RuleMapReference, RuleSet } from '../../schemas/automap.schema.js';
import { WaEngineError, type ErrorBody } from '../errors.js';
import { assertProjectDir, isInside, resolveInProject } from '../project-paths.js';
import { loadRuleMap } from './rule-map.js';

// Reads a Tiled rules file (rules.txt): one rule map or included .txt per line, relative to
// the file; `#` and `//` comment lines; `[pattern]` lines filter the following rule maps by
// the working map's file name. A rules path may also name a single rule map, as Tiled's
// project "Automapping rules" setting allows.

const RULE_MAP_EXTENSIONS = ['.tmj', '.json'];
const MAX_RULES_FILE_BYTES = 1024 * 1024;
const MAX_INCLUDE_DEPTH = 16;
const MAX_REFERENCES = 1000;

// Qt's QRegularExpression::wildcardToRegularExpression: `*` and `?` do not cross "/", `[...]`
// is a character class (`[!...]` negated). Anchored and case-insensitive, as Tiled uses it.
// Throws a SyntaxError for a pattern that makes no valid expression.
export function wildcardToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '!') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j++;
      if (j >= pattern.length) {
        out += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, j);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      out += `[${body.replaceAll('\\', '\\\\')}]`;
      i = j;
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^(?:${out})$`, 'i');
}

const slashes = (p: string): string => p.split(sep).join('/');

async function isFile(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

export async function loadRules(projectDir: string, rulesAbs: string): Promise<RuleSet> {
  const project = await assertProjectDir(projectDir);
  // The caller's paths may go through a symbolic link to the project (macOS /tmp is one):
  // take the path relative to whichever form of the project contains it.
  const given = isAbsolute(rulesAbs) ? rulesAbs : resolve(projectDir, rulesAbs);
  const base = isInside(resolve(projectDir), given) ? resolve(projectDir) : project;
  const top = await resolveInProject(project, slashes(relative(base, given)), { ext: ['.txt', ...RULE_MAP_EXTENSIONS] });
  const shown = (abs: string): string => slashes(relative(project, abs));
  const loaded = new Map<string, Promise<RuleMap>>();
  const references: RuleMapReference[] = [];
  const warnings: ErrorBody[] = [];

  const ruleMapAt = (abs: string): Promise<RuleMap> => {
    let pending = loaded.get(abs);
    if (pending === undefined) {
      pending = loadRuleMap(project, abs, shown(abs));
      loaded.set(abs, pending);
    }
    return pending;
  };

  const parse = async (fileAbs: string, stack: readonly string[], inherited: RegExp | undefined): Promise<void> => {
    if (!(await isFile(fileAbs))) throw new WaEngineError('AUTOMAP_RULES_NOT_FOUND', `rules file not found: ${shown(fileAbs)}`, { rules: shown(fileAbs) });
    if ((await stat(fileAbs)).size > MAX_RULES_FILE_BYTES) {
      throw new WaEngineError('AUTOMAP_RULES_INVALID', `rules file is larger than ${MAX_RULES_FILE_BYTES / 1024} KB: ${shown(fileAbs)}`, { rules: shown(fileAbs) });
    }
    const text = await readFile(fileAbs, 'utf8');
    let filter = inherited;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
      if (line.startsWith('[') && line.endsWith(']')) {
        try {
          filter = wildcardToRegExp(line.slice(1, -1));
        } catch {
          // Tiled ignores a filter that makes no valid expression: the rule maps after it
          // apply to every map.
          filter = undefined;
          warnings.push({ code: 'AUTOMAP_RULES_IGNORED', message: `${shown(fileAbs)}: filter ${line} is not a valid pattern; the rule maps after it apply to every map`, details: { rules: shown(fileAbs), filter: line } });
        }
        continue;
      }
      const target = resolve(dirname(fileAbs), line);
      const rel = shown(target);
      if (extname(target).toLowerCase() === '.tmx') {
        throw new WaEngineError('PATH_BAD_EXTENSION', `rule map ${rel} is a .tmx file: save it as JSON (.tmj) in Tiled`, { ruleMap: rel });
      }
      const abs = await resolveInProject(project, rel, { ext: ['.txt', ...RULE_MAP_EXTENSIONS] });
      if (extname(abs).toLowerCase() === '.txt') {
        if (stack.includes(abs)) {
          throw new WaEngineError('AUTOMAP_RULES_INVALID', `rules files include each other in a cycle: ${rel}`, { rules: rel, cycle: [...stack, abs].map(shown) });
        }
        if (stack.length >= MAX_INCLUDE_DEPTH) {
          throw new WaEngineError('AUTOMAP_RULES_INVALID', `rules files are included more than ${MAX_INCLUDE_DEPTH} levels deep`, { rules: rel });
        }
        await parse(abs, [...stack, abs], filter);
        continue;
      }
      if (!(await isFile(abs))) {
        throw new WaEngineError('AUTOMAP_RULES_NOT_FOUND', `rule map not found: ${rel} (listed in ${shown(fileAbs)})`, { ruleMap: rel });
      }
      if (references.length >= MAX_REFERENCES) {
        throw new WaEngineError('AUTOMAP_RULES_INVALID', `rules files list more than ${MAX_REFERENCES} rule maps`, { rules: shown(top) });
      }
      references.push({ filter, ruleMap: await ruleMapAt(abs) });
    }
  };

  if (extname(top).toLowerCase() === '.txt') await parse(top, [top], undefined);
  else {
    if (!(await isFile(top))) throw new WaEngineError('AUTOMAP_RULES_NOT_FOUND', `rule map not found: ${shown(top)}`, { ruleMap: shown(top) });
    references.push({ filter: undefined, ruleMap: await ruleMapAt(top) });
  }
  return { projectDir: project, rulesPath: shown(top), rulesAbs: top, references, warnings };
}
