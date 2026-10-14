import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { installFixtureDependencies, writeFixtureNpm } from './sim/npm-shim.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sim-npm-test-'));
  roots.push(root);
  const modules = join(root, 'installed');
  const target = join(root, 'snapshot');
  mkdirSync(modules);
  mkdirSync(target);
  writeFileSync(join(modules, 'fixture.txt'), 'installed module');
  const lockfile = join(root, 'package-lock.json');
  writeFileSync(lockfile, '{"lockfileVersion":3}\n');
  writeFileSync(join(target, 'package-lock.json'), readFileSync(lockfile));
  return { root: target, modules, lockfile };
}

it.each([['ci'], ['ci', '--ignore-scripts'], ['install']])('reuses installed modules for npm %s in a fresh snapshot', (...args) => {
  const f = fixture();
  installFixtureDependencies({ ...f, args });
  expect(realpathSync(join(f.root, 'node_modules'))).toBe(realpathSync(f.modules));
  expect(readFileSync(join(f.root, 'node_modules', 'fixture.txt'), 'utf8')).toBe('installed module');
  installFixtureDependencies({ ...f, args }); // a warm retry preserves the same fixture
});

it('refuses a changed lockfile instead of downloading a different dependency set', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'package-lock.json'), '{"different":true}\n');
  expect(() => installFixtureDependencies({ ...f, args: ['ci'] })).toThrow('lockfile differs');
});

it('refuses an unsupported npm command', () => {
  expect(() => installFixtureDependencies({ ...fixture(), args: ['exec', 'uninstalled-package'] })).toThrow('unsupported command');
});

it('excludes the module symlink in a newly provisioned lane without duplicating the rule on retry', () => {
  const f = fixture();
  const info = join(f.root, '.git', 'info');
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, 'exclude'), '# existing rules\n');
  installFixtureDependencies({ ...f, args: ['ci'] });
  installFixtureDependencies({ ...f, args: ['ci'] });
  expect(readFileSync(join(info, 'exclude'), 'utf8')).toBe('# existing rules\n\nnode_modules\n');
});

it('preserves an existing dependency directory', () => {
  const f = fixture();
  mkdirSync(join(f.root, 'node_modules'));
  writeFileSync(join(f.root, 'node_modules', 'owned.txt'), 'keep');
  expect(() => installFixtureDependencies({ ...f, args: ['ci'] })).toThrow('refusing to replace');
  expect(readFileSync(join(f.root, 'node_modules', 'owned.txt'), 'utf8')).toBe('keep');
});
it('runs the generated npm executable in a child process without an installed npm on PATH', () => {
  const f = fixture();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const npm = writeFixtureNpm(bin);
  execFileSync(npm, ['ci', '--ignore-scripts'], {
    cwd: f.root, timeout: 5000,
    env: { PATH: bin, SIM_NPM_MODULES: f.modules, SIM_NPM_LOCKFILE: f.lockfile },
  });
  expect(realpathSync(join(f.root, 'node_modules'))).toBe(realpathSync(f.modules));
  writeFileSync(join(f.root, 'package-lock.json'), '{}\n');
  expect(() => execFileSync(npm, ['ci'], {
    cwd: f.root, timeout: 5000, stdio: 'pipe',
    env: { PATH: bin, SIM_NPM_MODULES: f.modules, SIM_NPM_LOCKFILE: f.lockfile },
  })).toThrow('lockfile differs');
});
