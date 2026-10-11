import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { MARKER_TILESET, type Drawing, type FloorStyle } from '../../schemas/asset-set.schema.js';
import { TiledTilesetFileSchema, type TiledEmbeddedTileset, type TiledTilesetFields } from '../../schemas/tiled.schema.js';
import { loadAssetSet, PROJECT_SETS_DIR } from '../asset-set-registry.js';
import { WaEngineError } from '../errors.js';
import { NO_HARD_LINKS, serializeMap } from '../map-io.js';
import { ensureMarkerImage, ensureRuleTilesImage, MARKER_IMAGE, MARKER_PALETTE, markerTsj, RULE_TILES, RULE_TILES_IMAGE, RULE_TILES_TILESET } from '../markers.js';
import { assertProjectDir, mapRelativePath, resolveInProject, resolveMapRelative } from '../project-paths.js';
import { MAX_RULE_MAP_TILES } from './rule-map.js';
import { buildTemplate, type TemplateRuleInfo } from './template.js';

// automap_template: writes a ready-to-paint rule map for an asset set drawn with automapping
// rules (rules.txt, walls.tmj and a README with the three onboarding steps), with the marker
// tileset, the special tiles and the user's tilesets attached.

export interface AutomapTemplateOptions {
  projectDir: string;
  assetSet?: string;
  outDir: string;
  tilesets: string[];
  overwrite?: boolean;
}

export interface AutomapTemplateResult {
  ruleMap: string;
  rulesFile: string;
  readme: string;
  rules: TemplateRuleInfo[];
  markerTileset: string;
  markers: Drawing['markers'];
  wallStyles: { default: string; names: string[] };
  floorStyles: { default: string; styles: Record<string, FloorStyle> };
}

export const MAX_TEMPLATE_TILESETS = 32;
const MAX_TILESET_TILES = 65536;
const FILES = { ruleMap: 'walls.tmj', rulesFile: 'rules.txt', readme: 'README.md' } as const;
// The first lines that mark rules.txt and README.md as written by this tool.
const RULES_HEADER = '# Automapping rules for the sketch a room build paints, written by wa-agent-engine automap_template.\n';
const README_HEADER = '# Automapping rules to paint\n';
const PLAIN = 'plain';
// The fields that make an embedded tileset the same tileset as the one a map embeds.
const IDENTITY_KEYS = ['columns', 'imageheight', 'imagewidth', 'margin', 'name', 'spacing', 'tilecount', 'tileheight', 'tileoffset', 'tilewidth'] as const;

const errnoOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;
const slashes = (p: string): string => p.split(sep).join('/');

interface Styles {
  wallStyles: AutomapTemplateResult['wallStyles'];
  floorStyles: AutomapTemplateResult['floorStyles'];
  markerTileset: string;
  markers: Drawing['markers'];
  // A set's own marker tileset: its .tsj fields and image path relative to the project.
  ownMarkers?: { fields: TiledTilesetFields; image: string };
}

// The styles and markers of the set, or one plain wall style and floor style without one. A
// set drawn with rules keeps its markers; any other set gets wa-markers in order: the wall,
// the door, the floors, then the wall styles (on their own layer, so they may repeat colours).
async function stylesFor(projectDir: string, assetSet: string | undefined): Promise<Styles> {
  if (assetSet === undefined) {
    return {
      wallStyles: { default: PLAIN, names: [PLAIN] },
      floorStyles: { default: PLAIN, styles: { [PLAIN]: {} } },
      markerTileset: MARKER_TILESET,
      markers: { wall: 0, door: 1, floor: { [PLAIN]: 2 }, wallStyle: { [PLAIN]: 3 } },
    };
  }
  const loaded = await loadAssetSet(assetSet, projectDir);
  const wallStyles = structuredClone(loaded.set.wallStyles);
  const floorStyles = structuredClone(loaded.set.floorStyles);
  if (loaded.kind === 'automap') {
    const { markerTileset, markers } = loaded.drawing;
    const own = markerTileset === MARKER_TILESET ? undefined : loaded.tilesets.get(markerTileset)!;
    return { wallStyles, floorStyles, markerTileset, markers: structuredClone(markers), ...(own === undefined ? {} : { ownMarkers: { fields: own.tsj, image: own.image } }) };
  }
  const floors = Object.keys(floorStyles.styles);
  const room = MARKER_PALETTE.length - 2;
  if (floors.length > room || wallStyles.names.length > MARKER_PALETTE.length) {
    throw new WaEngineError(
      'INVALID_INPUT',
      `asset set "${assetSet}" has ${floors.length} floor styles and ${wallStyles.names.length} wall styles; the ${MARKER_PALETTE.length} marker tiles hold a wall, a door and at most ${room} floor styles, and at most ${MARKER_PALETTE.length} wall styles`,
      { floorStyles: floors.length, wallStyles: wallStyles.names.length },
    );
  }
  return {
    wallStyles,
    floorStyles,
    markerTileset: MARKER_TILESET,
    markers: {
      wall: 0,
      door: 1,
      floor: Object.fromEntries(floors.map((name, i) => [name, 2 + i])),
      wallStyle: Object.fromEntries(wallStyles.names.map((name, i) => [name, (2 + floors.length + i) % MARKER_PALETTE.length])),
    },
  };
}

