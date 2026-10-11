import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { scaffoldMap } from '../../src/core/compiler.js';
import { resolveRole } from '../../src/core/layers.js';
import { readMap } from '../../src/core/map-io.js';
import { checkZoneProperties, configureZone, isAllowedUrl } from '../../src/core/zones.js';
import { getProperty, type TiledObjectGroup } from '../../src/schemas/tiled.schema.js';
import { makeFullProject, type TempProject } from '../helpers/project.js';

let project: TempProject;
beforeEach(async () => {
  project = await makeFullProject(['office.tmj']);
  await scaffoldMap({ projectDir: project.dir, mapPath: 'venue.tmj', width: 20, height: 15, assetSet: 'wa-starter-office', spawn: { x: 1, y: 1 } });
});
afterEach(() => project.cleanup());

const zone = (properties: Record<string, unknown>, extra: Partial<{ name: string; x: number; y: number; width: number; height: number; mapPath: string }> = {}) =>
  configureZone({ projectDir: project.dir, mapPath: extra.mapPath ?? 'venue.tmj', name: extra.name ?? 'talk', x: extra.x ?? 5, y: extra.y ?? 4, width: extra.width ?? 3, height: extra.height ?? 2, properties });

describe('configureZone', () => {
  test('tile units become pixels', async () => {
    const result = await zone({ jitsiRoom: 'Talk', jitsiTrigger: 'onaction' });
    expect(result.pixelRect).toEqual({ x: 160, y: 128, width: 96, height: 64 });
    const { map } = await readMap(join(project.dir, 'venue.tmj'));
    const area = (resolveRole(map, 'zones').layer as TiledObjectGroup).objects.find((o) => o.name === 'talk')!;
    expect(area).toMatchObject({ type: 'area', x: 160, y: 128, width: 96, height: 64 });
    expect(getProperty(area, 'jitsiTrigger')).toMatchObject({ type: 'string', value: 'onaction' });
  });

  test('configuring a zone again updates it and merges its properties', async () => {
    const first = await zone({ silent: true });
    const second = await zone({ focusable: true, zoom_margin: 0.5 }, { x: 1, y: 1, width: 4 });
    expect(second.objectId).toBe(first.objectId);
    const { map } = await readMap(join(project.dir, 'venue.tmj'));
    const area = (resolveRole(map, 'zones').layer as TiledObjectGroup).objects.find((o) => o.name === 'talk')!;
    expect(area.properties?.map((p) => p.name).sort()).toEqual(['focusable', 'silent', 'zoom_margin']);
    expect(getProperty(area, 'zoom_margin')).toMatchObject({ type: 'float', value: 0.5 });
    expect([area.x, area.width]).toEqual([32, 128]);
  });

  test("a user's area with the same name is never taken over", async () => {
    await expect(zone({ silent: true }, { mapPath: 'office.tmj', name: 'silentZone' })).rejects.toMatchObject({ code: 'ZONE_NAME_TAKEN' });
  });

  test('zone names are checked', async () => {
    await expect(zone({ silent: true }, { name: '' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(zone({ silent: true }, { name: 'bad\nname' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(zone({ silent: true }, { name: 'x'.repeat(129) })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('zones must lie inside the map', async () => {
    await expect(zone({ silent: true }, { x: 19, width: 3 })).rejects.toMatchObject({ code: 'ZONE_OUT_OF_BOUNDS' });
  });

  test.each([
    ['javascript URL', { openWebsite: 'javascript:alert(1)' }, 'BAD_URL'],
    ['data URL', { openWebsite: 'data:text/html,hi' }, 'BAD_URL'],
    ['protocol-relative URL', { exitUrl: '//evil.example/map.tmj' }, 'BAD_URL'],
    ['http audio', { playAudio: 'http://example.org/a.mp3' }, 'BAD_URL'],
    ['missing audio file', { playAudio: 'sounds/missing.mp3' }, 'BAD_URL'],
    ['deprecated key', { playAudioLoop: 'a.mp3' }, 'INVALID_ZONE_PROPERTY'],
    ['unknown key', { jitsiRom: 'typo' }, 'INVALID_ZONE_PROPERTY'],
    ['bad trigger', { openWebsiteTrigger: 'proximity' }, 'INVALID_ZONE_PROPERTY'],
    ['width over 100', { jitsiWidth: 120 }, 'INVALID_ZONE_PROPERTY'],
    ['jitsiConfig that is not JSON', { jitsiConfig: '{not json' }, 'INVALID_ZONE_PROPERTY'],
    ['long description', { description: 'x'.repeat(501) }, 'INVALID_ZONE_PROPERTY'],
    ['template smuggling a javascript URL', { openWebsite: 'javascript:alert(1)//{{{x}}}' }, 'INVALID_ZONE_PROPERTY'],
    ['template smuggling a protocol-relative URL', { exitUrl: '//evil.example/{{{x}}}' }, 'INVALID_ZONE_PROPERTY'],
    ['bare template', { openWebsite: '{{{ websiteURL }}}' }, 'INVALID_ZONE_PROPERTY'],
  ])('%s is refused', async (_name, properties, code) => {
    await expect(zone(properties)).rejects.toMatchObject({ code });
  });

  test('the deprecated playAudioLoop key gets a hint', async () => {
    await expect(zone({ playAudioLoop: 'a.mp3' })).rejects.toThrow('playAudioLoop is deprecated; use playAudio with audioLoop: true');
  });

  test('both spellings of the zoom margin are accepted, zoomMargin being the documented one', async () => {
    await expect(zone({ focusable: true, zoomMargin: 0.5 })).resolves.toMatchObject({ warnings: [] });
    await expect(zone({ focusable: true, zoom_margin: 0.5 })).resolves.toMatchObject({ warnings: [] });
  });

  test('valid URLs, audio files, entry points and AI zones are accepted', async () => {
    await mkdir(join(project.dir, 'sounds'));
    await writeFile(join(project.dir, 'sounds', 'chime.mp3'), 'x');
    const result = await zone({
      openWebsite: 'https://var.camp/schedule',
      openWebsiteTrigger: 'onicon',
      openWebsitePolicy: 'fullscreen; camera; teleport',
      playAudio: 'sounds/chime.mp3',
      audioLoop: true,
      audioVolume: 0.4,
      exitUrl: 'office.tmj#from-conference',
      start: true,
      'ai-zone': true,
      description: 'Main talk room',
    });
    expect(result.warnings.map((w) => w.code)).toEqual(['INVALID_ZONE_PROPERTY']);
    expect(result.warnings[0]?.message).toContain('teleport');
  });
});

describe('URL rules', () => {
  test.each([
    ['https://example.org/x', true],
    ['http://example.org/x', true],
    ['conference.tmj#entry', true],
    ['../maps/other.tmj', true],
    ['javascript:alert(1)', false],
    ['data:text/html,x', false],
    ['//evil.example/x', false],
    ['\\\\evil\\x', false],
    ['file:///etc/passwd', false],
    ['ftp://example.org/x', false],
  ])('%s -> %s', (value, ok) => {
    expect(isAllowedUrl(value)).toBe(ok);
  });

  test('templates are only skipped on dynamic areas, and never past a refused scheme', async () => {
    const ctx = { projectDir: project.dir, mapAbs: join(project.dir, 'venue.tmj'), zone: 'website' };
    const codes = async (props: Record<string, unknown>) => {
      const check = await checkZoneProperties(props, ctx, 'lenient');
      return { errors: check.errors.map((e) => e.code), warnings: check.warnings.map((w) => w.code) };
    };
    expect(await codes({ openWebsite: 'javascript:alert(1)//{{{x}}}' })).toMatchObject({ errors: ['BAD_URL'] });
    expect(await codes({ openWebsite: '//evil.example/{{{x}}}' })).toMatchObject({ errors: ['BAD_URL'] });
    expect(await codes({ openWebsite: 'https://var.camp/{{{page}}}' })).toEqual({ errors: [], warnings: ['INVALID_ZONE_PROPERTY'] });
    expect(await codes({ dynamic: true, openWebsite: 'javascript:{{{x}}}' })).toMatchObject({ errors: ['BAD_URL'] });
    expect(await codes({ dynamic: true, exitUrl: '//evil.example/{{{x}}}' })).toMatchObject({ errors: ['BAD_URL'] });
    expect(await codes({ dynamic: true, openWebsite: 'https://var.camp/{{{page}}}' })).toEqual({ errors: [], warnings: [] });
    expect(await codes({ dynamic: true, openWebsite: '{{#on}}https://var.camp{{/on}}' })).toEqual({ errors: [], warnings: [] });
    expect(await codes({ dynamic: true, openWebsite: 'java{{#a}}{{/a}}script:alert(1)' })).toMatchObject({ errors: ['BAD_URL'] });
    expect(await codes({ dynamic: true, openWebsite: ' //evil.example/{{x}}' })).toMatchObject({ errors: ['BAD_URL'] });
    // Text put in before the scheme is complete could make any scheme; a scheme written out first,
    // or a runtime base with a path, is fine.
    expect(await codes({ dynamic: true, openWebsite: '{{x}}:alert(1)' })).toMatchObject({ errors: ['BAD_URL'] });
    expect(await codes({ dynamic: true, openWebsite: '{{{x}}}https://var.camp' })).toMatchObject({ errors: ['BAD_URL'] });
    expect(await codes({ dynamic: true, exitUrl: '{{=<% %>=}}<%x%>:alert(1)' })).toMatchObject({ errors: ['BAD_URL'] });
    expect(await codes({ dynamic: true, openWebsite: '{{{ base }}}/page.html' })).toEqual({ errors: [], warnings: [] });
    expect(await codes({ dynamic: true, openWebsite: 'https://{{host}}/talks' })).toEqual({ errors: [], warnings: [] });
    expect(await codes({ dynamic: true, openWebsite: 'talks.html?track={{track}}' })).toEqual({ errors: [], warnings: [] });
    await expect(checkZoneProperties({ openWebsite: '{{#on}}https://var.camp{{/on}}' }, ctx, 'strict')).resolves.toMatchObject({
      errors: [{ code: 'INVALID_ZONE_PROPERTY' }],
    });
  });

  test('lenient checks ignore keys other tools add and runtime templates', async () => {
    const check = await checkZoneProperties(
      { dynamic: true, openWebsite: '{{{ websiteURL }}}' },
      { projectDir: project.dir, mapAbs: join(project.dir, 'venue.tmj'), zone: 'website' },
      'lenient',
    );
    expect(check.errors).toEqual([]);
  });
});
