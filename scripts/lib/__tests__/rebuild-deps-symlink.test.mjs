/** Round 1 contract tests: no subprocesses, installs, or host filesystem assumptions.
 * Shared helper contract used here: { root, storeDir, depsMode, step, exec, log,
 * stat = statSync, readFile = readFileSync }; destination is root/node_modules.
 * Store integrity evidence is produced by ensureNodeModulesStore, never forged here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as deps from '../daemon-rebuild/deps-job.mjs';
import { cloneNodeModulesInstaller, REBUILD_JOB_KIND } from '../daemon-rebuild/rebuild-job.mjs';
import { ensureNodeModulesStore, evictSnapshots, NODE_MODULES_MANIFEST_FILE, nodeModulesRef, setNodeModulesWritable } from '../daemon-job-snapshots.mjs';
import { createJobStore, enqueueJob, launchJob, prepareJobCode } from '../daemon-jobs-runtime.mjs';
import { markClaimed, markLaunching } from '../daemon-jobs.mjs';
import { withFileLock } from '../atomic-json-file.mjs';

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    // Fixtures now contain frozen stores. Cleanup must not follow links into another store.
    setNodeModulesWritable(dir, true);
    rmSync(dir, { recursive: true, force: true });
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
    // Deliberately bypass the new file protection to exercise the existing hash guard independently.
    chmodSync(join(f.storeDir, 'node_modules', '.package-lock.json'), 0o644);
    writeFileSync(join(f.storeDir, 'node_modules', '.package-lock.json'), '{"tampered":true}');
    deps.linkOrCopyNodeModules({ ...f, depsMode: 'symlink' });
    expectCopied(f, /hash|integrity|mismatch|mutat/i);
  });

  it('missing store integrity evidence fails closed to copy with a reason', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules'), 0o755);
    rmSync(join(f.storeDir, 'node_modules', '.package-lock.json'));
    chmodSync(join(f.storeDir, 'node_modules'), 0o555);
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
    chmodSync(join(f.storeDir, 'node_modules', '.package-lock.json'), 0o644);
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

  it('writable store mode falls back to a writable private copy and logs the integrity reason', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules'), 0o755);
    deps.linkOrCopyNodeModules(f);
    expectCopied(f, /writable|readonly|read-only/i);
    writeFileSync(join(target(f), 'pkg', 'index.js'), 'private change');
    expect(readFileSync(join(f.storeDir, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('export default 1;');
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

  it('failure to record a rebuild consumer reference falls back to a private copy and logs', () => {
    const f = fixture();
    writeFileSync(join(f.storeDir, '.node-modules-consumers'), 'not a directory');
    cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log })(f.root);
    expectCopied(f, /failed|ENOTDIR/i);
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

  it('registration during a locked eviction falls back to a private copy before the source is deleted', () => {
    const f = fixture();
    const withLock = vi.fn((path, run, options) => withFileLock(path, () => {
      // The publisher must use this SAME lock: it cannot publish a consumer behind eviction's back.
      cloneNodeModulesInstaller(f.storeDir, { exec: f.exec, log: f.log })(f.root);
      expectCopied(f, /registration.*failed|lock/i);
      return run();
    }, options));
    const result = evictSnapshots({ jobsDir: join(f.base, 'jobs'), referenced: [], keep: 0, withLock });
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(result.evicted).toEqual([nodeModulesRef(basename(f.storeDir))]);
    expect(existsSync(f.storeDir)).toBe(false);
    expectCopied(f);
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

  it.each(['pkg', '@scope/other'])('a writable package directory %s falls back to copy and logs', (name) => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', name), 0o755);
    deps.linkOrCopyNodeModules(f);
    expectCopied(f, /manifest|package|writable/i);
  });

  it('a writable scope directory falls back to copy and logs', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', '@scope'), 0o755);
    deps.linkOrCopyNodeModules(f);
    expectCopied(f, /manifest|package|writable/i);
  });

  it('a writable package.json with unchanged content falls back to copy and logs', () => {
    const f = fixture();
    chmodSync(join(f.storeDir, 'node_modules', 'pkg', 'package.json'), 0o644);
    deps.linkOrCopyNodeModules(f);
    expectCopied(f, /manifest|package|writable/i);
  });

  it('changed package.json size with read-only permissions restored falls back to copy and logs', () => {
    const f = fixture();
    const path = join(f.storeDir, 'node_modules', 'pkg', 'package.json');
    chmodSync(path, 0o644);
    writeFileSync(path, '{"name":"pkg","version":"1.0.0","added":"new data"}');
    chmodSync(path, 0o444);
    deps.linkOrCopyNodeModules(f);
    expectCopied(f, /manifest.*mismatch/i);
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

  it('unreadable persisted live target evidence refuses dependency job launch and logs the reason', async () => {
    const f = fixture();
    symlinkSync(join(f.base, 'missing-store', 'node_modules'), target(f), 'dir');
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
