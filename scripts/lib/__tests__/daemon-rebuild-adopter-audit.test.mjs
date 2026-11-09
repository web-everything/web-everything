/** Red regressions for the committed adopter. Only process/materializer boundaries are fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const io = vi.hoisted(() => {
  vi.resetModules();
  return { exec: vi.fn(), unstable: false, unstableDependency: false, reads: 0 };
});
vi.mock('node:child_process', async original => ({
  ...await original(), execFileSync: (...args) => io.exec(...args),
}));
vi.mock('node:fs', async original => {
  const fs = await original();
  return { ...fs, readFileSync(path, ...args) {
    const bytes = fs.readFileSync(path, ...args);
    if ((io.unstable && String(path).endsWith('/scripts/lib/daemon-rebuild.mjs'))
      || (io.unstableDependency && String(path).endsWith('/node_modules/pkg/index.js'))) {
      const changing = `// changed during verification ${++io.reads}\n`;
      return typeof bytes === 'string' ? changing : Buffer.from(changing);
    }
    return bytes;
  } };
});

import { rebuildClone } from '../daemon-rebuild.mjs';
import * as snapshots from '../daemon-job-snapshots.mjs';
import * as jobs from '../daemon-rebuild/rebuild-job.mjs';
import * as origin from '../daemon-self-sync.mjs';
import * as forceWatch from '../daemon-force-adopt.mjs';
import * as overlays from '../overlay-adoption.mjs';
import * as prepare from '../daemon-rebuild/prepare.mjs';
import * as wrongBranch from '../daemon-rebuild/wrong-branch-heal.mjs';
import { withWriteLock } from '../daemon-clone-lock.mjs';
import { createJobStore, prepareJobCode } from '../daemon-jobs-runtime.mjs';
import { readReadyCandidate, readRebuildState, writeReadyCandidate, writeRebuildState } from '../daemon-rebuild/state.mjs';

const ensureCode = snapshots.ensureCodeSnapshot;
const realPrepare = prepare.prepareRebuild;
const MAIN = 'a'.repeat(40);
const BEFORE = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const LOCK = '{"name":"pinned","lockfileVersion":3,"packages":{}}\n';
const CLI = 'scripts/lib/daemon-rebuild.mjs';
const CODE = '// reviewed main\n';
const quiet = { error() {}, warn() {}, log() {} };
const sha = text => createHash('sha256').update(text).digest('hex');
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
let base;
beforeEach(() => {
  base = mkdtempSync(join(process.env.TMPDIR, 'adopter-audit-'));
  io.exec.mockReset();
  io.unstable = false;
  io.unstableDependency = false;
  io.reads = 0;
  vi.spyOn(forceWatch, 'runForceWatchTick').mockResolvedValue({});
  vi.spyOn(overlays, 'checkPendingAdoptions').mockResolvedValue([]);
  vi.spyOn(origin, 'readOriginRefSha').mockReturnValue(MAIN);
  io.exec.mockImplementation((command, argv, options) => {
    if (command === 'npm' && argv[0] === 'ci') {
      expect(readFileSync(join(options.cwd, 'package-lock.json'), 'utf8')).toBe(LOCK);
      expect(readFileSync(join(options.cwd, 'package.json'), 'utf8')).toBe('{"name":"pinned"}');
      put(options.cwd, 'node_modules/pkg/index.js', 'reviewed dependency\n');
      return '';
    }
    // Simulate both checkout-copy variants without running host processes.
    if (command === 'cp') { cpSync(argv[1], argv[2], { recursive: true }); return ''; }
    throw new Error(`Unexpected process ${command} ${argv.join(' ')}`);
  });
});
afterEach(() => {
  io.unstable = false;
  io.unstableDependency = false;
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function fixture({ ready = true } = {}) {
  const root = join(base, 'checkout');
  const env = {
    WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_JOBS_ROOT: join(base, 'jobs'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'), WE_DAEMON_AUTO_REBASE: '0',
  };
  put(root, '.git/HEAD', TARGET);
  put(root, 'package.json', '{"name":"moving-checkout"}');
  put(root, 'package-lock.json', LOCK);
  put(root, 'node_modules/pkg/index.js', 'moving checkout dependency\n');
  const materialize = vi.fn(into => {
    put(into, CLI, CODE);
    put(into, 'tracked.txt', 'pinned file\n');
    put(into, 'package.json', '{"name":"pinned"}');
    put(into, 'package-lock.json', LOCK);
  });
  // Keep real snapshot creation/reuse/verification. Archive extraction is the only fake.
  vi.spyOn(snapshots, 'ensureCodeSnapshot').mockImplementation(options =>
    ensureCode({ ...options, materialize }));
  const jobsDir = jobs.rebuildJobsDir(root, env);
  const code = () => snapshots.ensureCodeSnapshot({ jobsDir, codeSha: MAIN, repoDir: root });
  if (ready) expect(writeReadyCandidate(root, {
    prevHead: TARGET, adopt: { finalSha: MAIN }, smoke: { verdict: 'pass' },
  }, env)).toBe(true);
  const child = vi.fn(async () => ({ status: 0, stdout: JSON.stringify({ moved: false, reason: 'needs-build' }) }));
  const loadedRun = vi.fn(() => { throw new Error('Loaded planner must never perform recovery'); });
  const tick = () => rebuildClone({ root, env, asJob: true, adoptChild: { run: child },
    run: loadedRun, emitEvent: vi.fn(), log: quiet });
  return { root, env, jobsDir, materialize, code, child, tick, loadedRun };
}

describe('no-ready recovery belongs to the reviewed main child', () => {
  it.each(['unverified', 'quarantine'])('%s recovery runs on this tick despite no ready candidate', async field => {
    const f = fixture({ ready: false });
    writeRebuildState(f.root, { [field]: { head: TARGET, prevHead: BEFORE } }, f.env);
    vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
    const loadedPlanner = vi.spyOn(prepare, 'prepareRebuild').mockImplementation(() => {
      throw new Error('Loaded planner used instead of reviewed child');
    });
    vi.spyOn(wrongBranch, 'healWrongBranch').mockReturnValue({ healed: false });
    let head = TARGET;
    const resets = [];
    const childGit = vi.fn(argv => {
      if (argv[0] === 'rev-parse') return { status: 0, stdout: argv.at(-1) === 'HEAD' ? head : BEFORE };
      if (['status', 'ls-files'].includes(argv[0])) return { status: 0, stdout: '' };
      if (argv[0] === 'reset') { resets.push(argv); head = argv.at(-1); return { status: 0, stdout: '' }; }
      if (argv[0] === 'symbolic-ref') return { status: 0, stdout: 'fixture-stop-after-recovery' };
      throw new Error(`Unexpected child git ${argv.join(' ')}`);
    });
    const deferred = await realPrepare({ root: f.root, env: f.env, log: quiet, run: childGit,
      now: () => Date.now(), stateOpts: {}, prState: async () => null, readyOnly: true });
    expect(deferred.result).toMatchObject({ reason: 'readonly-job-mutation-due',
      mutation: field === 'unverified' ? 'unverified-rollback' : 'quarantine-reset' });
    expect(resets).toEqual([]);
    f.child.mockImplementation(async (_executable, argv, options) => {
      expect(options.cwd).toBe(f.code());
      expect(argv[0]).toBe(join(options.cwd, CLI));
      expect(argv).toContain('--adopt-only');
      // The injected process boundary executes real recovery under the real write lock.
      const locked = await withWriteLock(f.root, () => realPrepare({
        root: f.root, env: f.env, log: quiet, run: childGit, now: () => Date.now(),
        stateOpts: {}, prState: async () => null, readyOnly: false,
      }), { lockRoot: f.env.WE_DAEMON_CLONE_LOCK_ROOT, waitMs: 0 });
      expect(locked.ok).toBe(true);
      return { status: 0, stdout: JSON.stringify(locked.value.result) };
    });
    expect(readReadyCandidate(f.root, f.env)).toBeNull();
    await f.tick();
    expect.soft(f.child).toHaveBeenCalledTimes(1);
    expect.soft(resets).toEqual([['reset', '--hard', BEFORE]]);
    expect.soft(readRebuildState(f.root, f.env)[field]).toBeNull();
    expect.soft(head).toBe(BEFORE);
    expect(loadedPlanner).not.toHaveBeenCalled();
    expect(f.loadedRun).not.toHaveBeenCalled();
  });

  it('no-ready child failure refuses the tick and leaves recovery owed', async () => {
    const f = fixture({ ready: false });
    writeRebuildState(f.root, { quarantine: { prevHead: BEFORE } }, f.env);
    vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
    f.child.mockResolvedValue({ status: 1, stdout: '{"moved":false,"reason":"needs-build"}' });
    await expect(f.tick()).resolves.toMatchObject({ moved: false, reason: 'adopt-child-failed' });
    expect(f.child).toHaveBeenCalledTimes(1);
    expect(readRebuildState(f.root, f.env).quarantine).toEqual({ prevHead: BEFORE });
    expect(f.loadedRun).not.toHaveBeenCalled();
  });
});

describe('pinned code snapshot integrity before adoption', () => {
  it('reuses an unchanged pinned snapshot without rematerializing', async () => {
    const f = fixture();
    vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
    f.code();
    await f.tick();
    await f.tick();
    expect(f.materialize).toHaveBeenCalledTimes(1);
    expect(f.child).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['tampered CLI', dir => put(dir, CLI, '// unreviewed\n')],
    ['added file', dir => put(dir, 'injected.mjs', '// unreviewed\n')],
    ['removed file', dir => rmSync(join(dir, 'tracked.txt'))],
    ['missing completion marker', dir => rmSync(join(dir, '.snapshot-complete'))],
  ])('%s discards and rebuilds exactly once before the child runs', async (_name, corrupt) => {
    const f = fixture();
    vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
    const dir = f.code();
    corrupt(dir);
    let observed;
    f.child.mockImplementation(async () => {
      observed = {
        cli: readFileSync(join(dir, CLI), 'utf8'),
        tracked: existsSync(join(dir, 'tracked.txt')) ? readFileSync(join(dir, 'tracked.txt'), 'utf8') : null,
        added: existsSync(join(dir, 'injected.mjs')),
      };
      return { status: 0, stdout: '{"moved":false,"reason":"needs-build"}' };
    });
    await expect(f.tick()).resolves.toMatchObject({ reason: 'needs-build' });
    expect.soft(f.materialize).toHaveBeenCalledTimes(2);
    expect(f.child).toHaveBeenCalledTimes(1);
    expect(observed).toEqual({ cli: CODE, tracked: 'pinned file\n', added: false });
  });

  it('rejects a complete snapshot and its integrity evidence replayed from a different pinned SHA', async () => {
    const f = fixture();
    vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
    const dir = f.code();
    const other = ensureCode({ jobsDir: f.jobsDir, codeSha: 'd'.repeat(40), repoDir: f.root,
      materialize: into => { f.materialize(into); put(into, CLI, '// different commit\n'); } });
    // Copy the whole published tree, including whatever evidence the builder records.
    // A digest that is internally consistent but belongs to another SHA is insufficient.
    rmSync(dir, { recursive: true });
    cpSync(other, dir, { recursive: true });
    f.materialize.mockClear();
    let observed;
    f.child.mockImplementation(async () => {
      observed = readFileSync(join(dir, CLI), 'utf8');
      return { status: 0, stdout: '{"moved":false,"reason":"needs-build"}' };
    });
    await expect(f.tick()).resolves.toMatchObject({ reason: 'needs-build' });
    expect.soft(f.materialize).toHaveBeenCalledTimes(1);
    expect(observed).toBe(CODE);
  });

  it('a repaired code tree still changing during verification fails closed after one rebuild', async () => {
    const f = fixture();
    vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
    const dir = f.code();
    put(dir, CLI, '// corrupt cached snapshot\n');
    const ready = readReadyCandidate(f.root, f.env);
    io.unstable = true;
    await expect(f.tick()).resolves.toMatchObject({ moved: false, reason: 'adopt-child-failed' });
    expect(f.materialize).toHaveBeenCalledTimes(2);
    expect(f.child).not.toHaveBeenCalled();
    expect(readReadyCandidate(f.root, f.env)).toEqual(ready);
    expect(f.loadedRun).not.toHaveBeenCalled();
  });
});

async function jobFixture() {
  const f = fixture({ ready: false });
  const store = createJobStore(f.jobsDir);
  let snapshot;
  const reattach = vi.fn(async options => { snapshot = options.snapshot; return { actions: [] }; });
  await jobs.rebuildCloneAsJob({ root: f.root, env: f.env, store, reattach, codeSha: MAIN,
    adopt: async () => ({ moved: false, reason: 'needs-build' }), log: quiet,
    evict: () => ({ evicted: [] }) });
  const [record] = store.list().records;
  const prepareCode = () => prepareJobCode({ store, record, kindDef: jobs.REBUILD_JOB_KIND, snapshot });
  const dependencyDir = cwd => dirname(realpathSync(join(cwd, 'node_modules')));
  return { ...f, store, record, prepareCode, dependencyDir };
}

describe('main-pinned rebuild job dependencies', () => {
  it('uses npm ci on the pinned manifest and lockfile even when checkout lock matches', async () => {
    const f = await jobFixture();
    expect(f.record.job.codeSha).toBe(MAIN);
    const { cwd } = f.prepareCode();
    expect.soft(readFileSync(join(cwd, 'node_modules/pkg/index.js'), 'utf8')).toBe('reviewed dependency\n');
    expect.soft(io.exec.mock.calls.filter(([cmd]) => cmd === 'cp')).toHaveLength(0);
    expect(io.exec.mock.calls.filter(([cmd]) => cmd === 'npm')).toHaveLength(1);
    expect(io.exec).toHaveBeenCalledWith('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], expect.objectContaining({ cwd: expect.any(String) }));
  });

  it('records the same dependency integrity evidence as the adopter and reuses it', async () => {
    const f = await jobFixture();
    const { cwd } = f.prepareCode();
    const dir = f.dependencyDir(cwd);
    const text = 'reviewed dependency\n';
    expect(JSON.parse(readFileSync(join(dir, '.snapshot-integrity.json'), 'utf8'))).toEqual({
      lockHash: sha(LOCK), treeDigest: sha(JSON.stringify([
        { path: 'pkg/index.js', size: Buffer.byteLength(text), sha256: sha(text) },
      ])),
    });
    f.prepareCode();
    expect(io.exec.mock.calls.filter(([cmd]) => cmd === 'npm')).toHaveLength(1);
  });

  it.each([
    ['changed dependency', dir => put(dir, 'node_modules/pkg/index.js', 'tampered')],
    ['added dependency', dir => put(dir, 'node_modules/extra.js', 'tampered')],
    ['removed dependency', dir => rmSync(join(dir, 'node_modules/pkg/index.js'))],
    ['missing integrity record', dir => rmSync(join(dir, '.snapshot-integrity.json'), { force: true })],
    ['wrong lock hash', dir => put(dir, '.snapshot-integrity.json', '{"lockHash":"wrong","treeDigest":"wrong"}')],
    ['missing completion marker', dir => rmSync(join(dir, '.snapshot-complete'))],
  ])('%s in a cached job store triggers one npm repair', async (_name, corrupt) => {
    const f = await jobFixture();
    const { cwd } = f.prepareCode();
    const dir = f.dependencyDir(cwd);
    corrupt(dir);
    f.prepareCode();
    expect.soft(io.exec.mock.calls.filter(([cmd]) => cmd === 'cp')).toHaveLength(0);
    expect.soft(io.exec.mock.calls.filter(([cmd]) => cmd === 'npm')).toHaveLength(2);
    expect.soft(readFileSync(join(cwd, 'node_modules/pkg/index.js'), 'utf8')).toBe('reviewed dependency\n');
    expect(existsSync(join(cwd, 'node_modules/extra.js'))).toBe(false);
  });

  it('failed npm repair refuses job preparation instead of using the checkout copy', async () => {
    const f = await jobFixture();
    const { cwd } = f.prepareCode();
    put(f.dependencyDir(cwd), 'node_modules/pkg/index.js', 'tampered');
    io.exec.mockImplementation(() => { throw new Error('npm unavailable'); });
    expect(() => f.prepareCode()).toThrow();
    expect(io.exec.mock.calls.filter(([cmd]) => cmd === 'cp')).toHaveLength(0);
  });

  it('a repaired dependency tree still changing during verification refuses preparation after one repair', async () => {
    const f = await jobFixture();
    const { cwd } = f.prepareCode();
    put(f.dependencyDir(cwd), 'node_modules/pkg/index.js', 'tampered');
    io.unstableDependency = true;
    expect(() => f.prepareCode()).toThrow();
    expect(io.exec.mock.calls.filter(([cmd]) => cmd === 'npm')).toHaveLength(2);
    expect(io.exec.mock.calls.filter(([cmd]) => cmd === 'cp')).toHaveLength(0);
  });
});
