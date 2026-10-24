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
    WorkingDirectory: '/plateau', EnvironmentVariables: { DRAIN_DAEMON_WE_CLONE: '/home/workspace/.lanes/we-drain-daemon/lane-1' },
  },
};
const readdir = () => [...Object.keys(fixtures).map(label => `${label}.plist`), 'unrelated.plist', 'notes.txt'];
const readPrototypeSettings = () => ({
  workspaceRoot: '~/workspace', daemons: { drain: { clone: '.lanes/we-drain-daemon/code' } },
});
const exec = (bin, argv) => {
  expect(bin).toBe('plutil');
  expect(argv.slice(0, 4)).toEqual(['-convert', 'json', '-o', '-']);
  const label = argv[4].split('/').at(-1).replace(/\.plist$/, '');
  return JSON.stringify(fixtures[label]);
};

describe('daemon clone resolver', () => {
  it('discovers WorkingDirectory and the configured drain code clone, deduping paths and retaining every daemon label', () => {
    const clones = resolveDaemonClones({ env: {}, home: '/home', readdir, exec, readPrototypeSettings });
    expect(clones).toEqual([
      { path: '/clones/we', name: 'we', labels: ['com.we.fix', 'com.we.review'] },
      { path: '/home/workspace/.lanes/we-drain-daemon/code', name: 'code', labels: ['com.plateau.drain-daemon'] },
      { path: '/other/we', name: 'we-2', labels: ['com.we.other'] },
    ]);
  });

  it('honors the LaunchAgents env dir, configured extra paths, home expansion and exclusions', () => {
    const seen = [];
    const clones = resolveDaemonClones({ env: { WE_LAUNCH_AGENTS_DIR: '/agents' }, home: '/home',
      readdir: dir => { seen.push(dir); return readdir(); }, exec, readPrototypeSettings,
      clones: ['~/extra', '/clones/we'], excludeClones: ['~/workspace/.lanes/we-drain-daemon/code', '/other/we/'],
    });
    expect(seen).toEqual(['/agents']);
    expect(clones.map(clone => clone.path)).toEqual(['/clones/we', '/home/extra']);
    expect(clones[0].labels).toEqual(['com.we.fix', 'com.we.review']);
  });

  it('retains an empty result for unreadable discovery evidence', () => {
    expect(resolveDaemonClones({ env: {}, readdir: () => { throw new Error('missing'); }, exec })).toEqual([]);
    expect(resolveDaemonClones({ env: {}, readdir, readPrototypeSettings, exec: () => { throw new Error('bad plist'); } })).toEqual([]);
    expect(resolveDaemonClones({ env: {}, readdir: () => ['com.we.review.plist'], exec: () => '{}' })).toEqual([]);
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

it('rejects relative extra clone paths without resolving against cwd, retaining absolute clones', () => {
  const incomplete = [];
  expect(resolveDaemonClones({ env: {}, readdir: () => [],
    clones: ['.', 'relative/clone', '/extra'], onIncomplete: reason => incomplete.push(reason),
  })).toEqual([{ path: '/extra', name: 'extra', labels: [] }]);
  expect(incomplete).toEqual(Array(2).fill('daemon plist clone field missing or invalid'));
});

it('accepts plist clone paths after absolute home expansion', () => {
  const incomplete = [];
  expect(resolveDaemonClones({ env: {}, home: '/home', readdir: () => ['com.we.review.plist'],
    exec: () => JSON.stringify({ WorkingDirectory: '~/clone' }), onIncomplete: reason => incomplete.push(reason),
  })).toEqual([{ path: '/home/clone', name: 'clone', labels: ['com.we.review'] }]);
  expect(incomplete).toEqual([]);
});

it('rejects home-expanded clone paths when home is relative', () => {
  const incomplete = [];
  expect(resolveDaemonClones({ env: {}, home: '.', readdir: () => ['com.we.review.plist'],
    exec: () => JSON.stringify({ WorkingDirectory: '~/clone' }), onIncomplete: reason => incomplete.push(reason),
  })).toEqual([]);
  expect(incomplete).toEqual(['daemon plist clone field missing or invalid']);
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
  ['com.we.review', { WorkingDirectory: '.' }],
  ['com.we.review', { WorkingDirectory: 'relative/clone' }],
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

it.each([fixtures['com.plateau.drain-daemon'], { WorkingDirectory: '/wrong-clone' },
  { EnvironmentVariables: { DRAIN_DAEMON_WE_CLONE: '' } }])('uses prototype-load code settings rather than drain plist paths (%j)', plist => {
  expect(resolveDaemonClones({ env: {}, home: '/home',
    readdir: () => ['com.plateau.drain-daemon.plist'], exec: () => JSON.stringify(plist),
    readPrototypeSettings: () => ({ workspaceRoot: '~/custom', daemons: { drain: { clone: 'code-target' } } }),
  })).toEqual([{ path: '/home/custom/code-target', name: 'code-target', labels: ['com.plateau.drain-daemon'] }]);
});

it.each([
  () => { throw new Error('unreadable'); },
  () => null,
  () => ({}),
  () => ({ workspaceRoot: '/workspace', daemons: { drain: { clone: ' ' } } }),
  () => ({ workspaceRoot: 42, daemons: { drain: { clone: 'code' } } }),
  () => ({ workspaceRoot: '.', daemons: { drain: { clone: 'code' } } }),
])('reports incomplete when the drain code target cannot be determined', readPrototypeSettings => {
  const incomplete = [];
  expect(resolveDaemonClones({ env: {}, readdir: () => ['com.plateau.drain-daemon.plist'], exec,
    readPrototypeSettings, onIncomplete: reason => incomplete.push(reason),
  })).toEqual([]);
  expect(incomplete).toEqual(['drain code clone settings unreadable or invalid']);
});
