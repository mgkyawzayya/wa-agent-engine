import { readFile } from 'node:fs/promises';
import { dirname, relative, sep } from 'node:path';
import type { AutomapOptions, ExternalTilesetInfo, MatchKind, RuleTileset } from '../../schemas/automap.schema.js';
import { isExternalTileset, TiledTilesetFileSchema, type TiledEmbeddedTileset, type TiledMap } from '../../schemas/tiled.schema.js';
import { WaEngineError } from '../errors.js';
import { tileCountKnown } from '../gid.js';
import { resolveMapRelative } from '../project-paths.js';
import { FILE_ONLY_KEYS } from '../tileset-embed.js';
import { GID_MASK, matchTypesOf, tilesetIdentity } from './cells.js';

// Rule-map tiles are matched to working-map tiles by tileset plus local id, never by raw gid or
// tileset name, as Tiled's unifyTilesets does: an external rule-map tileset is the working
// map's tileset from the same file, and an embedded one is the first "similar" tileset (same
// image, tile size, tile count, margin, spacing and offset; embedded or external) of the working
// map, or else of the tilesets earlier rule maps bring. The rule-map tileset then is that
// tileset, tile properties (MatchType) included.

// Gids handed out for tilesets the working map does not have yet start here (or above the
// map's own tilesets) and are renumbered when the tilesets are added at the end of a run.
const PROVISIONAL_BASE = 0x08000000;
// Room left for an external tileset whose size is unknown.
const UNKNOWN_EXTERNAL_SIZE = 0x10000;

// A tileset rule-map tilesets can stand for: its identities (file and image) and its MatchTypes.
interface Candidate {
  firstgid: number;
  ids: string[];
  matchTypes: ReadonlyMap<number, MatchKind>;
}

interface Provisional extends Candidate {
  tilecount: number;
  source: RuleTileset;
  order: number;
}

const idsOf = (...ids: (string | undefined)[]): string[] => [...new Set(ids.filter((id): id is string => id !== undefined))];

// Reads the working map's external JSON tilesets for the core (which is synchronous). XML
// tilesets are left out: their tiles cannot be compared, and adding a tileset to such a map
// fails with EXTERNAL_TILESET_UNRESOLVED.
export async function resolveExternalTilesets(projectDir: string, map: TiledMap, mapAbs: string): Promise<Record<string, ExternalTilesetInfo>> {
  const out: Record<string, ExternalTilesetInfo> = {};
  for (const ts of map.tilesets) {
    if (!isExternalTileset(ts)) continue;
    try {
      const sourceAbs = await resolveMapRelative(projectDir, mapAbs, ts.source, { ext: ['.tsj', '.json'] });
      const file = TiledTilesetFileSchema.parse(JSON.parse(await readFile(sourceAbs, 'utf8')));
      const tilecount = tileCountKnown({ ...file, firstgid: 1 });
      if (tilecount !== undefined) {
        out[ts.source] = { sourceAbs, tilecount, similarity: tilesetIdentity(file, dirname(sourceAbs)), matchTypes: Object.fromEntries(matchTypesOf(file)) };
      }
    } catch {
      // Unreadable: its tiles never match, and no tileset can be added after it.
    }
  }
  return out;
}

export class TileTranslator {
  private readonly map: TiledMap;
  private readonly options: AutomapOptions;
  private readonly working: Candidate[];
  private readonly provisional: Provisional[] = [];
  private nextProvisional: number;

  constructor(map: TiledMap, options: AutomapOptions) {
    this.map = map;
    this.options = options;
    const mapDir = dirname(options.mapAbs);
    let end = 1;
    this.working = map.tilesets.map((ts) => {
      if (isExternalTileset(ts)) {
        const info = options.externalTilesets?.[ts.source];
        end = Math.max(end, ts.firstgid + (info?.tilecount ?? UNKNOWN_EXTERNAL_SIZE));
        const matchTypes = new Map(Object.entries(info?.matchTypes ?? {}).map(([id, m]): [number, MatchKind] => [Number(id), m]));
        const ids = info === undefined ? [`unresolved:${ts.source}`] : idsOf(`source:${info.sourceAbs}`, info.similarity);
        return { firstgid: ts.firstgid, ids, matchTypes };
      }
      end = Math.max(end, ts.firstgid + Math.max(tileCountKnown(ts) ?? 0, 1));
      return { firstgid: ts.firstgid, ids: idsOf(tilesetIdentity(ts, mapDir)), matchTypes: matchTypesOf(ts) };
    });
    this.nextProvisional = Math.max(PROVISIONAL_BASE, end);
  }

