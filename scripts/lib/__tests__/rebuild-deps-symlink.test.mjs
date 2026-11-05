/** Round 1 contract tests: no subprocesses, installs, or host filesystem assumptions.
 * Shared helper contract used here: { root, storeDir, depsMode, step, exec, log,
 * stat = statSync, readFile = readFileSync }; destination is root/node_modules.
 * Store integrity evidence is produced by ensureNodeModulesStore, never forged here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as deps from '../daemon-rebuild/deps-job.mjs';
import { cloneNodeModulesInstaller } from '../daemon-rebuild/rebuild-job.mjs';
import { ensureNodeModulesStore } from '../daemon-job-snapshots.mjs';

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'we-rebuild-deps-'));
  temporary.push(base);
  const sourceDir = join(base, 'source');
  const root = join(base, 'job');
  for (const dir of [sourceDir, root]) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  }
  const install = vi.fn((into) => {
    mkdirSync(join(into, 'node_modules'));
    writeFileSync(join(into, 'node_modules', '.package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    writeFileSync(join(into, 'node_modules', 'payload.txt'), 'store payload');
  });
  const store = ensureNodeModulesStore({ jobsDir: join(base, 'jobs'), sourceDir, install });
  const log = vi.fn();
  // Emulate both cp variants portably, including their filesystem effect. Never spawn cp.
  const exec = vi.fn((command, args) => {
    expect(command).toBe('cp');
    expect(['-cR', '-R']).toContain(args[0]);
    cpSync(args[1], args[2], { recursive: true, dereference: true });
  });
  return { root, storeDir: store.dir, sourceDir, exec, log, install, base };
}

const messages = (log) => log.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
const target = (f) => join(f.root, 'node_modules');
function expectLinked(f) {
  expect(lstatSync(target(f)).isSymbolicLink()).toBe(true);
  expect(realpathSync(target(f))).toBe(realpathSync(join(f.storeDir, 'node_modules')));
  expect(readFileSync(join(target(f), 'payload.txt'), 'utf8')).toBe('store payload');
  expect(f.exec.mock.calls.filter(([command]) => command === 'cp')).toEqual([]);
}
function expectCopied(f, reason) {
  expect(lstatSync(target(f)).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(target(f), 'payload.txt'), 'utf8')).toBe('store payload');
  expect(f.exec).toHaveBeenCalledWith('cp', expect.any(Array), expect.any(Object));
  if (reason) {
    expect(messages(f.log)).toMatch(/copy/i);
    expect(messages(f.log)).toMatch(reason);
  }
}

describe('rebuild dependency mode and provenance', () => {
  it('defaults to symlink with built-in provenance and logs the effective value and source', () => {
    const log = vi.fn();
    expect(deps.resolveRebuildDepsMode({ env: {}, settings: {}, log })).toEqual({ mode: 'symlink', source: 'built-in' });
    expect(messages(log)).toMatch(/symlink/);
    expect(messages(log)).toMatch(/built-in/);
  });

  it.each(['symlink', 'copy'])('resolves file mode %s and logs file provenance', (mode) => {
    const log = vi.fn();
    expect(deps.resolveRebuildDepsMode({ env: {}, settings: { rebuild: { depsMode: mode } }, log }))
      .toEqual({ mode, source: 'file' });
    expect(messages(log)).toContain(mode);
    expect(messages(log)).toMatch(/file/);
  });

  it.each(['symlink', 'copy'])('environment mode %s overrides the file and logs env provenance', (mode) => {
    const log = vi.fn();
    expect(deps.resolveRebuildDepsMode({
      env: { WE_DAEMON_REBUILD_DEPS_MODE: mode },
      settings: { rebuild: { depsMode: mode === 'copy' ? 'symlink' : 'copy' } }, log,
    })).toEqual({ mode, source: 'env' });
    expect(messages(log)).toContain(mode);
    expect(messages(log)).toMatch(/env/);
  });

  it.each(['unknown', '', 'SYMLINK'])('invalid environment value %j fails closed to copy instead of using the file', (value) => {
    const log = vi.fn();
    expect(deps.resolveRebuildDepsMode({
      env: { WE_DAEMON_REBUILD_DEPS_MODE: value }, settings: { rebuild: { depsMode: 'symlink' } }, log,
    })).toEqual({ mode: 'copy', source: 'invalid' });
    expect(messages(log)).toMatch(/invalid/i);
    expect(messages(log)).toMatch(/copy/);
  });

  it('invalid file value fails closed to copy and logs invalid provenance', () => {
    const log = vi.fn();
    expect(deps.resolveRebuildDepsMode({ env: {}, settings: { rebuild: { depsMode: 'automatic' } }, log }))
      .toEqual({ mode: 'copy', source: 'invalid' });
    expect(messages(log)).toMatch(/invalid/i);
    expect(messages(log)).toMatch(/copy/);
  });
});

describe('shared link-or-copy safety decision', () => {
  it('links a completed same-volume store by default without any cp exec call', () => {
    const f = fixture();
    deps.linkOrCopyNodeModules(f);
    expectLinked(f);
  });

  it('explicit copy mode retains a private copy', () => {
    const f = fixture();
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'copy' });
    expectCopied(f);
    writeFileSync(join(target(f), 'payload.txt'), 'private change');
    expect(readFileSync(join(f.storeDir, 'node_modules', 'payload.txt'), 'utf8')).toBe('store payload');
  });

  it('cross-volume devices fall back to copy and log the volume reason', () => {
    const f = fixture();
    const stat = vi.fn((path) => {
      const actual = statSync(path);
      return new Proxy(actual, { get: (object, key) => key === 'dev'
        ? (String(path).startsWith(f.storeDir) ? 11 : 22) : Reflect.get(object, key) });
    });
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'symlink', stat });
    expect(stat).toHaveBeenCalled();
    expectCopied(f, /volume|device|\bdev\b/i);
  });

  it('unreadable device evidence fails closed to copy and logs the reason', () => {
    const f = fixture();
    const stat = vi.fn(() => { throw Object.assign(new Error('device evidence denied'), { code: 'EACCES' }); });
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'symlink', stat });
    expect(stat).toHaveBeenCalled();
    expectCopied(f, /stat|device|volume|unreadable|denied/i);
  });

  it('changed store content hash falls back to copy and logs an integrity mismatch', () => {
    const f = fixture();
    writeFileSync(join(f.storeDir, 'node_modules', '.package-lock.json'), '{"tampered":true}');
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'symlink' });
    expectCopied(f, /hash|integrity|mismatch|mutat/i);
  });

  it('missing store integrity evidence fails closed to copy with a reason', () => {
    const f = fixture();
    rmSync(join(f.storeDir, 'node_modules', '.package-lock.json'));
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'symlink' });
    expectCopied(f, /hash|integrity|evidence|missing|ENOENT/i);
  });

  it('unreadable store hash evidence fails closed to copy with a reason', () => {
    const f = fixture();
    const readFile = vi.fn(() => { throw Object.assign(new Error('integrity evidence denied'), { code: 'EACCES' }); });
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'symlink', readFile });
    expect(readFile).toHaveBeenCalled();
    expectCopied(f, /hash|integrity|evidence|unreadable|denied/i);
  });

  it('a legacy completed store without recorded integrity evidence stays on the copy path', () => {
    const f = fixture();
    const legacy = join(f.base, 'legacy');
    mkdirSync(legacy);
    cpSync(join(f.storeDir, 'node_modules'), join(legacy, 'node_modules'), { recursive: true });
    writeFileSync(join(legacy, '.snapshot-complete'), 'legacy completion marker\n');
    deps.linkOrCopyNodeModules({ ...f, storeDir: legacy, depsMode: 'symlink' });
    expectCopied(f, /hash|integrity|evidence|missing|legacy/i);
  });

  it('steps that write node_modules keep copies; an empty list requires the no-writer audit comment', () => {
    expect(Array.isArray(deps.WRITES_NODE_MODULES_STEPS)).toBe(true);
    expect(new Set(deps.WRITES_NODE_MODULES_STEPS).size).toBe(deps.WRITES_NODE_MODULES_STEPS.length);
    if (deps.WRITES_NODE_MODULES_STEPS.length === 0) {
      const implementation = readFileSync(join(process.cwd(), 'scripts/lib/daemon-rebuild/deps-job.mjs'), 'utf8');
      // The allowed no-writer outcome still needs an explicit, reviewable audit trail.
      expect(implementation).toMatch(/\/\*[\s\S]*?(?:no|none|not)[\s\S]*?writ[\s\S]*?\*\/|\/\/.*(?:no|none|not).*writ/i);
      expect(implementation).toMatch(/ready-only/);
      expect(implementation).toMatch(/smoke/);
      expect(implementation).toMatch(/\.vite|\.cache|npm rebuild/);
    }
    for (const step of deps.WRITES_NODE_MODULES_STEPS) {
      expect(typeof step).toBe('string');
      expect(step.trim()).not.toBe('');
      const f = fixture();
      deps.linkOrCopyNodeModules({ ...f, depsMode: 'symlink', step });
      expectCopied(f, /step|writ/i);
    }
  });
});

describe('both rebuild copy sites use the guarded decision', () => {
  it('swapNodeModules defaults to a store symlink and never executes cp', () => {
    const f = fixture();
    mkdirSync(target(f));
    writeFileSync(join(target(f), 'old.txt'), 'old');
    deps.swapNodeModules(f);
    expectLinked(f);
    expect(readdirSync(f.root).filter((name) => name.startsWith('.node_modules.'))).toEqual([]);
  });

  it('swapNodeModules copy mode preserves the copy path', () => {
    const f = fixture();
    deps.swapNodeModules({ ...f, depsMode: 'copy' });
    expectCopied(f);
  });

  it('cloneNodeModulesInstaller links matching dependencies without a cp exec call', () => {
    const f = fixture();
    const fallback = vi.fn();
    cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log, fallback })(f.root);
    expectLinked(f);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('cloneNodeModulesInstaller copy mode keeps a private copy', () => {
    const f = fixture();
    cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, depsMode: 'copy', log: f.log })(f.root);
    expectCopied(f);
  });

  it('cloneNodeModulesInstaller refuses a mutated store and logs its copy fallback', () => {
    const f = fixture();
    writeFileSync(join(f.storeDir, 'node_modules', '.package-lock.json'), '{"tampered":true}');
    cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, depsMode: 'symlink', log: f.log })(f.root);
    expectCopied(f, /hash|integrity|mismatch|mutat/i);
  });

  it('installer lockfile mismatch still uses the injected install fallback', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'package-lock.json'), '{"different":true}');
    const fallback = vi.fn();
    cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, depsMode: 'symlink', log: f.log, fallback })(f.root);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(f.root);
    expect(f.exec).not.toHaveBeenCalled();
  });

  it('symlink swap promotion failure restores the live tree and reports liveIntact', () => {
    const f = fixture();
    mkdirSync(target(f));
    writeFileSync(join(target(f), 'old.txt'), 'old');
    const rename = vi.fn((from, to) => {
      if (to === target(f) && from.includes('.node_modules.swap.')) {
        expect(lstatSync(from).isSymbolicLink()).toBe(true);
        throw Object.assign(new Error('promotion denied'), { code: 'EPERM' });
      }
      renameSync(from, to);
    });
    let failure;
    try { deps.swapNodeModules({ ...f, depsMode: 'symlink', rename }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: 'promotion denied', liveIntact: true });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(target(f), 'old.txt'), 'utf8')).toBe('old');
    expect(readdirSync(f.root).filter((name) => name.startsWith('.node_modules.'))).toEqual([]);
    expect(readFileSync(join(f.storeDir, 'node_modules', 'payload.txt'), 'utf8')).toBe('store payload');
    expect(f.exec).not.toHaveBeenCalled();
  });

  it('symlink swap reports liveIntact false when restoring the old tree also fails', () => {
    const f = fixture();
    mkdirSync(target(f));
    writeFileSync(join(target(f), 'old.txt'), 'old');
    const rename = vi.fn((from, to) => {
      if (to === target(f)) throw new Error('rename denied');
      renameSync(from, to);
    });
    let failure;
    try { deps.swapNodeModules({ ...f, depsMode: 'symlink', rename }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: 'rename denied', liveIntact: false });
    expect(rename).toHaveBeenCalledTimes(3);
    expect(f.exec).not.toHaveBeenCalled();
    expect(readFileSync(join(f.root, `.node_modules.old.${process.pid}`, 'old.txt'), 'utf8')).toBe('old');
  });
});
