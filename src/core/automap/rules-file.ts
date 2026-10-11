import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RuleMap, RuleMapReference, RuleSet } from '../../schemas/automap.schema.js';
import { WaEngineError, type ErrorBody } from '../errors.js';
import { readFileBounded } from '../map-io.js';
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

export async function loadRules(projectDir: string, rulesAbs: string): Promise<RuleSet> {
  const project = await assertProjectDir(projectDir);
  const givenRoot = resolve(projectDir);
  // Paths may reach the project through a symbolic link (macOS /tmp is one). Like Tiled, lines
  // are resolved against each rules file's folder as given; every file is then checked and
  // read through its real path.
  const relOf = (abs: string): string => slashes(relative(isInside(givenRoot, abs) ? givenRoot : project, abs));
  const shown = (abs: string): string => slashes(relative(project, abs));
  const topGiven = isAbsolute(rulesAbs) ? rulesAbs : resolve(projectDir, rulesAbs);
  const topReal = await resolveInProject(project, relOf(topGiven), { ext: ['.txt', ...RULE_MAP_EXTENSIONS] });
  const loaded = new Map<string, Promise<RuleMap>>();
  const references: RuleMapReference[] = [];
  const warnings: ErrorBody[] = [];
  const hash = createHash('sha256');
  const addReference = async (filter: RegExp | undefined, abs: string): Promise<void> => {
    const ruleMap = await ruleMapAt(abs);
    hash.update(`map\0${ruleMap.relPath}\0${ruleMap.hash}\0`);
    references.push({ filter, ruleMap });
  };

  const ruleMapAt = (abs: string): Promise<RuleMap> => {
    let pending = loaded.get(abs);
    if (pending === undefined) {
      pending = loadRuleMap(project, abs, shown(abs));
      loaded.set(abs, pending);
    }
    return pending;
  };

  const readRules = async (real: string): Promise<string> => {
    const rel = shown(real);
    const bytes = await readFileBounded(real, MAX_RULES_FILE_BYTES, {
      open: (errno) =>
        errno === 'ENOENT' || errno === 'ENOTDIR'
          ? new WaEngineError('AUTOMAP_RULES_NOT_FOUND', `rules file not found: ${rel}`, { rules: rel })
          : new WaEngineError('AUTOMAP_RULES_INVALID', `rules file cannot be read (${errno ?? 'error'}): ${rel}`, { rules: rel }),
      notFile: () => new WaEngineError('AUTOMAP_RULES_NOT_FOUND', `rules file is not a file: ${rel}`, { rules: rel }),
      tooLarge: () => new WaEngineError('AUTOMAP_RULES_INVALID', `rules file is larger than ${MAX_RULES_FILE_BYTES / 1024} KB: ${rel}`, { rules: rel }),
    });
    // Line endings do not count, so a checkout with CRLF has the same rules.
    const text = bytes.toString('utf8');
    hash.update(`rules\0${rel}\0${text.replaceAll('\r\n', '\n')}\0`);
    return text;
  };

  const parse = async (given: string, real: string, stack: readonly string[], inherited: RegExp | undefined): Promise<void> => {
    const text = await readRules(real);
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
          warnings.push({ code: 'AUTOMAP_RULES_IGNORED', message: `${shown(real)}: filter ${line} is not a valid pattern; the rule maps after it apply to every map`, details: { rules: shown(real), filter: line } });
        }
        continue;
      }
      const target = resolve(dirname(given), line);
      const rel = relOf(target);
      if (extname(target).toLowerCase() === '.tmx') {
        throw new WaEngineError('PATH_BAD_EXTENSION', `rule map ${rel} is a .tmx file: save it as JSON (.tmj) in Tiled`, { ruleMap: rel });
      }
      const abs = await resolveInProject(project, rel, { ext: ['.txt', ...RULE_MAP_EXTENSIONS] });
      if (extname(abs).toLowerCase() === '.txt') {
        if (stack.includes(abs)) {
          throw new WaEngineError('AUTOMAP_RULES_INVALID', `rules files include each other in a cycle: ${shown(abs)}`, { rules: shown(abs), cycle: [...stack, abs].map(shown) });
        }
        if (stack.length >= MAX_INCLUDE_DEPTH) {
          throw new WaEngineError('AUTOMAP_RULES_INVALID', `rules files are included more than ${MAX_INCLUDE_DEPTH} levels deep`, { rules: shown(abs) });
        }
        await parse(target, abs, [...stack, abs], filter);
        continue;
      }
      if (references.length >= MAX_REFERENCES) {
        throw new WaEngineError('AUTOMAP_RULES_INVALID', `rules files list more than ${MAX_REFERENCES} rule maps`, { rules: shown(topReal) });
      }
      await addReference(filter, abs);
    }
  };

  if (extname(topReal).toLowerCase() === '.txt') await parse(topGiven, topReal, [topReal], undefined);
  else await addReference(undefined, topReal);
  return { projectDir: project, rulesPath: shown(topReal), rulesAbs: topReal, references, warnings, hash: hash.digest('hex') };
}
