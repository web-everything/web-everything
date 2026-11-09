/** Audit 2: real snapshot/watch state; only process and planner boundaries are injected. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const io = vi.hoisted(() => {
  vi.resetModules();
  return { exec: vi.fn() };
});
vi.mock('node:child_process', async original => ({
  ...await original(), execFileSync: (...args) => io.exec(...args),
}));

import { rebuildClone } from '../daemon-rebuild.mjs';
import * as snapshots from '../daemon-job-snapshots.mjs';
import * as jobs from '../daemon-rebuild/rebuild-job.mjs';
import * as origin from '../daemon-self-sync.mjs';
import * as watches from '../daemon-force-adopt.mjs';
import * as overlays from '../overlay-adoption.mjs';
import * as prepare from '../daemon-rebuild/prepare.mjs';
import { writeReadyCandidate } from '../daemon-rebuild/state.mjs';
import { writeRebuildStarvation } from '../daemon-rebuild/lease.mjs';

const ensureCode = snapshots.ensureCodeSnapshot;
const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const BEFORE = 'c'.repeat(40);
const CLI = 'scripts/lib/daemon-rebuild.mjs';
const MANIFEST = JSON.stringify({ name: 'audit2', dependencies: { pkg: '1.0.0' } });
const LOCK = JSON.stringify({ name: 'audit2', lockfileVersion: 3, packages: {
  '': { dependencies: { pkg: '1.0.0' } }, 'node_modules/pkg': { version: '1.0.0' },
} });
const IDLE = { moved: false, reason: 'needs-build', alerts: [] };
const quiet = { error() {}, warn() {}, log() {} };
const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
let base;
beforeEach(() => {
  base = mkdtempSync(join(process.env.TMPDIR, 'adopter-audit2-'));
  io.exec.mockReset();
  io.exec.mockImplementation((command, argv, options) => {
    if (command !== 'npm' || argv[0] !== 'ci') {
      throw new Error(`Unexpected process: ${command} ${argv.join(' ')}`);
    }
    expect(readFileSync(join(options.cwd, 'package-lock.json'), 'utf8')).toBe(LOCK);
    put(options.cwd, 'node_modules/pkg/index.js', 'verified dependency\n');
    return '';
  });
  vi.spyOn(origin, 'readOriginRefSha').mockReturnValue(MAIN);
  vi.spyOn(overlays, 'checkPendingAdoptions').mockResolvedValue([]);
  vi.spyOn(watches, 'runForceWatchTick').mockResolvedValue({});
  vi.spyOn(jobs, 'rebuildCloneAsJob').mockImplementation(({ adopt }) => adopt());
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function fixture({ lock = true } = {}) {
  const root = join(base, 'checkout');
  const env = {
    WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_JOBS_ROOT: join(base, 'jobs'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(base, 'locks'), WE_DAEMON_AUTO_REBASE: '0',
  };
  put(root, '.git/HEAD', HEAD);
  const materialize = vi.fn(into => {
    put(into, CLI, '// pinned CLI\n');
    put(into, 'package.json', MANIFEST);
    if (lock) put(into, 'package-lock.json', LOCK);
  });
  vi.spyOn(snapshots, 'ensureCodeSnapshot').mockImplementation(options =>
    ensureCode({ ...options, materialize }));
  const jobsDir = jobs.rebuildJobsDir(root, env);
  const code = () => snapshots.ensureCodeSnapshot({ jobsDir, codeSha: MAIN, repoDir: root });
  expect(writeReadyCandidate(root, {
    prevHead: HEAD, adopt: { finalSha: MAIN }, smoke: { verdict: 'pass' },
  }, env)).toBe(true);
  const child = vi.fn(async () => ({ status: 0, stdout: JSON.stringify(IDLE) }));
  const run = vi.fn(argv => {
    if (argv[0] === 'rev-parse') return { status: 0, stdout: HEAD };
    throw new Error(`Unexpected git: ${argv.join(' ')}`);
  });
  const tick = (options = {}) => rebuildClone({ root, env, asJob: true,
    adoptChild: { run: child }, run, log: quiet, emitEvent: vi.fn(), ...options });
  return { root, env, jobsDir, code, child, run, tick };
}

describe('force-watch ownership across the adopt child boundary', () => {
  it('one daemon tick decrements a five-tick watch exactly once across child and parent', async () => {
    const f = fixture();
    watches.runForceWatchTick.mockRestore();
    const watchTick = vi.spyOn(watches, 'runForceWatchTick');
    watches.transitionWatch(f.root, f.env, () => ({ next: {
      daemon: 'audit2', ruling: 'R508', sha: HEAD, lastGood: { head: BEFORE },
      ticksLeft: 5, startedAt: new Date(Date.now() - 60_000).toISOString(), adoptedSeen: true,
    } }));
    expect(watches.readForceWatch(f.root, f.env).ticksLeft).toBe(5);
    vi.spyOn(prepare, 'prepareRebuild').mockResolvedValue({ terminal: true, result: IDLE, alerts: [] });
    const probe = vi.fn(async () => ({ healthy: true, restarts: 0 }));
    f.child.mockImplementation(async (_executable, argv, options) => {
      expect(argv).toContain('--adopt-only');
      // Exercise the same rebuildClone wrapper the CLI invokes, without a host child.
      const result = await rebuildClone({ root: f.root, env: options.env, asJob: false,
        adoptOnly: true, versions: null, skipCheck: null, lockOpts: { waitMs: 0 },
        run: f.run, forceWatchProbe: probe, log: quiet, emitEvent: vi.fn() });
      return { status: 0, stdout: JSON.stringify(result) };
    });
    expect(await f.tick({ forceWatchProbe: probe })).toMatchObject(IDLE);
    expect(f.child).toHaveBeenCalledTimes(1);
    expect.soft(watchTick).toHaveBeenCalledTimes(1);
    expect.soft(probe).toHaveBeenCalledTimes(1);
    expect(watches.readForceWatch(f.root, f.env).ticksLeft).toBe(4);
  });
});

describe('linkNodeModules refuses unverified existing resolution', () => {
  it.each([false, true])('a correct verified link remains usable (replace=%s)', replace => {
    const f = fixture();
    const dir = f.code();
    const store = snapshots.ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: dir, adopter: true });
    symlinkSync(join(store.dir, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const link = snapshots.linkNodeModules(dir, store.dir, { replace });
    expect(realpathSync(link)).toBe(realpathSync(join(store.dir, 'node_modules')));
  });

  it.each(['foreign-link', 'real-directory'])('%s is replaced by the verified link or refused', kind => {
    const f = fixture();
    const dir = f.code();
    const store = snapshots.ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: dir, adopter: true });
    const link = join(dir, 'node_modules');
    if (kind === 'foreign-link') {
      put(base, 'unverified/pkg/index.js', 'unverified dependency\n');
      symlinkSync(join(base, 'unverified'), link, 'dir');
    } else put(dir, 'node_modules/pkg/index.js', 'unverified dependency\n');
    // Refusal is permitted; returning success authorizes only the verified store.
    let refused = false;
    try { snapshots.linkNodeModules(dir, store.dir); } catch { refused = true; }
    if (!refused) {
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(store.dir, 'node_modules')));
    }
  });

  it.each(['foreign-link', 'real-directory'])('adoption never executes through a %s with a lockfile', async kind => {
    const f = fixture();
    const dir = f.code();
    if (kind === 'foreign-link') {
      put(base, 'unverified/pkg/index.js', 'unverified dependency\n');
      symlinkSync(join(base, 'unverified'), join(dir, 'node_modules'), 'dir');
    } else put(dir, 'node_modules/pkg/index.js', 'unverified dependency\n');
    let observed;
    f.child.mockImplementation(async (_exe, _argv, options) => {
      const link = join(options.cwd, 'node_modules');
      observed = { linked: lstatSync(link).isSymbolicLink(), target: realpathSync(link),
        bytes: readFileSync(join(link, 'pkg/index.js'), 'utf8') };
      return { status: 0, stdout: JSON.stringify(IDLE) };
    });
    const result = await f.tick();
    if (!f.child.mock.calls.length) expect(result.reason).toBe('adopt-child-failed');
    else {
      const store = snapshots.ensureNodeModulesStore({ jobsDir: f.jobsDir, sourceDir: dir, adopter: true });
      expect(observed).toEqual({ linked: true, target: realpathSync(join(store.dir, 'node_modules')),
        bytes: 'verified dependency\n' });
    }
  });
});

describe('missing lockfile fails closed without explicit empty-dependency evidence', () => {
  it.each(['absent', 'foreign-link', 'real-directory'])('refuses adoption with node_modules %s', async kind => {
    const f = fixture({ lock: false });
    const dir = f.code();
    if (kind === 'foreign-link') {
      put(base, 'unverified/pkg/index.js', 'unverified dependency\n');
      symlinkSync(join(base, 'unverified'), join(dir, 'node_modules'), 'dir');
    } else if (kind === 'real-directory') put(dir, 'node_modules/pkg/index.js', 'unverified dependency\n');
    expect(existsSync(join(dir, 'package-lock.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies).toEqual({ pkg: '1.0.0' });
    const result = await f.tick();
    expect.soft(result).toMatchObject({ moved: false, reason: 'adopt-child-failed' });
    expect(f.child).not.toHaveBeenCalled();
  });
});

describe('adopt child timeout covers configured lock waits plus a positive margin', () => {
  it.each([
    ['default finalize wait', {}, undefined, 0, 180_000],
    ['configured rebuild wait', { WE_DAEMON_REBUILD_LOCK_WAIT_MS: '420000' }, undefined, 0, 420_000],
    ['configured finalize wait', { WE_DAEMON_FINALIZE_LOCK_WAIT_MS: '480000' }, undefined, 0, 480_000],
    ['explicit admission wait', {}, 540_000, 0, 540_000],
    ['short admission preserves finalize wait', {}, 1, 0, 180_000],
    ['default starvation wait', { WE_DAEMON_FINALIZE_LOCK_WAIT_MS: '1000' }, undefined, 2, 180_000],
    ['configured starvation wait', { WE_DAEMON_REBUILD_STARVED_WAIT_MS: '600000' }, undefined, 2, 600_000],
    ['120-second floor', { WE_DAEMON_REBUILD_LOCK_WAIT_MS: '1000', WE_DAEMON_FINALIZE_LOCK_WAIT_MS: '2000' }, undefined, 0, 2000],
  ])('%s', async (_name, env, admissionWaitMs, starved, longestWait) => {
    const f = fixture();
    Object.assign(f.env, env);
    if (starved) writeRebuildStarvation(f.root, starved, f.env);
    expect(await f.tick({ admissionWaitMs })).toMatchObject(IDLE);
    expect(f.child).toHaveBeenCalledTimes(1);
    const options = f.child.mock.calls[0][2];
    expect(options.killSignal).toBe('SIGKILL');
    expect.soft(Number.isFinite(options.timeout)).toBe(true);
    expect.soft(options.timeout).toBeGreaterThanOrEqual(120_000);
    // No specific margin is prescribed: any positive margin must outlast the wait.
    expect(options.timeout).toBeGreaterThan(longestWait);
  });
});