interface ArtTileset {
  fields: TiledTilesetFields;
  imageAbs: string;
}

// One of the user's tilesets: a Tiled JSON tileset in the project, with 32x32 tiles and an
// image that is there.
async function readArtTileset(projectDir: string, rel: string): Promise<ArtTileset> {
  const abs = await resolveInProject(projectDir, rel, { ext: ['.tsj', '.json'] });
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(abs, 'utf8'));
  } catch (err) {
    const missing = errnoOf(err) === 'ENOENT';
    throw new WaEngineError('INVALID_INPUT', missing ? `tileset not found: ${rel}` : `tileset is not readable JSON: ${rel}`, { tileset: rel });
  }
  const parsed = TiledTilesetFileSchema.safeParse(raw);
  if (!parsed.success) throw new WaEngineError('INVALID_INPUT', `not a Tiled tileset: ${rel}`, { tileset: rel });
  const fields = parsed.data;
  if (fields.tilewidth !== 32 || fields.tileheight !== 32) {
    throw new WaEngineError('INVALID_INPUT', `tileset ${rel} must use 32x32 tiles, not ${fields.tilewidth}x${fields.tileheight}`, { tileset: rel });
  }
  if (!Number.isInteger(fields.tilecount) || fields.tilecount < 1 || fields.tilecount > MAX_TILESET_TILES || !Number.isInteger(fields.columns) || fields.columns < 1) {
    throw new WaEngineError('INVALID_INPUT', `tileset ${rel} must have 1 to ${MAX_TILESET_TILES} tiles in 1 or more columns`, { tileset: rel });
  }
  if (typeof fields.image !== 'string') {
    throw new WaEngineError('INVALID_INPUT', `tileset ${rel} has no single image (image collections are not supported)`, { tileset: rel });
  }
  const imageAbs = await resolveMapRelative(projectDir, abs, fields.image);
  try {
    if (!(await stat(imageAbs)).isFile()) throw new Error('not a file');
  } catch {
    throw new WaEngineError('TILESET_IMAGE_MISSING', `tileset ${fields.name}: image ${fields.image} is not in the project`, { tileset: rel });
  }
  return { fields, imageAbs };
}

