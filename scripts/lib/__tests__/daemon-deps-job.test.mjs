/**
 * @file scripts/lib/__tests__/daemon-deps-job.test.mjs
 * @description x0m7a8x (card 5691) — a daemon clone's `npm ci` runs as a detached install job and the new
 *   `node_modules` is swapped in at a pass boundary; the loop side never installs. Real temp dirs and a real job
 *   store; the runtime's reattach pass and the installer are injected (no npm, no detached child).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  refreshDepsAsJob, resolveDepsAsJob, installStep, swapNodeModules, depsStore, runDepsJob,
  DEPS_JOB_KIND, DEPS_JOB_KINDS, DEPS_AS_JOB_ENV, DEPS_JOB_NPM_ARGS, depsJobInstaller,
} from '../daemon-rebuild/deps-job.mjs';
import {
  createJobStore, enqueueJob, JOB_ID_ENV, JOB_ATTEMPT_ENV,
} from '../daemon-jobs-runtime.mjs';
import { defineJobKind, markFailed, markLaunching } from '../daemon-jobs.mjs';
import { lockfileKey } from '../daemon-job-snapshots.mjs';

const tmp = [];
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) rmSync(tmp.pop(), { recursive: true, force: true }); });

const SHA = 'a'.repeat(40);
function fixture({ lock = '{"lockfileVersion":3,"v":2}' } = {}) {
  const root = mk('deps-root-');
  writeFileSync(join(root, 'package-lock.json'), lock);
  writeFileSync(join(root, 'package.json'), '{"name":"x"}');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'old.txt'), 'old');
  const jobs = mk('deps-jobs-');
  let installedKey = lockfileKey('{"lockfileVersion":3,"v":1}');
  const installed = { read: () => installedKey, write: vi.fn((k) => { installedKey = k; }) };
  const store = createJobStore(jobs);
  return { root, jobs, store, installed, key: lockfileKey(lock), lock };
}
const noReattach = vi.fn(async () => ({ actions: [] }));

describe('settings — env beats file beats built-in, and the source is named', () => {
  it('built-in default is on', () => {
    expect(resolveDepsAsJob({ env: {}, path: '/nonexistent.json' })).toMatchObject({ enabled: true, source: 'built-in' });
  });
  it('the committed file turns it on', () => {
    expect(resolveDepsAsJob({ env: {} })).toMatchObject({ enabled: true, source: 'file' });
  });
  it('env forces it off (rollback to the inline npm ci)', () => {
    expect(resolveDepsAsJob({ env: { [DEPS_AS_JOB_ENV]: '0' } })).toMatchObject({ enabled: false, source: 'env' });
  });
});

describe('refreshDepsAsJob — the loop side never installs', () => {
  it('up-to-date when the live node_modules was installed for this lockfile', async () => {
    const f = fixture();
    f.installed.write(f.key);
    const swap = vi.fn();
    expect(await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA })).toMatchObject({ reason: 'up-to-date' });
    expect(swap).not.toHaveBeenCalled();
  });

  it('a changed lockfile queues ONE install job and returns at once; the live node_modules is untouched', async () => {
    const f = fixture();
    const swap = vi.fn();
    const r = await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA });
    expect(r).toMatchObject({ reason: 'deps-job-started', key: f.key });
    expect(swap).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'node_modules', 'old.txt'))).toBe(true);
    const recs = f.store.list().records;
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ input: { key: f.key }, job: { kind: DEPS_JOB_KIND.kind, status: 'queued' } });
    // a second call while it is queued/running does not queue another
    expect(await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, swap, codeSha: SHA })).toMatchObject({ reason: 'deps-job-running' });
    expect(f.store.list().records).toHaveLength(1);
  });

  it('once the job built the store, the next call (a pass boundary) swaps it in and records the key', async () => {
    const f = fixture();
    const st = depsStore(f.jobs, f.key);
    mkdirSync(join(st.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(st.dir, 'node_modules', 'new.txt'), 'new');
    writeFileSync(join(st.dir, '.snapshot-complete'), 'x');
    const r = await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, codeSha: SHA });
    expect(r).toMatchObject({ reason: 'swapped', key: f.key });
    expect(f.installed.write).toHaveBeenCalledWith(f.key);
    expect(existsSync(join(f.root, 'node_modules', 'new.txt'))).toBe(true);
    expect(existsSync(join(f.root, 'node_modules', 'old.txt'))).toBe(false);
    expect(readdirSync(f.root).filter((n) => n.startsWith('.node_modules'))).toEqual([]);
  });

  it('a failed install is retried at most once per retryMs (never back to back)', async () => {
    const f = fixture();
    let t = 1_000_000;
    const opts = { root: f.root, installed: f.installed, store: f.store, reattach: noReattach, codeSha: SHA, now: () => t, retryMs: 300_000 };
    const first = await refreshDepsAsJob(opts);
    f.store.update(first.job.id, (r) => markFailed(r, { at: new Date(t).toISOString(), reason: 'npm ci exited 1' }));
    t += 60_000;
    expect(await refreshDepsAsJob(opts)).toMatchObject({ reason: 'deps-job-spaced' });
    t += 300_000;
    expect(await refreshDepsAsJob(opts)).toMatchObject({ reason: 'deps-job-started' });
  });

  it('a swap failure leaves the live node_modules and the installed key unchanged', async () => {
    const f = fixture();
    const st = depsStore(f.jobs, f.key);
    mkdirSync(join(st.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(st.dir, '.snapshot-complete'), 'x');
    const r = await refreshDepsAsJob({ root: f.root, installed: f.installed, store: f.store, reattach: noReattach, codeSha: SHA, swap: () => { throw new Error('EXDEV'); } });
    expect(r.reason).toBe('swap-failed');
    expect(f.installed.write).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, 'node_modules', 'old.txt'))).toBe(true);
  });
});

describe('job child — npm never runs lifecycle scripts (the daemon holds the operator\'s credentials)', () => {
  it('the declared argv carries --ignore-scripts', () => {
    expect(DEPS_JOB_NPM_ARGS[0]).toBe('ci');
    expect(DEPS_JOB_NPM_ARGS).toContain('--ignore-scripts');
    expect(Object.isFrozen(DEPS_JOB_NPM_ARGS)).toBe(true);
  });
  it('the installer the job uses by default runs exactly that argv, in the store dir', () => {
    const exec = vi.fn();
    depsJobInstaller({ exec })('/tmp/store-x');
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('npm');
    expect(args).toEqual([...DEPS_JOB_NPM_ARGS]);
    expect(opts.cwd).toBe('/tmp/store-x');
  });
});

describe('job child — installStep', () => {
  it('builds the lockfile-keyed store with the installer, once', () => {
    const f = fixture();
    const install = vi.fn((into) => { mkdirSync(join(into, 'node_modules')); writeFileSync(join(into, 'node_modules', 'pkg.txt'), 'p'); });
    const r = installStep({ jobsDir: f.jobs, sourceDir: f.root, expectKey: f.key, install });
    expect(r.key).toBe(f.key);
    expect(depsStore(f.jobs, f.key).complete).toBe(true);
    installStep({ jobsDir: f.jobs, sourceDir: f.root, expectKey: f.key, install });
    expect(install).toHaveBeenCalledTimes(1);
  });
  it('refuses when the pinned commit\'s lockfile is not the one requested', () => {
    const f = fixture();
    expect(() => installStep({ jobsDir: f.jobs, sourceDir: f.root, expectKey: 'deadbeefdeadbeef', install: vi.fn() })).toThrow(/not the requested/);
  });
});

describe('job child — the kind and the entry the runtime spawns', () => {
  it('DEPS_JOB_KIND is a valid kind, registered, pointing at this file, and needs no node_modules of its own', () => {
    expect(defineJobKind({ ...DEPS_JOB_KIND })).toEqual(DEPS_JOB_KIND);
    expect(DEPS_JOB_KINDS.get(DEPS_JOB_KIND.kind)).toBe(DEPS_JOB_KIND);
    expect(DEPS_JOB_KIND).toMatchObject({
      entry: 'scripts/lib/daemon-rebuild/deps-job.mjs', codeMode: 'readonly-tree', serial: true, nodeModules: false,
    });
    expect(existsSync(join(process.cwd(), DEPS_JOB_KIND.entry))).toBe(true);
  });

  it('runDepsJob claims a launching job from OPERATION_RUNS_DIR, builds the store from its cwd lockfile, and succeeds', async () => {
    const f = fixture();
    const queued = enqueueJob({ store: f.store, kindDef: DEPS_JOB_KIND, codeSha: SHA, input: { key: f.key } });
    f.store.update(queued.id, (r) => markLaunching(r, { at: new Date().toISOString() }));
    const install = vi.fn((into) => { mkdirSync(join(into, 'node_modules')); writeFileSync(join(into, 'node_modules', 'pkg.txt'), 'p'); });
    const out = await runDepsJob({
      env: { [JOB_ID_ENV]: queued.id, [JOB_ATTEMPT_ENV]: '1', OPERATION_RUNS_DIR: f.jobs }, cwd: f.root, install, write: () => {},
    });
    expect(out).toEqual({ outcome: 'succeeded' });
    expect(install).toHaveBeenCalledTimes(1);
    expect(depsStore(f.jobs, f.key).complete).toBe(true);
    expect(f.store.read(queued.id).job.status).toBe('succeeded');
  });

  it('runDepsJob refuses without the runtime env (never installs)', async () => {
    const install = vi.fn();
    expect(await runDepsJob({ env: {}, cwd: mk('deps-cwd-'), install, write: () => {} })).toMatchObject({ outcome: 'refused', code: 'no-job-env' });
    expect(install).not.toHaveBeenCalled();
  });
});

describe('swapNodeModules', () => {
  it('replaces the live directory with a copy of the store and leaves no temp dirs', () => {
    const clone = mk('swap-root-');
    mkdirSync(join(clone, 'node_modules'));
    writeFileSync(join(clone, 'node_modules', 'old.txt'), 'old');
    const store = mk('swap-store-');
    mkdirSync(join(store, 'node_modules'));
    writeFileSync(join(store, 'node_modules', 'new.txt'), 'new');
    swapNodeModules({ root: clone, storeDir: store });
    expect(readdirSync(join(clone, 'node_modules'))).toEqual(['new.txt']);
    expect(readdirSync(clone)).toEqual(['node_modules']);
    expect(existsSync(join(store, 'node_modules', 'new.txt'))).toBe(true); // the store is kept
  });

  const swapFixture = () => {
    const clone = mk('swap-root-');
    mkdirSync(join(clone, 'node_modules'));
    writeFileSync(join(clone, 'node_modules', 'old.txt'), 'old');
    const store = mk('swap-store-');
    mkdirSync(join(store, 'node_modules'));
    writeFileSync(join(store, 'node_modules', 'new.txt'), 'new');
    return { clone, store };
  };

  it('the copy cannot be renamed in AFTER the live tree moved aside: the old tree is renamed back (liveIntact)', () => {
    const { clone, store } = swapFixture();
    let calls = 0;
    const rename = (a, b) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('EPERM: rename'), { code: 'EPERM' });
      renameSync(a, b);
    };
    let err;
    try { swapNodeModules({ root: clone, storeDir: store, rename }); } catch (e) { err = e; }
    expect(err?.liveIntact).toBe(true);
    expect(readdirSync(join(clone, 'node_modules'))).toEqual(['old.txt']);
    expect(readdirSync(clone)).toEqual(['node_modules']);
  });

  it('when the rollback fails too the error says so, and the caller\'s log never claims an unchanged tree', async () => {
    const f = fixture();
    const st = depsStore(f.jobs, f.key);
    mkdirSync(join(st.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(st.dir, '.snapshot-complete'), 'x');
    let calls = 0;
    const rename = (a, b) => { calls += 1; if (calls >= 2) throw new Error('ENOSPC'); renameSync(a, b); };
    const log = vi.fn();
    const r = await refreshDepsAsJob({
      root: f.root, installed: f.installed, store: f.store, reattach: noReattach, codeSha: SHA, log,
      swap: (o) => swapNodeModules({ ...o, rename }),
    });
    expect(r).toMatchObject({ reason: 'swap-failed', liveIntact: false });
    expect(f.installed.write).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([m]) => /could NOT be restored/.test(m))).toBe(true);
    expect(log.mock.calls.some(([m]) => /is unchanged/.test(m))).toBe(false);
  });

  it('leftover swap/old dirs from a crashed earlier process (another pid) are removed', () => {
    const { clone, store } = swapFixture();
    mkdirSync(join(clone, '.node_modules.old.99999'));
    mkdirSync(join(clone, '.node_modules.swap.88888'));
    swapNodeModules({ root: clone, storeDir: store });
    expect(readdirSync(clone)).toEqual(['node_modules']);
  });

  it('a crash between the renames (no live node_modules) is healed by the next swap', () => {
    const { clone, store } = swapFixture();
    renameSync(join(clone, 'node_modules'), join(clone, '.node_modules.old.77777'));
    swapNodeModules({ root: clone, storeDir: store });
    expect(readdirSync(join(clone, 'node_modules'))).toEqual(['new.txt']);
    expect(readdirSync(clone)).toEqual(['node_modules']);
  });
});
