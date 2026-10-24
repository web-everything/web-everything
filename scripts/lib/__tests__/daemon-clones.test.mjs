import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDaemonClones } from '../daemon-clones.mjs';
import { validateAdoptionMatrixSettings, loadAdoptionMatrixSettingsFile } from '../adoption-matrix-settings.mjs';

const fixtures = {
  'com.we.review': { WorkingDirectory: '/clones/we' },
  'com.we.fix': { WorkingDirectory: '/clones/we/' },
  'com.we.other': { WorkingDirectory: '/other/we' },
  'com.plateau.drain-daemon': {
    WorkingDirectory: '/plateau', EnvironmentVariables: { DRAIN_DAEMON_WE_CLONE: '/clones/drain' },
  },
};
const readdir = () => [...Object.keys(fixtures).map(label => `${label}.plist`), 'unrelated.plist', 'notes.txt'];
const exec = (bin, argv) => {
  expect(bin).toBe('plutil');
  expect(argv.slice(0, 4)).toEqual(['-convert', 'json', '-o', '-']);
  const label = argv[4].split('/').at(-1).replace(/\.plist$/, '');
  return JSON.stringify(fixtures[label]);
};

describe('daemon clone resolver', () => {
  it('discovers WorkingDirectory and the drain WE clone, deduping paths and retaining every daemon label', () => {
    const clones = resolveDaemonClones({ env: {}, home: '/home', readdir, exec });
    expect(clones).toEqual([
      { path: '/clones/drain', name: 'drain', labels: ['com.plateau.drain-daemon'] },
      { path: '/clones/we', name: 'we', labels: ['com.we.fix', 'com.we.review'] },
      { path: '/other/we', name: 'we-2', labels: ['com.we.other'] },
    ]);
  });

  it('honors the LaunchAgents env dir, configured extra paths, home expansion and exclusions', () => {
    const seen = [];
    const clones = resolveDaemonClones({ env: { WE_LAUNCH_AGENTS_DIR: '/agents' }, home: '/home',
      readdir: dir => { seen.push(dir); return readdir(); }, exec,
      clones: ['~/extra', '/clones/we'], excludeClones: ['/clones/drain', '/other/we/'],
    });
    expect(seen).toEqual(['/agents']);
    expect(clones.map(clone => clone.path)).toEqual(['/clones/we', '/home/extra']);
    expect(clones[0].labels).toEqual(['com.we.fix', 'com.we.review']);
  });

  it('tolerates missing directories, unreadable plists and absent clone fields', () => {
    expect(resolveDaemonClones({ env: {}, readdir: () => { throw new Error('missing'); }, exec })).toEqual([]);
    expect(resolveDaemonClones({ env: {}, readdir, exec: () => { throw new Error('bad plist'); } })).toEqual([]);
    expect(resolveDaemonClones({ env: {}, readdir, exec: () => '{}' })).toEqual([]);
  });
});

describe('adoption matrix settings', () => {
  it('loads the default settings path as a filesystem path', () => {
    const paths = [];
    const settings = loadAdoptionMatrixSettingsFile(undefined, { readText: path => {
      paths.push(path);
      return '{"fixReadyPath":"/fixes"}';
    } });
    expect(paths).toEqual([join(dirname(fileURLToPath(import.meta.url)), '..', 'adoption-matrix-settings.json')]);
    expect(settings.fixReadyPath).toBe('/fixes');
  });

  it('validates fields independently and retains defaults for invalid values', () => {
    expect(validateAdoptionMatrixSettings({ clones: ['/clone'], excludeClones: 'bad', fixReadyPath: 42 }))
      .toEqual({ clones: ['/clone'], excludeClones: [], fixReadyPath: null });
    for (const raw of [null, [], { clones: [1], excludeClones: [''], fixReadyPath: '' }]) {
      expect(validateAdoptionMatrixSettings(raw)).toEqual({ clones: [], excludeClones: [], fixReadyPath: null });
    }
  });

  it('loads injected file text and falls back on missing or malformed JSON', () => {
    expect(loadAdoptionMatrixSettingsFile('/settings', { readText: () => '{"fixReadyPath":"/fixes"}' }).fixReadyPath).toBe('/fixes');
    for (const readText of [() => '{', () => { throw new Error('missing'); }]) {
      expect(loadAdoptionMatrixSettingsFile('/settings', { readText }))
        .toEqual({ clones: [], excludeClones: [], fixReadyPath: null });
    }
  });
});
