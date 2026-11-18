import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareLockfiles, readLockfileParity } from '../check-lockfile-parity.mjs';

// Fixture integrity defaults to a value derived from name@version, so matching fixtures agree.
const sri = id => 'sha512-' + id;
const npm = (entries) => ({ packages: { '': { name: 'root', version: '1' },
  ...Object.fromEntries(entries.map(([name, version, integrity = sri(name + '@' + version)]) =>
    ['node_modules/' + name, { version, integrity }])) } });
const pnpm = (...keys) => ({ packages: Object.fromEntries(keys.map(key => Array.isArray(key)
  ? [key[0], key[1]] : [key, { integrity: sri(key.split('(')[0]) }])) });
/** A pnpm-lock.yaml package entry with registry integrity. */
const entry = id => `  ${id}:\n    resolution: {integrity: ${sri(id)}}\n`;

describe('lockfile parity', () => {
  it('checks parity and selects pnpm in a fresh lane with no node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-parity-fresh-'));
    try {
      mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
      for (const file of ['check-lockfile-parity.mjs', 'lib/lane-deps-installer.mjs']) {
        copyFileSync(resolve('scripts', file), join(dir, 'scripts', file));
      }
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(npm([['a', '1']])));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages:\n' + entry('a@1'));
      expect(existsSync(join(dir, 'node_modules'))).toBe(false);
      const options = { cwd: dir, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
        encoding: 'utf8', maxBuffer: 64 * 1024 };
      expect(execFileSync(process.execPath, ['scripts/check-lockfile-parity.mjs'], options))
        .toContain('Lockfile parity: npm and pnpm package sets agree');
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
        import { readLockfileParity } from './scripts/check-lockfile-parity.mjs';
        import { selectInstaller } from './scripts/lib/lane-deps-installer.mjs';
        const plan = selectInstaller({ which: () => 'pnpm', exec: () => '12.18.0',
          hasPnpmLock: true, hasNpmLock: true, storeDir: 'store',
          parity: () => readLockfileParity(process.cwd()).ok });
        console.log(plan.backend);
      `], options);
      expect(output.trim()).toBe('pnpm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('agrees and skips npm root and link entries', () => {
    const lock = npm([['a', '1.0.0']]);
    lock.packages['node_modules/local'] = { link: true, resolved: '../local' };
    expect(compareLockfiles(lock, pnpm('a@1.0.0')).ok).toBe(true);
  });
  it('lists extra packages in either lockfile', () => {
    const result = compareLockfiles(npm([['a', '1'], ['b', '2']]), pnpm('a@1', 'c@3'));
    expect(result).toMatchObject({ ok: false, onlyInNpm: ['b@2'], onlyInPnpm: ['c@3'] });
  });
  it('lists version disagreements', () => {
    expect(compareLockfiles(npm([['a', '1']]), pnpm('a@2'))).toMatchObject({
      ok: false, versionDisagreements: [{ name: 'a', npm: ['1'], pnpm: ['2'] }],
    });
  });
  it('accepts npm-only extra nested versions when pnpm retains the name', () => {
    const lock = npm([['acorn', '8.17.0']]);
    lock.packages['node_modules/acorn-walk/node_modules/acorn'] = { version: '8.15.0' };
    expect(compareLockfiles(lock, pnpm('acorn@8.17.0'))).toEqual({
      ok: true, onlyInNpm: [], onlyInPnpm: [], versionDisagreements: [],
      npmOnlyExtraVersions: ['acorn@8.15.0'], integrityMismatches: [], unverified: [],
    });
  });
  it('rejects a package name missing from pnpm even with multiple npm versions', () => {
    const lock = npm([['a', '1']]);
    lock.packages['node_modules/parent/node_modules/a'] = { version: '2' };
    expect(compareLockfiles(lock, pnpm())).toMatchObject({
      ok: false, onlyInNpm: ['a@1', 'a@2'], onlyInPnpm: [],
    });
  });
  it('reports npm-only extra versions as informational with a successful CLI exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-parity-'));
    try {
      const lock = npm([['a', '2']]);
      lock.packages['node_modules/parent/node_modules/a'] = { version: '1' };
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages:\n' + entry('a@2'));
      const output = execFileSync(process.execPath,
        [resolve('scripts/check-lockfile-parity.mjs')],
        { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 });
      expect(output).toContain('npm-only extra versions (informational):\n  a@1');
      expect(output).toContain('Lockfile parity: npm and pnpm package sets agree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects an extra pnpm package', () => {
    expect(compareLockfiles(npm([['a', '1']]), pnpm('a@1', 'b@2'))).toMatchObject({
      ok: false, onlyInPnpm: ['b@2'],
    });
  });
  it('rejects an unpinned pnpm version even when another version agrees', () => {
    expect(compareLockfiles(npm([['a', '1']]), pnpm('a@1', 'a@2'))).toMatchObject({
      ok: false, onlyInPnpm: ['a@2'],
      versionDisagreements: [{ name: 'a', npm: ['1'], pnpm: ['1', '2'] }],
    });
  });
  it('handles scoped names, nested npm entries and peer suffixes', () => {
    const lock = npm([['@scope/a', '1.0.0']]);
    lock.packages['node_modules/parent/node_modules/@scope/a'] = { version: '1.0.0' };
    expect(compareLockfiles(lock, pnpm('@scope/a@1.0.0(x@1)(@scope/y@2)')).ok).toBe(true);
  });
  it('splits a package key at its last non-leading @', () => {
    expect(compareLockfiles(npm([['name@alias', '1']]), pnpm('name@alias@1(peer@2)')).ok).toBe(true);
  });
  it('rejects a pnpm integrity that differs from npm for the same name@version', () => {
    expect(compareLockfiles(npm([['a', '1', 'sha512-npm']]), pnpm(['a@1', { integrity: 'sha512-other' }])))
      .toMatchObject({ ok: false, integrityMismatches: ['a@1'] });
  });
  it('accepts a pnpm integrity that is one of npm\'s space-separated hashes', () => {
    expect(compareLockfiles(npm([['a', '1', 'sha1-old sha512-new']]), pnpm(['a@1', { integrity: 'sha512-new' }])))
      .toMatchObject({ ok: true, integrityMismatches: [], unverified: [] });
  });
  it('rejects a pnpm entry with no registry integrity', () => {
    expect(compareLockfiles(npm([['a', '1']]), pnpm(['a@1', {}])))
      .toMatchObject({ ok: false, unverified: ['a@1'] });
  });
  it('rejects an npm entry with no integrity for a name@version pnpm installs', () => {
    expect(compareLockfiles(npm([['a', '1', '']]), pnpm('a@1')))
      .toMatchObject({ ok: false, integrityMismatches: ['a@1'] });
  });
  it.each([
    ['tarball', '{tarball: https://example.invalid/a-1.tgz}'],
    ['git', '{type: git, repo: https://example.invalid/a.git, commit: abc}'],
    ['directory', '{directory: ../a, type: directory}'],
    ['integrity plus tarball', '{integrity: ' + sri('a@1') + ', tarball: https://example.invalid/a-1.tgz}'],
    ['empty', '{}'],
  ])('reads a pnpm %s resolution as unverified', (_label, resolution) => {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-parity-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(npm([['a', '1']])));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), `packages:\n  a@1:\n    resolution: ${resolution}\n`);
      expect(readLockfileParity(dir)).toMatchObject({ ok: false, unverified: ['a@1'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reads a pnpm entry without a resolution line as unverified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-parity-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(npm([['a', '1']])));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'packages:\n  a@1: {}\n');
      expect(readLockfileParity(dir)).toMatchObject({ ok: false, unverified: ['a@1'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses incomplete evidence', () => {
    expect(() => compareLockfiles({}, pnpm())).toThrow();
    expect(() => compareLockfiles(npm([]), {})).toThrow();
    expect(() => compareLockfiles(npm([]), pnpm('unknown'))).toThrow();
  });
  const env = `importers:
  .:
    packageManagerDependencies:
      pnpm:
        specifier: '12.18.0'
        version: '12.18.0'
packages:
  pnpm@12.18.0: {}
snapshots:
  pnpm@12.18.0: {}
`;
  const project = `importers:
  .:
    devDependencies:
      a:
        specifier: '1'
        version: '1'
packages:
${entry('a@1')}snapshots:
  a@1: {}
`;
  it.each([
    ['single document', [project]],
    ['env followed by project', [env, project]],
    ['project followed by env', [project, env]],
    ['last document without importer metadata', [env, 'packages:\n' + entry('a@1')]],
    ['snapshots without importer metadata before env', ['packages:\n' + entry('a@1') + 'snapshots: {}\n', env]],
    ['project importer before unrelated packages', [project, 'packages:\n  unrelated@2: {}\n']],
  ])('reads and compares %s', (_label, documents) => {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-parity-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(npm([['a', '1']])));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), documents.join('\n---\n'));
      expect(readLockfileParity(dir)).toMatchObject({ ok: true, onlyInPnpm: [], onlyInNpm: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses an env document without a project lockfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-parity-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(npm([])));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), env);
      expect(() => readLockfileParity(dir)).toThrow('missing project lockfile');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reads quoted and plain scoped keys with peer suffixes and ignores nested packages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-parity-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(npm([
        ['@scope/a', '1'], ['@scope/b', '2'], ['plain', '3'],
      ])));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), `---
# Only the top-level packages map is evidence.
settings:
  packages:
    ignored@4: {}
packages:
  '@scope/a@1(peer@2)(@scope/peer@3)':
    resolution: {integrity: ${sri('@scope/a@1')}}
${entry('@scope/b@2')}${entry('plain@3')}snapshots:
  unrelated@4: {}
`);
      expect(readLockfileParity(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    ['missing packages', 'importers:\n  .:\n    dependencies: {}\n'],
    ['scalar packages', 'packages: unknown\n'],
    ['malformed entry', 'packages:\n  a@1\n'],
    ['invalid key', 'packages:\n  unknown: {}\n'],
    ['duplicate key', 'packages:\n  a@1: {}\n  a@1: {}\n'],
    ['empty stream', ''],
  ])('refuses %s evidence', (_label, source) => {
    const dir = mkdtempSync(join(tmpdir(), 'lockfile-parity-'));
    try {
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(npm([])));
      writeFileSync(join(dir, 'pnpm-lock.yaml'), source);
      expect(() => readLockfileParity(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('real repo files agree', () => {
    expect(readLockfileParity(process.cwd())).toMatchObject({ ok: true });
  });
});