  // The tileset a rule-map tileset stands for: the working map's first, then those of earlier
  // rule maps, in order.
  private find(ts: RuleTileset): Candidate | undefined {
    const key = ts.identity;
    if (key === undefined) return undefined;
    return this.working.find((w) => w.ids.includes(key)) ?? this.provisional.find((p) => p.ids.includes(key));
  }

  // Registers a rule map's tilesets in run order, like Tiled's unifyTilesets in prepareAutoMap.
  register(tilesets: readonly RuleTileset[]): void {
    for (const ts of tilesets) {
      if (ts.identity === undefined || ts.unusable !== undefined || this.find(ts) !== undefined) continue;
      const entry: Provisional = {
        firstgid: this.nextProvisional,
        ids: idsOf(ts.identity, ts.similarity),
        matchTypes: ts.matchTypes,
        tilecount: Math.max(ts.tilecount, 1),
        source: ts,
        order: this.provisional.length,
      };
      this.nextProvisional += entry.tilecount;
      if (this.nextProvisional > GID_MASK) throw new WaEngineError('AUTOMAP_RULES_INVALID', 'rule-map tilesets have too many tiles for this map', { tileset: ts.name });
      this.provisional.push(entry);
    }
  }

  // The MatchType of a rule-map tileset's tiles: those of the tileset it stands for.
  matchTypes(ts: RuleTileset): ReadonlyMap<number, MatchKind> {
    return this.find(ts)?.matchTypes ?? ts.matchTypes;
  }

  // The working-map gid (without flags) of a rule-map tile.
  gid(ts: RuleTileset, localId: number): number {
    const found = this.find(ts);
    if (found === undefined) throw new WaEngineError('INTERNAL', `tileset "${ts.name}" was not registered`);
    return found.firstgid + localId;
  }

  isProvisional(gid: number): boolean {
    return this.provisional.some((p) => gid >= p.firstgid && gid < p.firstgid + p.tilecount);
  }

  // Plans adding the provisional tilesets the result uses. Throws before anything is changed
  // when one cannot be added; `apply` then adds them.
  planCommit(usedGids: ReadonlySet<number>): { remap: (gid: number) => number; apply: () => void } {
    const used = this.provisional
      .filter((p) => [...usedGids].some((g) => g >= p.firstgid && g < p.firstgid + p.tilecount))
      .sort((a, b) => a.order - b.order);
    if (used.length === 0) return { remap: (g) => g, apply: () => {} };

    let next = 1;
    for (const ts of this.map.tilesets) {
      const count = isExternalTileset(ts) ? this.options.externalTilesets?.[ts.source]?.tilecount : (tileCountKnown(ts) ?? 0);
      if (count === undefined) {
        const source = (ts as { source: string }).source;
        throw new WaEngineError('EXTERNAL_TILESET_UNRESOLVED', `cannot add rule tilesets: the map's external tileset "${source}" could not be read`, { source });
      }
      next = Math.max(next, ts.firstgid + Math.max(count, 1));
    }
    const mapDir = dirname(this.options.mapAbs);
    const rel = (abs: string): string => relative(mapDir, abs).split(sep).join('/');
    const names = new Set(this.map.tilesets.filter((ts) => !isExternalTileset(ts)).map((ts) => (ts as TiledEmbeddedTileset).name));
    const additions: TiledEmbeddedTileset[] = [];
    const moves: { from: number; to: number; count: number }[] = [];
    for (const p of used) {
      const embed = p.source.embed;
      if (embed === undefined) throw new WaEngineError('AUTOMAP_RULES_INVALID', `tileset "${p.source.name}" cannot be added to the map`, { tileset: p.source.name });
      if (names.has(embed.name)) throw new WaEngineError('TILESET_CONFLICT', `the map would get two different tilesets named "${embed.name}"`, { name: embed.name });
      names.add(embed.name);
      const copy = structuredClone(embed) as Record<string, unknown>;
      if (typeof copy.image === 'string') copy.image = rel(copy.image);
      for (const tile of (copy.tiles as { image?: string }[] | undefined) ?? []) if (tile.image !== undefined) tile.image = rel(tile.image);
      for (const key of FILE_ONLY_KEYS) delete copy[key];
      copy.firstgid = next;
      additions.push(Object.fromEntries(Object.entries(copy).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as TiledEmbeddedTileset);
      moves.push({ from: p.firstgid, to: next, count: p.tilecount });
      next += p.tilecount;
    }
    return {
      remap: (gid: number) => {
        const move = moves.find((m) => gid >= m.from && gid < m.from + m.count);
        return move === undefined ? gid : gid - move.from + move.to;
      },
      apply: () => {
        this.map.tilesets.push(...additions);
      },
    };
  }
}