// A tileset as the rule map embeds it: the fields that identify it, its image relative to the
// rule map, and (for the special tiles) its tiles' properties.
function embedded(fields: TiledTilesetFields, firstgid: number, image: string, tiles?: TiledEmbeddedTileset['tiles']): TiledEmbeddedTileset {
  const kept = Object.fromEntries(IDENTITY_KEYS.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
  return { ...kept, firstgid, image, ...(tiles === undefined ? {} : { tiles }) } as TiledEmbeddedTileset;
}

// Whether an existing file is one this tool wrote (and the user may have painted or edited):
// overwrite replaces only those.
async function isTemplateFile(abs: string, name: string): Promise<boolean> {
  const text = await readFile(abs, 'utf8');
  if (name === FILES.rulesFile) return text.startsWith(RULES_HEADER);
  if (name === FILES.readme) return text.startsWith(README_HEADER);
  try {
    const map = JSON.parse(text) as { layers?: { name?: unknown }[]; tilesets?: { name?: unknown }[] };
    return (map.layers ?? []).some((l) => l.name === 'rule_options') && (map.tilesets ?? []).some((t) => t.name === RULE_TILES_TILESET);
  } catch {
    return false;
  }
}

// Writes beside the target and moves it into place: over the file it replaces, or only if the
// target is still absent.
async function writeFileAtomic(abs: string, text: string, replace: boolean): Promise<void> {
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, text, { flag: 'wx' });
  try {
    if (replace) await rename(tmp, abs);
    else {
      try {
        await link(tmp, abs);
      } catch (err) {
        if (!NO_HARD_LINKS.has(errnoOf(err) ?? '')) throw err;
        await writeFile(abs, text, { flag: 'wx' });
      }
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function automapTemplate(options: AutomapTemplateOptions): Promise<AutomapTemplateResult> {
  const projectDir = await assertProjectDir(options.projectDir);
  if (!Array.isArray(options.tilesets) || options.tilesets.length === 0 || options.tilesets.length > MAX_TEMPLATE_TILESETS) {
    throw new WaEngineError('INVALID_INPUT', `tilesets must list 1 to ${MAX_TEMPLATE_TILESETS} tileset files`);
  }
  const outAbs = await resolveInProject(options.projectDir, options.outDir);
  const outRel = slashes(relative(projectDir, outAbs));
  try {
    if (!(await stat(outAbs)).isDirectory()) throw new WaEngineError('INVALID_INPUT', `outDir is not a folder: ${options.outDir}`);
  } catch (err) {
    if (err instanceof WaEngineError) throw err;
    if (errnoOf(err) !== 'ENOENT') throw new WaEngineError('IO_ERROR', `cannot read outDir ${options.outDir} (${errnoOf(err) ?? 'error'})`);
  }
  const styles = await stylesFor(options.projectDir, options.assetSet);
  const art = [];
  for (const rel of options.tilesets) art.push(await readArtTileset(options.projectDir, rel));

  // The rule map's tilesets: the markers, the special tiles, then each tileset of the user's
  // once (a tileset with the marker image is the marker tileset).
  const ruleMapAbs = join(outAbs, FILES.ruleMap);
  const imageRel = (projectRel: string): string => mapRelativePath(ruleMapAbs, join(projectDir, projectRel));
  const markerFields = styles.ownMarkers?.fields ?? markerTsj();
  const markerImage = styles.ownMarkers?.image ?? MARKER_IMAGE;
  const tilesets: TiledEmbeddedTileset[] = [embedded(markerFields, 1, imageRel(markerImage))];
  const ruleTilesFirstgid = 1 + markerFields.tilecount;
  tilesets.push(
    embedded(
      { columns: RULE_TILES.length, imageheight: 32, imagewidth: 32 * RULE_TILES.length, margin: 0, name: RULE_TILES_TILESET, spacing: 0, tilecount: RULE_TILES.length, tileheight: 32, tilewidth: 32 },
      ruleTilesFirstgid,
      imageRel(RULE_TILES_IMAGE),
      RULE_TILES.map((m, id) => ({ id, properties: [{ name: 'MatchType', type: 'string', value: m }] })),
    ),
  );
  const byImage = new Map<string, TiledEmbeddedTileset>([
    [join(projectDir, markerImage), tilesets[0]!],
    [join(projectDir, RULE_TILES_IMAGE), tilesets[1]!],
  ]);
  const sameGrid = (a: TiledTilesetFields, b: TiledTilesetFields): boolean => (['columns', 'tilecount', 'margin', 'spacing'] as const).every((k) => (a[k] ?? 0) === (b[k] ?? 0));
  let next = ruleTilesFirstgid + RULE_TILES.length;
  for (const { fields, imageAbs } of art) {
    const twin = byImage.get(imageAbs);
    if (twin !== undefined) {
      if (sameGrid(twin, fields)) continue;
      throw new WaEngineError('INVALID_INPUT', `tileset "${fields.name}" has the image of "${twin.name}" with another grid; list one of them`, { tileset: fields.name });
    }
    if (tilesets.some((t) => t.name === fields.name)) {
      throw new WaEngineError('INVALID_INPUT', `two tilesets are named "${fields.name}"; tileset names must differ`, { tileset: fields.name });
    }
    const tileset = embedded(fields, next, mapRelativePath(ruleMapAbs, imageAbs));
    byImage.set(imageAbs, tileset);
    tilesets.push(tileset);
    next += fields.tilecount;
  }
  // A floor style keeps its tile (for world ground and paths) when its tileset is attached:
  // set.json may only name the set's tilesets.
  const attached = new Set(tilesets.map((t) => t.name));
  const floorStyles = {
    default: styles.floorStyles.default,
    styles: Object.fromEntries(Object.entries(styles.floorStyles.styles).map(([name, ref]) => [name, ref.tileset !== undefined && attached.has(ref.tileset) ? ref : {}])),
  };

  const { map, rules } = buildTemplate({
    markers: styles.markers,
    wallStyles: styles.wallStyles.names,
    floorStyles: Object.keys(styles.floorStyles.styles),
    markerFirstgid: 1,
    ruleTilesFirstgid,
    tilesets,
  });
  if (map.width > MAX_RULE_MAP_TILES || map.height > MAX_RULE_MAP_TILES) {
    throw new WaEngineError('INVALID_INPUT', `the rule map would be ${map.width}x${map.height} tiles, more than the ${MAX_RULE_MAP_TILES}x${MAX_RULE_MAP_TILES} rule maps may have; use fewer wall and floor styles`);
  }
  const result: AutomapTemplateResult = {
    ruleMap: posix.join(outRel, FILES.ruleMap),
    rulesFile: posix.join(outRel, FILES.rulesFile),
    readme: posix.join(outRel, FILES.readme),
    rules,
    markerTileset: styles.markerTileset,
    markers: styles.markers,
    wallStyles: styles.wallStyles,
    floorStyles,
  };
  const texts: [string, string][] = [
    [FILES.ruleMap, serializeMap(map)],
    [FILES.rulesFile, `${RULES_HEADER}# Paint walls.tmj in Tiled first: see README.md.\nwalls.tmj\n`],
    [FILES.readme, readmeText(result, outRel)],
  ];

  // The files go into outDir itself, never through a link to another file.
  const targets = texts.map(([name]) => join(outAbs, name));
  const existing: string[] = [];
  const foreign: string[] = [];
  try {
    for (const [i, abs] of targets.entries()) {
      const name = texts[i]![0];
      let info;
      try {
        info = await lstat(abs);
      } catch (err) {
        if (errnoOf(err) === 'ENOENT') continue;
        throw err;
      }
      existing.push(name);
      if (!info.isFile() || !(await isTemplateFile(abs, name))) foreign.push(name);
    }
  } catch (err) {
    throw new WaEngineError('IO_ERROR', `cannot read the files in ${options.outDir} (${errnoOf(err) ?? 'error'})`, { errno: errnoOf(err) });
  }
  const shown = (names: string[]): string[] => names.map((name) => posix.join(outRel, name));
  if (foreign.length > 0) {
    throw new WaEngineError('MAP_EXISTS', `${options.outDir} already has ${foreign.join(', ')}, not written by automap_template; overwrite never replaces them: choose another outDir`, {
      files: shown(foreign),
    });
  }
  if (existing.length > 0 && options.overwrite !== true) {
    throw new WaEngineError('MAP_EXISTS', `${options.outDir} already has ${existing.join(', ')}; pass overwrite: true to replace them (rules painted in them are lost)`, {
      files: shown(existing),
    });
  }
  if (styles.ownMarkers === undefined) await ensureMarkerImage(options.projectDir);
  await ensureRuleTilesImage(options.projectDir);
  try {
    await mkdir(outAbs, { recursive: true });
    for (const [i, abs] of targets.entries()) await writeFileAtomic(abs, texts[i]![1], existing.includes(texts[i]![0]));
  } catch (err) {
    if (errnoOf(err) === 'EEXIST') throw new WaEngineError('MAP_EXISTS', `a file of the template appeared in ${options.outDir} while it was written; run again`);
    throw new WaEngineError('IO_ERROR', `cannot write the template in ${options.outDir} (${errnoOf(err) ?? 'error'})`, { errno: errnoOf(err) });
  }
  return result;
}

// ---- README ----

function readmeText(result: AutomapTemplateResult, outRel: string): string {
  const markerNames = (id: number): string => (result.markerTileset === MARKER_TILESET ? `${id} (${MARKER_PALETTE[id]?.name ?? '?'})` : String(id));
  const markerLines = [
    `- \`wa_sketch\`: wall ${markerNames(result.markers.wall)}, door ${markerNames(result.markers.door)}`,
    ...Object.entries(result.markers.floor).map(([name, id]) => `- \`wa_sketch\`: floor style \`${name}\` ${markerNames(id)}`),
    ...Object.entries(result.markers.wallStyle).map(([name, id]) => `- \`wa_style\`: wall style \`${name}\` ${markerNames(id)}`),
  ];
  // The rules path as set.json gives it, when the rules live in a set's folder.
  const parts = outRel.split('/');
  const inSet = parts[0] === PROJECT_SETS_DIR && parts.length >= 2 ? parts.slice(2).concat('rules.txt').join('/') : undefined;
  const drawing = {
    mode: 'automap',
    rules: inSet ?? '<rules.txt relative to set.json>',
    markerTileset: result.markerTileset,
    markers: result.markers,
  };
  const setJson = JSON.stringify({ drawing, wallStyles: result.wallStyles, floorStyles: result.floorStyles }, null, 2);
  return `# Automapping rules to paint

\`walls.tmj\` is a Tiled rule map with one rule for every piece a room needs. Its input layers already hold the markers that a room build paints: on \`wa_sketch\` a marker for every wall, door and floor cell, on \`wa_style\` each room's wall-style marker over its inside. Its outputs are empty apart from the Empty tiles of the clean-up and lintel rules, which clear cells but never draw: the rules draw nothing until you paint your tiles into them. \`rules.txt\` lists it.

Markers (tile ids of \`${result.markerTileset}\`):

${markerLines.join('\n')}

## 1. Paint your tiles in Tiled

Open \`walls.tmj\` in Tiled 1.12 or newer (older versions run rules with fewer input layers than the map has differently). Each rule has a rectangle on the \`rule_options\` layer named after the piece it draws (see the Objects panel, or View > Show Object Names). Lock the input layers except \`input1_foreground1\`, select an output layer, and paint at each rule's anchor cell:

| Rules | Anchor cell | Paint |
|---|---|---|
| \`wall N1 E0 S1 W0\` and the other wall tops (a 1 is a wall on that side), walls beside and between doors | the wall marker in the middle | your wall tile on \`output_walls\`, your collision tile on \`output_collisions\` |
| \`horizontal lintel\`, \`vertical lintel\` | the door marker in the middle | the lintel on \`output_foreground1\` |
| \`face ..., row 1\` and \`row 2\`, in the variants middle, open west, open east and open on both sides, outside rooms and per wall style | the bottom cell of the middle column | the face tile on \`output_walls\`, your collision tile on \`output_collisions\` |
| \`floor <style>\` and \`floor <style> on a door, ...\` | the floor or door marker the rule draws on | the floor tile on \`output_floor\` |
| \`clear an old horizontal lintel ...\`, \`clear an old vertical lintel ...\` | the wall marker | that lintel tile again, over the Empty tile on the input layer \`input1_foreground1\`; leave the Empty tile if your set has no lintels |

The \`clear ...\` rules already have their Empty tiles: they remove old wall faces under a new door and the lintel of a door that a wall now closes. Until you paint the lintels, the two lintel rules only find empty cells and change nothing. A rule whose output stays empty draws nothing. A rule may draw more than its anchor cell (for example a wall top that also puts a tile on \`output_foreground1\`); keep the cells inside its rectangle.

The tool output (\`rules\`) lists every rule with its anchor cell and the layers to paint there.

## 2. Write set.json with \`drawing\`

Write \`.wa-asset-sets/<id>/set.json\` without \`wallTerrain\`, \`doorLintelTiles\` and \`faceRules\`. List every tileset you painted with (with its \`tilesetCopyright\`), and the \`collisionTile\`, \`startTile\` and \`mapCopyright\`. Add:

\`\`\`json
${setJson}
\`\`\`

\`rules\` is the path of \`${posix.join(outRel, 'rules.txt')}\` relative to \`set.json\`.

## 3. Prove the set

Follow section 4 of the wa-asset-set-onboarding skill: scaffold a test map with the set, run \`validate_wa_map\` (its \`ASSET_SET_INCOMPLETE\` warning names the wall tops, lintels, faces and floors your rules draw nothing for, with the names of the rectangles here), build the test room, then render the map and look at it. The check does not cover the floors of doors or the walls between two doors: look for those in the render.
`;
}
