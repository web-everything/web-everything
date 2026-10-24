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

  it('retains an empty result for unreadable discovery evidence', () => {
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

  it('rejects malformed settings instead of substituting defaults', () => {
    expect(validateAdoptionMatrixSettings({ clones: ['/clone'] }))
      .toEqual({ clones: ['/clone'], excludeClones: [], fixReadyPath: null });
    for (const raw of [null, [], { clones: [1] }, { excludeClones: 'bad' }, { excludeClones: [''] }, { fixReadyPath: 42 }, { fixReadyPath: '' }]) {
      expect(() => validateAdoptionMatrixSettings(raw)).toThrow(/settings/i);
    }
  });

  it('loads injected file text and throws on unreadable or malformed JSON', () => {
    expect(loadAdoptionMatrixSettingsFile('/settings', { readText: () => '{"fixReadyPath":"/fixes"}' }).fixReadyPath).toBe('/fixes');
    for (const readText of [() => '{', () => { throw new Error('missing'); }]) {
      expect(() => loadAdoptionMatrixSettingsFile('/settings', { readText })).toThrow();
    }
  });
});

it('reports unreadable clone discovery evidence without discarding readable clones', () => {
  const incomplete = [];
  const clones = resolveDaemonClones({ env: {}, readdir: () => ['com.we.bad.plist'],
    exec: () => { throw new Error('denied'); }, clones: ['/extra'], onIncomplete: reason => incomplete.push(reason) });
  expect(clones).toEqual([{ path: '/extra', name: 'extra', labels: [] }]);
  expect(incomplete).toEqual(['daemon plist unreadable']);
});

it('bounds plist conversion calls and clone count and reports both truncations', () => {
  const incomplete = new Set();
  let calls = 0;
  const clones = resolveDaemonClones({ env: {},
    readdir: () => Array.from({ length: 1000 }, (_, i) => `com.we.${i}.plist`),
    exec: () => JSON.stringify({ WorkingDirectory: `/clone/${calls++}` }),
    onIncomplete: reason => incomplete.add(reason),
  });
  expect(calls).toBe(100);
  expect(clones).toHaveLength(20);
  expect([...incomplete].sort()).toEqual(['clone discovery truncated', 'daemon plist discovery truncated']);
});

it.each(['ENOENT', 'EACCES'])('reports discovery directory failures except missing directories (%s)', code => {
  const incomplete = [];
  expect(resolveDaemonClones({ env: {}, readdir: () => { throw Object.assign(new Error('failed'), { code }); },
    onIncomplete: reason => incomplete.push(reason),
  })).toEqual([]);
  expect(incomplete).toEqual(code === 'ENOENT' ? [] : ['daemon discovery directory unreadable']);
});

it.each([
  ['com.we.review', {}],
  ['com.we.review', { WorkingDirectory: ' ' }],
  ['com.we.review', { WorkingDirectory: 42 }],
  ['com.plateau.drain-daemon', { WorkingDirectory: '/wrong-clone' }],
  ['com.plateau.drain-daemon', { EnvironmentVariables: { DRAIN_DAEMON_WE_CLONE: '' } }],
])('reports a readable %s plist missing a valid expected clone field (%j)', (label, plist) => {
  const incomplete = [];
  expect(resolveDaemonClones({ env: {}, readdir: () => [`${label}.plist`],
    exec: () => JSON.stringify(plist),
    onIncomplete: reason => incomplete.push(reason),
  })).toEqual([]);
  expect(incomplete).toEqual(['daemon plist clone field missing or invalid']);
});

it.each([{ env: { WE_LAUNCH_AGENTS_DIR: '/configured' } }, { env: {}, launchAgentsDir: '/configured' }])(
  'reports ENOENT for an explicitly configured discovery directory (%j)', options => {
    const incomplete = [];
    expect(resolveDaemonClones({ ...options,
      readdir: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      onIncomplete: reason => incomplete.push(reason),
    })).toEqual([]);
    expect(incomplete).toEqual(['daemon discovery directory unreadable']);
  });
