import { removeReadonlyTree } from '../readonly-tree.mjs';
/** Round 1 contract tests: no subprocesses, installs, or host filesystem assumptions.
 * Shared helper contract used here: { root, storeDir, depsMode, step, exec, log,
 * stat = statSync, readFile = readFileSync }; destination is root/node_modules.
 * Store integrity evidence is produced by ensureNodeModulesStore, never forged here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import * as deps from '../daemon-rebuild/deps-job.mjs';
import { cloneNodeModulesInstaller, REBUILD_JOB_KIND } from '../daemon-rebuild/rebuild-job.mjs';
import { ensureNodeModulesStore, evictSnapshots, quarantineNodeModulesStore, lockfileKey, NODE_MODULES_HASH_FILE, NODE_MODULES_MANIFEST_FILE, NODE_MODULES_UNSAFE_FILE, nodeModulesRef, nodeModulesTreeEvidence, setNodeModulesWritable } from '../daemon-job-snapshots.mjs';
import { createJobStore, enqueueJob, launchJob, prepareJobCode } from '../daemon-jobs-runtime.mjs';
import { markClaimed, markLaunching } from '../daemon-jobs.mjs';
import { withFileLock } from '../atomic-json-file.mjs';
import { LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH, operatorPreferencesPath } from '../policy-cascade.mjs';

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    removeReadonlyTree(dir);
  }
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
    mkdirSync(join(into, 'node_modules', 'pkg'));
    writeFileSync(join(into, 'node_modules', 'pkg', 'package.json'), '{"name":"pkg","version":"1.0.0"}');
    writeFileSync(join(into, 'node_modules', 'pkg', 'index.js'), 'export default 1;');
    mkdirSync(join(into, 'node_modules', '@scope', 'other'), { recursive: true });
    writeFileSync(join(into, 'node_modules', '@scope', 'other', 'package.json'), '{"name":"@scope/other","version":"2.0.0"}');
    mkdirSync(join(into, 'node_modules', 'pkg', 'node_modules', 'inner', 'lib'), { recursive: true });
    writeFileSync(join(into, 'node_modules', 'pkg', 'node_modules', 'inner', 'package.json'), '{"name":"inner","version":"1.0.0"}');
    writeFileSync(join(into, 'node_modules', 'pkg', 'node_modules', 'inner', 'lib', 'nested.js'), 'export default 2;');
    mkdirSync(join(into, 'node_modules', '.bin'));
    symlinkSync('../pkg/index.js', join(into, 'node_modules', '.bin', 'pkg'));
  });
  const store = ensureNodeModulesStore({ jobsDir: join(base, 'jobs'), sourceDir, install });
  const log = vi.fn();
  // Emulate both cp variants portably, including their filesystem effect. Never spawn cp.
  const exec = vi.fn((command, args) => {
    expect(command).toBe('cp');
    expect(['-cR', '-R']).toContain(args[0]);
    cpSync(args[1], args[2], { recursive: true, dereference: false, verbatimSymlinks: true });
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

function expectQuarantined(f, reason, run = () => deps.linkOrCopyNodeModules(f)) {
  let failure;
  try { run(); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'ENODEMODULESMUTATED' });
  expect(failure.message).toMatch(reason);
  expect(basename(failure.quarantined)).toMatch(/^\.quarantined-/);
  expect(existsSync(f.storeDir)).toBe(false);
  expect(existsSync(failure.quarantined)).toBe(true);
  expect(existsSync(target(f))).toBe(false);
  expect(f.exec).not.toHaveBeenCalled();
  expect(statSync(join(failure.quarantined, 'node_modules')).mode & 0o200).toBe(0o200);
  expect(messages(f.log)).toMatch(/copy refused.*quarantining mutated store/i);
  return failure.quarantined;
}

describe('cached rebuild aliases', () => {
  it.each(['unchanged', 'mutated', 'quarantined', 'lockfile mismatch', 'missing evidence', 'unsafe', 'dangling'])('revalidates a cached alias when its target is %s', (state) => {
    const f = fixture();
    mkdirSync(join(f.base, 'rebuild-cache'));
    const store = createJobStore(join(f.base, 'rebuild-cache'));
    const record = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'cache-first', input: { root: f.root } });
    const fallback = vi.fn(f.install);
    const snapshot = {
      materialize: (into) => {
        for (const name of ['package.json', 'package-lock.json']) {
          writeFileSync(join(into, name), readFileSync(join(f.sourceDir, name)));
        }
      },
      install: cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log, fallback }),
    };
    const first = prepareJobCode({ store, record, kindDef: REBUILD_JOB_KIND, snapshot });
    const alias = dirname(readlinkSync(join(first.cwd, 'node_modules')));
    expect(lstatSync(join(alias, 'node_modules')).isSymbolicLink()).toBe(true);
    if (state === 'mutated') {
      chmodSync(join(f.storeDir, 'node_modules', 'payload.txt'), 0o644);
      writeFileSync(join(f.storeDir, 'node_modules', 'payload.txt'), 'rejected contents');
    }
    if (state === 'quarantined') quarantineNodeModulesStore(f.storeDir, 'rejected');
    if (state === 'lockfile mismatch') writeFileSync(join(f.storeDir, 'package-lock.json'), '{"different":true}');
    if (state === 'missing evidence') rmSync(join(f.storeDir, NODE_MODULES_MANIFEST_FILE));
    if (state === 'unsafe') writeFileSync(join(f.storeDir, NODE_MODULES_UNSAFE_FILE), '{}');
    if (state === 'dangling') renameSync(join(f.storeDir, 'node_modules'), join(f.storeDir, 'removed'));
    const nextRecord = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'cache-second', input: { root: f.root } });
    const next = prepareJobCode({ store, record: nextRecord, kindDef: REBUILD_JOB_KIND, snapshot });
    expect(next.snapshotKeys[1]).toBe(first.snapshotKeys[1]);
    expect(lstatSync(join(alias, 'node_modules')).isSymbolicLink()).toBe(state === 'unchanged');
    expect(fallback).toHaveBeenCalledTimes(state === 'unchanged' ? 0 : 1);
    expect(readFileSync(join(next.cwd, 'node_modules', 'payload.txt'), 'utf8')).toBe('store payload');
    expect(f.exec).not.toHaveBeenCalled();
  });
});

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

  it('changed store content hash quarantines the rejected store and refuses installation', () => {
    const f = fixture();
    // Deliberately bypass the new file protection to exercise the existing hash guard independently.
    chmodSync(join(f.storeDir, 'node_modules', '.package-lock.json'), 0o644);
    writeFileSync(join(f.storeDir, 'node_modules', '.package-lock.json'), '{"tampered":true}');
    expectQuarantined(f, /hash.*mismatch/i);
  });

  it('removal of a guarded hidden lock is mutation and quarantines the store', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules'), 0o755);
    rmSync(join(f.storeDir, 'node_modules', '.package-lock.json'));
    chmodSync(join(f.storeDir, 'node_modules'), 0o555);
    expectQuarantined(f, /hash.*missing/i);
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
    cpSync(join(f.storeDir, 'node_modules'), join(legacy, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true });
    writeFileSync(join(legacy, '.snapshot-complete'), 'legacy completion marker\n');
    deps.linkOrCopyNodeModules({ ...f, storeDir: legacy, depsMode: 'symlink' });
    expectCopied(f, /hash|integrity|evidence|missing|legacy/i);
    expect(existsSync(legacy)).toBe(true);
    expect(readdirSync(f.base).some((name) => name.startsWith('.quarantined-'))).toBe(false);
  });

  it('an ancestor alias of a plain legacy copy does not require store lockfiles', () => {
    const f = fixture();
    const legacy = join(f.base, 'legacy');
    mkdirSync(legacy);
    cpSync(join(f.storeDir, 'node_modules'), join(legacy, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true });
    const alias = join(f.base, 'ancestor-alias');
    symlinkSync(f.base, alias, 'dir');
    deps.linkOrCopyNodeModules({ ...f, storeDir: join(alias, 'legacy') });
    expectCopied(f, /legacy/i);
    expect(existsSync(join(legacy, 'package-lock.json'))).toBe(false);
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

  it('cloneNodeModulesInstaller quarantines a mutated store without copying rejected contents', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', '.package-lock.json'), 0o644);
    writeFileSync(join(f.storeDir, 'node_modules', '.package-lock.json'), '{"tampered":true}');
    expectQuarantined(f, /hash.*mismatch/i, () => cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, depsMode: 'symlink', log: f.log })(f.root));
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

  it('a live link to valid store A cannot satisfy requested lockfile B', () => {
    const f = fixture();
    symlinkSync(join(f.storeDir, 'node_modules'), join(f.sourceDir, 'node_modules'), 'dir');
    const lockB = '{"lockfileVersion":3,"name":"B","packages":{}}';
    for (const dir of [f.sourceDir, f.root]) writeFileSync(join(dir, 'package-lock.json'), lockB);
    const fallback = vi.fn((into) => {
      mkdirSync(join(into, 'node_modules'));
      writeFileSync(join(into, 'node_modules', 'payload.txt'), 'B dependencies');
    });
    cloneNodeModulesInstaller(f.sourceDir, { exec: f.exec, log: f.log, fallback })(f.root);
    expect(fallback).toHaveBeenCalledWith(f.root);
    expect(lstatSync(target(f)).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target(f), 'payload.txt'), 'utf8')).toBe('B dependencies');
    expect(f.exec).not.toHaveBeenCalled();
  });

  it('symlink creation failure falls back to a private copy protected against eviction', () => {
    const f = fixture();
    const symlink = vi.fn(() => { throw Object.assign(new Error('links denied'), { code: 'EPERM' }); });
    const exec = vi.fn((...args) => {
      expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted).toEqual([]);
      f.exec(...args);
    });
    cloneNodeModulesInstaller(f.storeDir, { exec, log: f.log, symlink })(f.root);
    expect(symlink).toHaveBeenCalledTimes(1);
    expectCopied(f, /symlink creation.*failed/i);
  });

  it('a store disappearing during validation uses the installer fallback', () => {
    const f = fixture();
    const stat = vi.fn((path) => {
      if (path === join(f.storeDir, 'node_modules')) {
        setNodeModulesWritable(f.storeDir, true);
        rmSync(f.storeDir, { recursive: true });
      }
      return statSync(path);
    });
    const fallback = vi.fn((into) => {
      mkdirSync(join(into, 'node_modules'));
      writeFileSync(join(into, 'node_modules', 'payload.txt'), 'reinstalled');
    });
    cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log, stat, fallback })(f.root);
    expect(stat).toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(f.root);
    expect(readFileSync(join(target(f), 'payload.txt'), 'utf8')).toBe('reinstalled');
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

describe('read-only dependency stores and rebuild consumer retention', () => {
  it('completion freezes every package directory and file, and shared package writes are denied', () => {
    const f = fixture();
    for (const relative of ['', 'payload.txt', '.package-lock.json', 'pkg', 'pkg/index.js']) {
      expect(statSync(join(f.storeDir, 'node_modules', relative)).mode & 0o222).toBe(0);
    }
    deps.linkOrCopyNodeModules(f);
    expectLinked(f);
    expect(() => writeFileSync(join(target(f), 'pkg', 'index.js'), 'mutated')).toThrow(/EACCES|EPERM/);
    expect(readFileSync(join(target(f), 'pkg', 'index.js'), 'utf8')).toBe('export default 1;');
  });

  it('writable guarded store mode quarantines the tree and refuses a private copy', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules'), 0o755);
    const quarantined = expectQuarantined(f, /writable|readonly|read-only/i);
    expect(readFileSync(join(quarantined, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('export default 1;');
  });

  it('unreadable store permission evidence fails closed to copy with a log', () => {
    const f = fixture();
    const stat = (path) => new Proxy(statSync(path), {
      get: (entry, key) => key === 'mode' ? undefined : Reflect.get(entry, key),
    });
    deps.linkOrCopyNodeModules({ ...f, stat });
    expectCopied(f, /readonly|mode|unreadable/i);
  });

  it('eviction restores permissions and successfully deletes a read-only dependency store', () => {
    const f = fixture();
    expect(statSync(join(f.storeDir, 'node_modules', 'pkg')).mode & 0o222).toBe(0);
    const result = evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 });
    expect(result.evicted).toEqual([nodeModulesRef(basename(f.storeDir))]);
    expect(existsSync(f.storeDir)).toBe(false);
  });

  it('dry-run eviction leaves the store read-only and present', () => {
    const f = fixture();
    const result = evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0, dryRun: true });
    expect(result.evicted).toHaveLength(1);
    expect(statSync(join(f.storeDir, 'node_modules', 'pkg')).mode & 0o222).toBe(0);
  });

  it('freezing and evicting a store never chmods an external package symlink target', () => {
    const f = fixture();
    const external = join(f.base, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'package.js'), 'external');
    const initialMode = statSync(join(external, 'package.js')).mode;
    const other = ensureNodeModulesStore({
      jobsDir: join(f.base, 'linked-jobs'), sourceDir: f.sourceDir,
      install: (into) => {
        mkdirSync(join(into, 'node_modules'));
        symlinkSync(external, join(into, 'node_modules', 'workspace'), 'dir');
      },
    });
    expect(statSync(join(external, 'package.js')).mode).toBe(initialMode);
    evictSnapshots({ jobsDir: join(f.base, 'linked-jobs'), referenced: [], keep: 0 });
    expect(existsSync(other.dir)).toBe(false);
    expect(statSync(join(external, 'package.js')).mode).toBe(initialMode);
  });

  function runningRebuild(f) {
    mkdirSync(join(f.base, 'rebuild-jobs'));
    const store = createJobStore(join(f.base, 'rebuild-jobs'));
    const record = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: 'abc123', input: { root: f.root } });
    const prepared = prepareJobCode({
      store, record, kindDef: REBUILD_JOB_KIND,
      snapshot: {
        materialize: (into) => {
          for (const name of ['package.json', 'package-lock.json']) {
            writeFileSync(join(into, name), readFileSync(join(f.sourceDir, name)));
          }
        },
        install: cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log }),
      },
    });
    const at = new Date().toISOString();
    store.update(record.id, (fresh) => markClaimed(markLaunching(fresh, { at, ...prepared }), {
      at, handle: 'fixture-host:123:fixture-start', host: 'fixture-host', pid: 123, procStart: 'fixture-start',
    }));
    expect(store.read(record.id).job.status).toBe('running');
    expect(realpathSync(join(prepared.cwd, 'node_modules'))).toBe(realpathSync(join(f.storeDir, 'node_modules')));
    return { store, prepared };
  }

  it('a store referenced by a running rebuild snapshot in another job store is not evicted', () => {
    const f = fixture();
    const { store, prepared } = runningRebuild(f);
    expect(evictSnapshots({ jobsDir: store.dir, referenced: prepared.snapshotKeys, keep: 0 }).evicted).toEqual([]);
    // The dependency job store has no knowledge of the rebuild record's snapshotKeys.
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted).toEqual([]);
    expect(readFileSync(join(prepared.cwd, 'node_modules', 'payload.txt'), 'utf8')).toBe('store payload');
    expect(f.exec).not.toHaveBeenCalled();
  });

  it('consumer eviction leaves the shared source frozen, then releases its reverse reference', () => {
    const f = fixture();
    const { store } = runningRebuild(f);
    // No live refs supplied models the runtime after the job has finished.
    evictSnapshots({ jobsDir: store.dir, referenced: [], keep: 0 });
    expect(statSync(join(f.storeDir, 'node_modules')).mode & 0o222).toBe(0);
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted).toHaveLength(1);
    expect(existsSync(f.storeDir)).toBe(false);
  });

  it('unreadable rebuild reference evidence retains the store and logs the fail-closed reason', () => {
    const f = fixture();
    runningRebuild(f);
    const log = vi.fn();
    const readFile = vi.fn(() => { throw Object.assign(new Error('reference denied'), { code: 'EACCES' }); });
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0, readFile, log }).evicted).toEqual([]);
    expect(readFile).toHaveBeenCalled();
    expect(messages(log)).toMatch(/retain.*evidence.*unreadable/i);
    expect(existsSync(f.storeDir)).toBe(true);
  });

  it('failure to record a rebuild consumer reference refuses an unprotected copy and logs', () => {
    const f = fixture();
    writeFileSync(join(f.storeDir, '.node-modules-consumers'), 'not a directory');
    expect(() => cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log })(f.root))
      .toThrow(/consumer registration\/link failed/);
    expect(f.exec).not.toHaveBeenCalled();
    expect(existsSync(target(f))).toBe(false);
    expect(messages(f.log)).toMatch(/refusing unprotected copy/i);
  });

  it('registration between eviction selection and deletion protects the newly linked consumer source', () => {
    const f = fixture();
    expect(existsSync(join(f.storeDir, '.node-modules-consumers'))).toBe(false);
    const withLock = vi.fn((path, run, options) => {
      // Eviction has selected an unreferenced store but has not acquired the deletion lock.
      // Publish a real consumer in this precise gap, through the production lock implementation.
      cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log })(f.root);
      expectLinked(f);
      return withFileLock(path, run, options);
    });
    const result = evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0, withLock });
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(result.evicted).toEqual([]);
    expectLinked(f);
    expect(statSync(join(f.storeDir, 'node_modules')).mode & 0o222).toBe(0);
  });

  it('registration during a locked eviction refuses the swap without starting an incomplete copy', () => {
    const f = fixture();
    const withLock = vi.fn((path, run, options) => withFileLock(path, () => {
      // The publisher must use this SAME lock: it cannot publish a consumer behind eviction's back.
      expect(() => cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log })(f.root))
        .toThrow(/consumer registration\/link failed/);
      expect(f.exec).not.toHaveBeenCalled();
      expect(existsSync(target(f))).toBe(false);
      return run();
    }, options));
    const result = evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0, withLock });
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(result.evicted).toEqual([nodeModulesRef(basename(f.storeDir))]);
    expect(existsSync(f.storeDir)).toBe(false);
    expect(f.exec).not.toHaveBeenCalled();
    expect(existsSync(target(f))).toBe(false);
    expect(messages(f.log)).toMatch(/refusing unprotected copy/i);
  });

  it('a contended consumer lock makes eviction retain the frozen store and log the reason', () => {
    const f = fixture();
    const log = vi.fn();
    const withLock = vi.fn((path, run, options) => withFileLock(path, () => {
      // A competing publisher holds the real filesystem lock during the eviction attempt.
      return withFileLock(path, run, options);
    }, options));
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0, withLock, log }).evicted).toEqual([]);
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(messages(log)).toMatch(/retaining.*lock unavailable/i);
    expect(statSync(join(f.storeDir, 'node_modules')).mode & 0o222).toBe(0);
    expect(readFileSync(join(f.storeDir, 'node_modules', 'payload.txt'), 'utf8')).toBe('store payload');
  });

  it.each(['pkg', '@scope/other'])('a writable package directory %s is quarantined rather than copied', (name) => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', name), 0o755);
    expectQuarantined(f, /manifest|package|writable/i);
  });

  it('a writable scope directory quarantines the store', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', '@scope'), 0o755);
    expectQuarantined(f, /manifest|package|writable/i);
  });

  it('a writable package.json with unchanged content quarantines the store', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', 'pkg', 'package.json'), 0o644);
    expectQuarantined(f, /manifest|package|writable/i);
  });

  it('changed package.json size with read-only permissions restored quarantines the store', () => {
    const f = fixture();
    const path = join(f.storeDir, 'node_modules', 'pkg', 'package.json');
    chmodSync(path, 0o644);
    writeFileSync(path, '{"name":"pkg","version":"1.0.0","added":"new data"}');
    chmodSync(path, 0o444);
    expectQuarantined(f, /manifest.*mismatch/i);
  });

  it('a missing recorded package manifest falls back to copy and logs', () => {
    const f = fixture();
    rmSync(join(f.storeDir, NODE_MODULES_MANIFEST_FILE));
    deps.linkOrCopyNodeModules(f);
    expectCopied(f, /manifest.*missing/i);
  });

  it('unreadable package stat evidence falls back to copy and logs', () => {
    const f = fixture();
    const stat = (path) => {
      if (String(path).endsWith('package.json')) throw Object.assign(new Error('package denied'), { code: 'EACCES' });
      return statSync(path);
    };
    deps.linkOrCopyNodeModules({ ...f, stat });
    expectCopied(f, /manifest.*unreadable/i);
  });

  it('completion records a sorted shallow manifest including scoped package identities and stats', () => {
    const f = fixture();
    const manifest = JSON.parse(readFileSync(join(f.storeDir, NODE_MODULES_MANIFEST_FILE), 'utf8'));
    expect(manifest.packages).toEqual(['@scope/other', 'pkg'].map((name) => {
      const info = statSync(join(f.storeDir, 'node_modules', name, 'package.json'));
      return [name, name === 'pkg' ? 'pkg@1.0.0' : '@scope/other@2.0.0', info.size, info.mtimeMs];
    }));
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    deps.linkOrCopyNodeModules(f);
    expectLinked(f);
  });

  it('eviction immediately after a live swap retains its source without caller-supplied snapshot refs', () => {
    const f = fixture();
    deps.swapNodeModules(f);
    expectLinked(f);
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted).toEqual([]);
    expectLinked(f);
    const records = readdirSync(join(f.storeDir, '.node-modules-consumers')).map((name) =>
      JSON.parse(readFileSync(join(f.storeDir, '.node-modules-consumers', name), 'utf8')));
    expect(records.some((record) => record.live && record.refs.includes(nodeModulesRef(basename(f.storeDir))))).toBe(true);
  });

  it('an up-to-date dependency tick registers a persisted live symlink before later job eviction', async () => {
    const f = fixture();
    symlinkSync(join(f.storeDir, 'node_modules'), target(f), 'dir');
    expect(existsSync(join(f.storeDir, '.node-modules-consumers'))).toBe(false);
    const result = await deps.refreshDepsAsJob({
      root: f.root, installed: { read: () => basename(f.storeDir), write: vi.fn() },
      env: {}, log: f.log, store: createJobStore(join(f.base, 'jobs')),
    });
    expect(result.reason).toBe('up-to-date');
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted).toEqual([]);
    expectLinked(f);
  });

  it.each([false, true])('a dangling live link recovers through the installer/copy path (store ready: %s)', async (ready) => {
    const f = fixture();
    symlinkSync(join(f.base, 'missing-store', 'node_modules'), target(f), 'dir');
    const reattach = vi.fn(async () => null);
    const installed = { read: () => basename(f.storeDir), write: vi.fn() };
    const store = createJobStore(join(f.base, 'jobs'));
    if (!ready) rmSync(join(f.storeDir, '.snapshot-complete'));
    const options = { root: f.root, installed, reattach, codeSha: 'deadbeef',
      env: {}, log: f.log, store, swap: (args) => deps.swapNodeModules({ ...args, exec: f.exec }) };
    const result = await deps.refreshDepsAsJob(options);
    expect(result.reason).toBe(ready ? 'swapped' : 'deps-job-started');
    if (!ready) {
      expect(reattach).toHaveBeenCalledTimes(1);
      ensureNodeModulesStore({ jobsDir: store.dir, sourceDir: f.sourceDir, install: f.install });
      expect((await deps.refreshDepsAsJob(options)).reason).toBe('swapped');
    }
    expectCopied(f, /missing.*live|live.*missing/i);
    expect(installed.write).toHaveBeenCalledWith(basename(f.storeDir));
  });

  it('a present live target with incomplete registration evidence still refuses launch', async () => {
    const f = fixture();
    symlinkSync(join(f.storeDir, 'node_modules'), target(f), 'dir');
    rmSync(join(f.storeDir, '.snapshot-complete'));
    const reattach = vi.fn();
    const result = await deps.refreshDepsAsJob({
      root: f.root, installed: { read: () => null, write: vi.fn() }, reattach,
      env: {}, log: f.log, store: createJobStore(join(f.base, 'jobs')),
    });
    expect(result.reason).toBe('live-reference-failed');
    expect(reattach).not.toHaveBeenCalled();
    expect(messages(f.log)).toMatch(/live dependency reference unavailable.*not launching/i);
  });

  it.each(['swap', 'rollback'])('launchJob eviction after a live %s retains the live source absent from job snapshotKeys', (action) => {
    const f = fixture();
    deps.swapNodeModules(f);
    if (action === 'rollback') {
      writeFileSync(join(f.sourceDir, 'package-lock.json'), '{"newer":true}');
      const newer = ensureNodeModulesStore({ jobsDir: join(f.base, 'jobs'), sourceDir: f.sourceDir, install: f.install });
      deps.swapNodeModules({ ...f, storeDir: newer.dir });
      deps.swapNodeModules(f); // return to the older store; do not refresh its recency
    }
    const store = createJobStore(join(f.base, 'jobs'));
    const kindDef = deps.DEPS_JOB_KIND; // nodeModules:false: the new job never references the live store
    const record = enqueueJob({ store, kindDef, codeSha: 'deadc0de', input: {} });
    const evict = vi.fn((options) => evictSnapshots({ ...options, keep: 0 }));
    const result = launchJob({
      store, id: record.id, kindDef, snapshot: { materialize: () => {} },
      spawnFn: () => 1234, evict, env: {},
    });
    expect(result.job.status).toBe('launching');
    expect(result.job.snapshotKeys).not.toContain(nodeModulesRef(basename(f.storeDir)));
    expect(evict).toHaveBeenCalledTimes(1);
    expect(evict.mock.results[0].type).toBe('return');
    expectLinked(f);
  });
});

describe('whole-tree read-only reuse evidence', () => {
  it('a writable nested package file quarantines the store', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', 'pkg', 'node_modules', 'inner', 'lib', 'nested.js'), 0o644);
    expectQuarantined(f, /tree.*writable/i);
  });

  it('an added read-only nested file changes the recorded count and quarantines the store', () => {
    const f = fixture();
    const dir = join(f.storeDir, 'node_modules', 'pkg', 'node_modules', 'inner', 'lib');
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, 'extra.js'), 'extra');
    chmodSync(join(dir, 'extra.js'), 0o444);
    chmodSync(dir, 0o555);
    expectQuarantined(f, /tree entry count mismatch/i);
  });

  it('a writable nested dependency directory quarantines the store', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', 'pkg', 'node_modules', 'inner'), 0o755);
    expectQuarantined(f, /tree.*writable/i);
  });

  it('an unreadable nested lstat fails closed to copy with a reason', () => {
    const f = fixture();
    const lstat = vi.fn((path) => {
      if (String(path).endsWith('nested.js')) throw Object.assign(new Error('entry denied'), { code: 'EACCES' });
      return lstatSync(path);
    });
    deps.linkOrCopyNodeModules({ ...f, lstat });
    expect(lstat).toHaveBeenCalled();
    expectCopied(f, /tree.*unreadable/i);
  });

  it('unreadable nested directory contents fail closed to copy with a reason', () => {
    const f = fixture();
    const readDir = vi.fn((path, options) => {
      if (String(path).endsWith('lib')) throw Object.assign(new Error('directory denied'), { code: 'EACCES' });
      return readdirSync(path, options);
    });
    deps.linkOrCopyNodeModules({ ...f, readDir });
    expect(readDir).toHaveBeenCalled();
    expectCopied(f, /tree.*unreadable/i);
  });

  it('missing recorded tree count in an older manifest fails closed to copy', () => {
    const f = fixture();
    const path = join(f.storeDir, NODE_MODULES_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.entryCount;
    writeFileSync(path, JSON.stringify(manifest));
    deps.linkOrCopyNodeModules(f);
    expectCopied(f, /tree entry count evidence missing/i);
  });

  it('one lstat per entry matches the completion count and never follows symlink targets', () => {
    const f = fixture();
    const manifest = JSON.parse(readFileSync(join(f.storeDir, NODE_MODULES_MANIFEST_FILE), 'utf8'));
    const lstat = vi.fn(lstatSync);
    const evidence = nodeModulesTreeEvidence(join(f.storeDir, 'node_modules'), { lstat });
    expect(evidence.entryCount).toBe(manifest.entryCount);
    expect(lstat).toHaveBeenCalledTimes(evidence.entryCount);
    const paths = lstat.mock.calls.map(([path]) => path);
    expect(new Set(paths).size).toBe(evidence.entryCount);
    expect(paths).toContain(join(realpathSync(join(f.storeDir, 'node_modules')), '.bin', 'pkg'));
    expect(paths.some((path) => path.includes('/.bin/pkg/'))).toBe(false);
    deps.linkOrCopyNodeModules(f);
    expectLinked(f);
  });
});

describe('entry fingerprints, contained links, and protected copies', () => {
  it.each(['size', 'mtime'])('chmod-modify-restore of a nested file changes its %s fingerprint and quarantines the store', (change) => {
    const f = fixture();
    const path = join(f.storeDir, 'node_modules', 'pkg', 'node_modules', 'inner', 'lib', 'nested.js');
    const before = statSync(path);
    chmodSync(path, 0o644);
    writeFileSync(path, change === 'size' ? 'a different and longer implementation' : 'export default 9;');
    if (change === 'mtime') utimesSync(path, before.atime, new Date(before.mtimeMs + 2000));
    chmodSync(path, before.mode);
    expect(statSync(path).mode).toBe(before.mode);
    expectQuarantined(f, /fingerprint.*mismatch/i);
  });

  it('completion records the final read-only modes in the whole-tree fingerprint', () => {
    const f = fixture();
    const manifest = JSON.parse(readFileSync(join(f.storeDir, NODE_MODULES_MANIFEST_FILE), 'utf8'));
    const evidence = nodeModulesTreeEvidence(join(f.storeDir, 'node_modules'));
    expect(manifest.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence).toEqual({ entryCount: manifest.entryCount, treeSha256: manifest.treeSha256 });
    deps.linkOrCopyNodeModules(f);
    expectLinked(f);
  });

  it('an older manifest without a whole-tree fingerprint fails closed to copy', () => {
    const f = fixture();
    const path = join(f.storeDir, NODE_MODULES_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.treeSha256;
    writeFileSync(path, JSON.stringify(manifest));
    deps.linkOrCopyNodeModules(f);
    expectCopied(f, /fingerprint missing/i);
  });

  it('changing a relative internal link target invalidates the fingerprint', () => {
    const f = fixture();
    const bin = join(f.storeDir, 'node_modules', '.bin');
    chmodSync(bin, 0o755);
    rmSync(join(bin, 'pkg'));
    symlinkSync('../pkg/node_modules/inner/lib/nested.js', join(bin, 'pkg'));
    chmodSync(bin, 0o555);
    const quarantined = expectQuarantined(f, /fingerprint.*mismatch/i);
    expect(readlinkSync(join(quarantined, 'node_modules', '.bin', 'pkg'))).toBe('../pkg/node_modules/inner/lib/nested.js');
  });

  for (const depsMode of ['symlink', 'copy']) {
    it.each(['relative escape', 'absolute external target'])(`${depsMode} mode refuses a %s to a writable external file`, (kind) => {
      const f = fixture();
      const external = join(f.base, 'external.js');
      writeFileSync(external, 'external must stay private');
      expect(statSync(external).mode & 0o222).not.toBe(0);
      const bin = join(f.storeDir, 'node_modules', '.bin');
      const link = join(bin, 'pkg');
      chmodSync(bin, 0o755);
      rmSync(link);
      symlinkSync(kind === 'relative escape' ? relative(dirname(link), external) : external, link);
      chmodSync(bin, 0o555);
      expect(() => deps.linkOrCopyNodeModules({ ...f, depsMode })).toThrow(/unsafe.*symlink/i);
      expect(f.exec).not.toHaveBeenCalled();
      expect(existsSync(target(f))).toBe(false);
      expect(messages(f.log)).toMatch(/copy refused/i);
      expect(readFileSync(external, 'utf8')).toBe('external must stay private');
    });
  }

  it('production-style copies preserve relative nested symlinks within a private writable tree', () => {
    const f = fixture();
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'copy' });
    expectCopied(f);
    const link = join(target(f), '.bin', 'pkg');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../pkg/index.js');
    expect(realpathSync(link)).toBe(join(realpathSync(target(f)), 'pkg', 'index.js'));
    writeFileSync(link, 'private implementation');
    expect(readFileSync(join(f.storeDir, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('export default 1;');
    expect(readFileSync(link, 'utf8')).toBe('private implementation');
  });

  it('concurrent eviction in the middle of a copy cannot delete its protected source or publish an incomplete tree', () => {
    const f = fixture();
    let duringCopy;
    const exec = vi.fn((command, args, options) => {
      mkdirSync(args[2]);
      writeFileSync(join(args[2], 'payload.txt'), 'store payload');
      expect(existsSync(join(args[2], '.bin'))).toBe(false); // deliberately incomplete so far
      duringCopy = evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0, log: f.log });
      expect(duringCopy.evicted).toEqual([]);
      expect(existsSync(f.storeDir)).toBe(true);
      f.exec(command, args, options);
    });
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'copy', exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expectCopied(f);
    const manifest = JSON.parse(readFileSync(join(f.storeDir, NODE_MODULES_MANIFEST_FILE), 'utf8'));
    expect(nodeModulesTreeEvidence(target(f), { requireReadonly: false }).entryCount).toBe(manifest.entryCount);
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted).toHaveLength(1);
    expect(existsSync(f.storeDir)).toBe(false);
    expect(readFileSync(join(target(f), '.bin', 'pkg'), 'utf8')).toBe('export default 1;');
    expect(messages(f.log)).toMatch(/retaining.*lock unavailable/i);
  });
});

describe('quarantine recovery and explicit unsafe completion markers', () => {
  it('a quarantined mutated store is rebuilt at the same key through the normal installer path', () => {
    const f = fixture();
    const path = join(f.storeDir, 'node_modules', 'pkg', 'index.js');
    chmodSync(path, 0o644);
    writeFileSync(path, 'accidentally changed implementation');
    chmodSync(path, 0o444);
    const quarantined = expectQuarantined(f, /fingerprint.*mismatch/i);
    const rebuilt = ensureNodeModulesStore({ jobsDir: join(f.base, 'jobs'), sourceDir: f.sourceDir, install: f.install });
    expect(rebuilt.dir).toBe(f.storeDir);
    expect(f.install).toHaveBeenCalledTimes(2);
    expect(existsSync(quarantined)).toBe(true);
    deps.linkOrCopyNodeModules(f);
    expectLinked(f);
    const removed = evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [nodeModulesRef(rebuilt.key)], keep: 0 });
    expect(removed.evicted).toEqual([`quarantine:${basename(quarantined)}`]);
    expect(existsSync(quarantined)).toBe(false);
  });

  it('excessive quarantined recovery generations refuse install and name operator cleanup', () => {
    const f = fixture();
    let key = basename(f.storeDir);
    for (let generation = 0; generation < 16; generation += 1) {
      const dir = join(dirname(f.storeDir), key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dirname(dir), `.node-modules-quarantined-${key}.json`), '{}');
      key = lockfileKey(`${key}:{}`);
    }
    expect(() => ensureNodeModulesStore({ jobsDir: join(f.base, 'jobs'), sourceDir: f.sourceDir, install: f.install }))
      .toThrow(/recovery generation limit.*operator.*cleanup/i);
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it('explicit copy mode also quarantines a store whose recorded fingerprint proves mutation', () => {
    const f = fixture();
    const path = join(f.storeDir, 'node_modules', 'pkg', 'index.js');
    chmodSync(path, 0o644);
    writeFileSync(path, 'unexpected mutation');
    chmodSync(path, 0o444);
    expectQuarantined(f, /fingerprint.*mismatch/i, () => deps.linkOrCopyNodeModules({ ...f, depsMode: 'copy' }));
  });

  it('quarantine recovers through a fresh store and a pass-boundary swap without removing the live link', async () => {
    const f = fixture();
    deps.swapNodeModules(f);
    const path = join(f.storeDir, 'node_modules', 'pkg', 'index.js');
    chmodSync(path, 0o644);
    writeFileSync(path, 'mutated while shared');
    chmodSync(path, 0o444);
    expect(() => deps.linkOrCopyNodeModules(f)).toThrow(/dependency store mutated/);
    expect(realpathSync(target(f))).toBe(join(f.storeDir, 'node_modules'));
    expect(readFileSync(join(target(f), 'pkg', 'index.js'), 'utf8')).toBe('mutated while shared');
    expect(statSync(join(f.storeDir, 'node_modules')).mode & 0o222).toBe(0);
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted).toEqual([]);
    const reattach = vi.fn(async () => null);
    const result = await deps.refreshDepsAsJob({
      root: f.root, installed: { read: () => basename(f.storeDir), write: vi.fn() },
      store: createJobStore(join(f.base, 'jobs')), reattach, codeSha: 'deadbeef', env: {}, log: f.log,
    });
    expect(result.reason).toBe('deps-job-started');
    expect(reattach).toHaveBeenCalledTimes(1);
    const rebuilt = ensureNodeModulesStore({ jobsDir: join(f.base, 'jobs'), sourceDir: f.sourceDir, install: f.install });
    expect(rebuilt.dir).not.toBe(f.storeDir);
    expect(f.install).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(target(f), 'pkg', 'index.js'), 'utf8')).toBe('mutated while shared');
    expect(deps.depsStore(join(f.base, 'jobs'), basename(f.storeDir))).toMatchObject({ dir: rebuilt.dir, complete: true });
    const write = vi.fn();
    expect((await deps.refreshDepsAsJob({
      root: f.root, installed: { read: () => basename(f.storeDir), write },
      store: createJobStore(join(f.base, 'jobs')), reattach, env: {}, log: f.log,
      evict: (options) => evictSnapshots({ ...options, keep: 0 }),
      swap: (args) => deps.swapNodeModules({ ...args, exec: f.exec }),
    })).reason).toBe('swapped');
    expect(write).toHaveBeenCalledWith(basename(f.storeDir));
    expect(readFileSync(join(target(f), 'pkg', 'index.js'), 'utf8')).toBe('export default 1;');
    expect(realpathSync(target(f))).toBe(realpathSync(join(rebuilt.dir, 'node_modules')));
    expect(existsSync(f.storeDir)).toBe(false);
    expect(deps.depsStore(join(f.base, 'jobs'), basename(f.storeDir))).toMatchObject({ dir: rebuilt.dir, complete: true });
  });

  it('quarantine retains a rebuild snapshot source until the snapshot is removed', () => {
    const f = fixture();
    cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log })(f.root);
    expect(quarantineNodeModulesStore(f.storeDir, 'mutation')).toBe(f.storeDir);
    expectLinked(f);
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted).toEqual([]);
    rmSync(f.root, { recursive: true });
    expect(evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0 }).evicted)
      .toEqual([nodeModulesRef(basename(f.storeDir))]);
    expect(existsSync(f.storeDir)).toBe(false);
  });

  it.each(['hash', 'manifest', 'chmod', 'tree', 'manifest-write'])('evidence failure in %s publishes an unsafe marker BEFORE completion and forces a private copy', (phase) => {
    const f = fixture();
    const failure = () => { throw Object.assign(new Error(`${phase} evidence denied`), { code: 'EACCES' }); };
    const options = {};
    if (phase === 'hash') options.readFile = failure;
    if (phase === 'manifest') options.packageManifest = failure;
    if (phase === 'chmod') options.freeze = failure;
    if (phase === 'tree') options.treeEvidence = failure;
    let sawUnsafeBeforeComplete = false;
    const writeFile = vi.fn((path, text) => {
      if (basename(path) === NODE_MODULES_UNSAFE_FILE) {
        expect(existsSync(join(dirname(path), '.snapshot-complete'))).toBe(false);
        sawUnsafeBeforeComplete = true;
      }
      writeFileSync(path, text);
      // Even a durable, valid manifest cannot override an explicit generation-failure marker.
      if (phase === 'manifest-write' && basename(path) === NODE_MODULES_MANIFEST_FILE) failure();
    });
    const unsafe = ensureNodeModulesStore({
      jobsDir: join(f.base, 'unsafe-jobs'), sourceDir: f.sourceDir, install: f.install, ...options, writeFile,
    });
    expect(sawUnsafeBeforeComplete).toBe(true);
    expect(JSON.parse(readFileSync(join(unsafe.dir, NODE_MODULES_UNSAFE_FILE), 'utf8')))
      .toMatchObject({ phase, code: 'EACCES', reason: `${phase} evidence denied` });
    expect(existsSync(join(unsafe.dir, '.snapshot-complete'))).toBe(true);
    deps.linkOrCopyNodeModules({ ...f, storeDir: unsafe.dir });
    expectCopied(f, /marked unsafe.*private copy/i);
    expect(existsSync(unsafe.dir)).toBe(true);
    expect(existsSync(join(unsafe.dir, NODE_MODULES_UNSAFE_FILE))).toBe(true);
  });

  it('an injected installer without a hidden lock completes with an unsafe marker and remains copy-only', () => {
    const f = fixture();
    const unsafe = ensureNodeModulesStore({
      jobsDir: join(f.base, 'injected-jobs'), sourceDir: f.sourceDir,
      install: (into) => {
        mkdirSync(join(into, 'node_modules'));
        writeFileSync(join(into, 'node_modules', 'payload.txt'), 'store payload');
      },
    });
    expect(JSON.parse(readFileSync(join(unsafe.dir, NODE_MODULES_UNSAFE_FILE), 'utf8'))).toMatchObject({ phase: 'hash', code: 'ENOENT' });
    expect(existsSync(join(unsafe.dir, '.snapshot-complete'))).toBe(true);
    deps.linkOrCopyNodeModules({ ...f, storeDir: unsafe.dir });
    expectCopied(f, /marked unsafe.*private copy/i);
  });

  it('an unsafe nested symlink is marked before completion and the I2 copy-safety guard still refuses it', () => {
    const f = fixture();
    const external = join(f.base, 'external.js');
    writeFileSync(external, 'external');
    const mode = statSync(external).mode;
    const unsafe = ensureNodeModulesStore({
      jobsDir: join(f.base, 'unsafe-link-jobs'), sourceDir: f.sourceDir,
      install: (into) => {
        f.install(into);
        const link = join(into, 'node_modules', '.bin', 'external');
        symlinkSync(relative(dirname(link), external), link);
      },
    });
    expect(JSON.parse(readFileSync(join(unsafe.dir, NODE_MODULES_UNSAFE_FILE), 'utf8')))
      .toMatchObject({ phase: 'tree', code: 'EUNSAFENODEMODULESLINK' });
    expect(existsSync(join(unsafe.dir, '.snapshot-complete'))).toBe(true);
    expect(() => deps.linkOrCopyNodeModules({ ...f, storeDir: unsafe.dir })).toThrow(/unsafe.*symlink/i);
    expect(f.exec).not.toHaveBeenCalled();
    expect(messages(f.log)).toMatch(/marked unsafe/i);
    expect(statSync(external).mode).toBe(mode);
  });

  it('failure to write an unsafe marker aborts completion rather than publishing an unmarked store', () => {
    const f = fixture();
    const jobsDir = join(f.base, 'marker-denied-jobs');
    expect(() => ensureNodeModulesStore({
      jobsDir, sourceDir: f.sourceDir, install: (into) => mkdirSync(join(into, 'node_modules')),
      writeFile: (path, text) => {
        if (basename(path) === NODE_MODULES_UNSAFE_FILE) throw new Error('unsafe marker denied');
        writeFileSync(path, text);
      },
    })).toThrow('unsafe marker denied');
    expect(existsSync(join(jobsDir, '.snapshots', 'node-modules', basename(f.storeDir)))).toBe(false);
  });
});

describe('raw dependency settings and every platform file fail closed', () => {
  const invalidValues = [{}, { nested: 'symlink' }, [], null, true, 0, 'unknown'];
  for (const layer of ['file', 'platform', 'env']) {
    it.each(invalidValues.map((value) => [value]))(`invalid raw ${layer} depsMode %j cannot disappear or be hidden by a valid override`, (value) => {
      const log = vi.fn();
      const env = { WE_PLATFORM_PREFERENCES_FILE: 'fixture-platform.json', WE_DAEMON_REBUILD_DEPS_MODE: layer === 'env' ? value : 'symlink' };
      const settings = layer === 'file' ? { rebuild: { depsMode: value } } : {};
      const readFile = vi.fn(() => JSON.stringify(layer === 'platform' ? { rebuild: { depsMode: value } } : {}));
      expect(deps.resolveRebuildDepsMode({ env, settings, log, readFile })).toEqual({ mode: 'copy', source: 'invalid' });
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(messages(log)).toMatch(/copy.*invalid/i);
    });
  }

  it('an explicitly present undefined environment mode is invalid rather than absent', () => {
    const log = vi.fn();
    expect(deps.resolveRebuildDepsMode({
      env: { WE_PLATFORM_PREFERENCES_FILE: 'fixture-platform.json', WE_DAEMON_REBUILD_DEPS_MODE: undefined },
      settings: {}, readFile: () => '{}', log,
    })).toEqual({ mode: 'copy', source: 'invalid' });
    expect(messages(log)).toMatch(/copy.*invalid/i);
  });

  const platformPaths = [...LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH, operatorPreferencesPath({})];
  for (const [index, path] of platformPaths.entries()) {
    it.each(['read denied', 'invalid JSON'])(`platform file ${index + 1}: %s forces copy even with a valid environment override`, (failure) => {
      const log = vi.fn();
      const readFile = vi.fn((requested) => {
        if (requested !== path) return '{}';
        if (failure === 'invalid JSON') return '{';
        throw Object.assign(new Error('policy denied'), { code: 'EACCES' });
      });
      expect(deps.resolveRebuildDepsMode({ env: { WE_DAEMON_REBUILD_DEPS_MODE: 'symlink' }, settings: {}, log, readFile }))
        .toEqual({ mode: 'copy', source: 'invalid' });
      expect(readFile).toHaveBeenCalledTimes(platformPaths.length);
      for (const expected of platformPaths) expect(readFile).toHaveBeenCalledWith(expected, 'utf8');
      expect(messages(log)).toMatch(/copy.*invalid.*unreadable/i);
    });
  }

  it('an unreadable explicit platform override forces copy and bypasses all default platform paths', () => {
    const readFile = vi.fn(() => { throw Object.assign(new Error('override denied'), { code: 'EACCES' }); });
    const log = vi.fn();
    expect(deps.resolveRebuildDepsMode({ env: { WE_PLATFORM_PREFERENCES_FILE: 'override.json' }, settings: {}, log, readFile }))
      .toEqual({ mode: 'copy', source: 'invalid' });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith('override.json', 'utf8');
    expect(messages(log)).toMatch(/unreadable/i);
  });

  it('ENOENT platform files are absent preferences and preserve the symlink default', () => {
    const log = vi.fn();
    const readFile = vi.fn(() => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); });
    expect(deps.resolveRebuildDepsMode({ env: {}, settings: {}, log, readFile })).toEqual({ mode: 'symlink', source: 'built-in' });
    expect(readFile).toHaveBeenCalledTimes(platformPaths.length);
  });

  it('an unreadable rebuild settings file forces copy even with valid platform and environment modes', () => {
    const log = vi.fn();
    const readFile = vi.fn((path) => {
      if (String(path).endsWith('daemon-rebuild-settings.json')) throw Object.assign(new Error('settings denied'), { code: 'EACCES' });
      return '{"rebuild":{"depsMode":"symlink"}}';
    });
    expect(deps.resolveRebuildDepsMode({ env: { WE_DAEMON_REBUILD_DEPS_MODE: 'symlink' }, log, readFile }))
      .toEqual({ mode: 'copy', source: 'invalid' });
    expect(messages(log)).toMatch(/unreadable/i);
  });
});
