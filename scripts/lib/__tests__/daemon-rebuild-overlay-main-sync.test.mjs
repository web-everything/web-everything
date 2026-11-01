import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { kickOverlayMainSync, runOverlayMainSync, selectSyncTargets, resolveOverlayMainSyncMode } from '../daemon-rebuild/overlay-main-sync.mjs';
import { addOverlay, readOverlayState, overlayFilePath, appendOverlayEvent } from '../daemon-overlays.mjs';
import { alertsFilePath } from '../daemon-rebuild/state.mjs';
import { readOverlayConflictWakes } from '../overlay-conflict-wake.mjs';
import { replay, sidecarsOf } from '../../operations/needs-you-feed.mjs';
import { probeOverlayMainSync } from '../../conveyor/health-watch.mjs';
import { allowedCommand } from '../../readiness/forge-exec-run.mjs';
import { runHeavyTests } from '../daemon-rebuild/auto-rebase.mjs';
import { scratchTestOutput } from '../../conveyor/soak/breaks/scratch-tests-forge-command.mjs';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal() }));

const remoteUnconfirmed = 'heavy-admission: remote failed (transport lost) - remote termination unconfirmed; refusing local rerun (exit 124). Confirm remote termination before retrying; remote slot-0 retained until its .unconfirmed marker is cleared.\n';

const temps = [], ref = 'lane/fix';
const temp = () => { const p = fs.mkdtempSync(join(tmpdir(), 'we-main-sync-test-')); temps.push(p); return p; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); temps.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
const run = (args, opts = {}) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args],
  { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts, env: { ...process.env, ...opts.env } });
const gitCommand = args => args[0] === '--attr-source=origin/main' ? args[1] : args[0];
const ok = (cwd, args) => { const r = run(args, { cwd }); if (r.status !== 0) throw new Error(`${args}: ${r.stderr}`); return r.stdout.trim(); };
const write = (root, file, text) => { fs.mkdirSync(dirname(join(root, file)), { recursive: true }); fs.writeFileSync(join(root, file), text); };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sidecar = f => `${overlayFilePath(f.root, f.env)}.main-sync.json`;
const marker = f => join(`${overlayFilePath(f.root, f.env)}.auto-rebase`, `${encodeURIComponent(ref)}.lock`);
const synced = f => f.events.filter(e => e.kind === 'overlay-main-synced');
const alerts = f => !fs.existsSync(alertsFilePath(f.root, f.env)) ? [] : fs.readFileSync(alertsFilePath(f.root, f.env), 'utf8').trim().split('\n').map(JSON.parse)
  .filter(e => e.kind.includes('needs-you'));

function fixture({ conflict = false, unrelated = false, count = 1, overlayTest = true, exhausted = false, deleteFinalTest = false, mainUnion = false } = {}) {
  const base = temp(), root = join(base, 'clone'), origin = join(base, 'origin.git');
  fs.mkdirSync(root); fs.mkdirSync(join(root, 'node_modules'));
  ok(root, ['init', '-q', '-b', 'main']);
  write(root, '.gitignore', 'node_modules/\n');
  const lines = Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i};`);
  write(root, 'worker.mjs', `${lines.join('\n')}\n`);
  write(root, 'unrelated.mjs', 'export default 0;\n');
  if (mainUnion) write(root, 'docs/agent/testing.md', '# Testing\n');
  for (let i = 0; i < count; i++) write(root, `worker${i}.test.mjs`, "import './worker.mjs';\n");
  if (deleteFinalTest) write(root, 'scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs',
    "import { it } from 'vitest';\nit('smoke', () => {});\n");
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'base']);
  const baseSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-qb', ref]);
  const branch = [...lines]; branch[0] = 'export const value0 = 100;';
  write(root, 'worker.mjs', `${branch.join('\n')}\n`);
  if (overlayTest) write(root, 'overlay.test.mjs', "import './worker.mjs';\n");
  if (deleteFinalTest) fs.unlinkSync(join(root, 'worker0.test.mjs'));
  if (mainUnion) fs.appendFileSync(join(root, 'docs/agent/testing.md'), 'Overlay testing notes\n');
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'overlay']);
  const oldSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-q', 'main']);
  const main = [...lines]; main[conflict ? 0 : 29] = `export const value${conflict ? 0 : 29} = 200;`;
  write(root, unrelated ? 'unrelated.mjs' : 'worker.mjs', unrelated ? 'export default 1;\n' : `${main.join('\n')}\n`);
  if (mainUnion) {
    fs.appendFileSync(join(root, 'docs/agent/testing.md'), 'Main testing notes\n');
    write(root, '.gitattributes', 'docs/agent/testing.md merge=union\n');
    ok(root, ['add', '.gitattributes']);
  }
  ok(root, ['commit', '-qam', 'main advanced']);
  const mainSha = ok(root, ['rev-parse', 'HEAD']);
  // Seed a local remote without network IO; both heads and their objects are real.
  ok(base, ['clone', '-q', '--bare', root, origin]);
  ok(root, ['remote', 'add', 'origin', origin]);
  ok(root, ['update-ref', 'refs/remotes/origin/main', mainSha]);
  ok(root, ['update-ref', `refs/remotes/origin/${ref}`, oldSha]);
  const env = { ...process.env, TMPDIR: base, WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'),
    WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_EVENTS: join(base, 'daemon-events.jsonl'),
    WE_NEEDS_YOU_FEED: join(base, 'needs-you-events.jsonl'), WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), WE_DAEMON_OVERLAY_MAIN_SYNC: 'on' };
  addOverlay(root, { ref, pr: 123 }, { env });
  if (exhausted) fs.writeFileSync(`${overlayFilePath(root, env)}.main-sync.json`, JSON.stringify({
    lastSyncedMain: {}, retryMain: { [ref]: mainSha }, retryTries: { [ref]: 3 }, retryAfter: { [ref]: 0 },
  }));
  const events = [], scratched = [], pushes = [];
  const deps = {
    io: { ...fs, mkdtempSync: prefix => { const p = fs.mkdtempSync(prefix); scratched.push(p); temps.push(p); return p; } },
    git: vi.fn((args, opts) => { if (args[0] === 'push') pushes.push([...args]); return run(args, opts); }),
    appendOverlayEvent: (root, event, opts) => { events.push(event); return appendOverlayEvent(root, event, opts); },
    testRunner: vi.fn(async ({ root: scratch, args, testReport }) => {
      expect(allowedCommand(args.slice(args.indexOf('--') + 1))).toBe(true);
      fs.writeFileSync(testReport, JSON.stringify({
        testResults: args.filter(a => /\.test\.mjs$/.test(a)).map(file => ({
          name: join(fs.realpathSync(scratch), file), assertionResults: [{ status: 'passed' }],
        })),
      }));
      return { status: 0, stdout: '', stderr: '' };
    }),
    now: () => new Date().toISOString(),
  };
  return { base, root, origin, env, baseSha, oldSha, mainSha, events, scratched, pushes, deps };
}
const job = f => runOverlayMainSync({ root: f.root, ref, env: f.env, deps: f.deps });
const tick = (f, extra = {}) => kickOverlayMainSync({ root: f.root, env: f.env, mode: 'on', git: f.deps.git, ...extra });
const spawner = () => vi.fn(() => ({ once: vi.fn(), unref: vi.fn() }));
// Diagnostic cases start with a persisted, continuously failing streak already due.
const ageFailure = f => {
  const state = fs.existsSync(sidecar(f)) ? json(sidecar(f)) : { lastSyncedMain: {} };
  state.firstFailureAt = { [ref]: Date.now() - 2 * 60 * 60_000 - 1 };
  fs.writeFileSync(sidecar(f), JSON.stringify(state));
};
const attempted = f => expect(json(sidecar(f)).attemptedMain[ref]).toBe(f.mainSha);
const unchanged = f => {
  expect(ok(f.root, ['rev-parse', 'HEAD'])).toBe(f.mainSha);
  expect(ok(f.root, ['status', '--porcelain'])).toBe('');
  expect(f.scratched.length).toBeGreaterThan(0);
  expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
};

describe('overlay main sync', () => {

  it('refuses a passing empty describe suite before publication', async () => {
    const f = fixture();
    f.deps.testRunner = options => runHeavyTests(options, { exec: async () => ({ status: 0,
      stdout: await scratchTestOutput(options.args.slice(8, -3).map(name => ({ type: 'suite', name, mode: 'run',
        result: { state: 'pass', duration: 0 }, tasks: [
          { type: 'suite', name: 'empty describe', mode: 'run', result: { state: 'pass', duration: 0 }, tasks: [] },
        ] })), { summary: options.args.includes('--reporter=basic') }), stderr: '' }) });
    await expect(job(f)).rejects.toThrow(/inventory/);
    expect(f.pushes).toEqual([]);
    expect(synced(f)).toEqual([]);
    expect(f.scratched.every(path => !fs.existsSync(path))).toBe(true);
  });

  it("runs tests through the daemon checkout's wrapper with --repo=scratch", async () => {
    const f = fixture(), passing = f.deps.testRunner;
    const scratchReal = join(f.base, 'scratch-real'), scratchAlias = join(f.base, 'scratch-alias');
    fs.mkdirSync(scratchReal);
    fs.symlinkSync(scratchReal, scratchAlias, 'dir');
    f.env.TMPDIR = scratchAlias;
    f.env.LANE_POOL_ROOT = join(f.base, 'must-not-inherit');
    f.deps.testRunner = vi.fn(async options => {
      expect(options.root).toBe(join(f.scratched[0], 'repo'));
      expect(options.root).not.toBe(fs.realpathSync(options.root));
      expect(options.args.slice(0, 8)).toEqual([join(f.root, 'scripts/readiness/heavy-admission.mjs'),
        'run', `--repo=${fs.realpathSync(options.root)}`, '--wait-ms=540000', '--', 'npx', 'vitest', 'run']);
      expect(options.env).not.toHaveProperty('LANE_POOL_ROOT');
      return passing(options);
    });
    const result = await job(f);
    expect(result.pushed).toBe(true);
    expect(f.deps.testRunner).toHaveBeenCalledOnce();
    expect(f.env.LANE_POOL_ROOT).toBe(join(f.base, 'must-not-inherit'));
  });

  it.each(['runner', 'process'])('exit 124 with remote-unconfirmed is a skip, not an operator-review alert (%s)', async mode => {
    const f = fixture(), outcomes = [];
    f.deps.appendDaemonEvent = event => { outcomes.push(event); };
    if (mode === 'runner') f.deps.testRunner = vi.fn(async () => ({ status: 124, stderr: remoteUnconfirmed }));
    else {
      delete f.deps.testRunner;
      fs.appendFileSync(join(f.root, '.git/info/exclude'), '\n/scripts/readiness/heavy-admission.mjs\n');
      write(f.root, 'scripts/readiness/heavy-admission.mjs', `
        import { realpathSync } from 'node:fs';
        if (process.env.LANE_POOL_ROOT || !process.argv.includes('--repo=' + realpathSync(process.cwd()))) process.exit(99);
        process.stderr.write(${JSON.stringify(remoteUnconfirmed)});
        process.exit(124);
      `);
    }
    expect(await job(f)).toEqual({ skipped: true, reason: 'remote-termination-unconfirmed' });
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    expect(alerts(f)).toEqual([]);
    expect(fs.existsSync(f.env.WE_NEEDS_YOU_FEED)).toBe(false);
    expect(outcomes.map(e => e.kind)).toEqual(['overlay-main-sync-skipped']);
    if (fs.existsSync(sidecar(f))) {
      const state = json(sidecar(f));
      for (const key of ['lastSyncedMain', 'attemptedMain', 'retryMain', 'retryTries', 'retryAfter', 'firstFailureAt'])
        expect(state[key]?.[ref]).toBeUndefined();
    }
    expect(fs.existsSync(marker(f))).toBe(false); unchanged(f);
    expect(tick(f, { spawnFn: spawner() }).started).toEqual([ref]);
  });

  it('remote-unconfirmed preserves an exhausted test retry budget and releases both locks for the next tick', async () => {
    const f = fixture({ exhausted: true }), before = json(sidecar(f));
    f.deps.testRunner = async () => ({ status: 124, stderr: remoteUnconfirmed });
    expect(await job(f)).toEqual({ skipped: true, reason: 'remote-termination-unconfirmed' });
    expect(json(sidecar(f))).toEqual(before);
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    expect(alerts(f)).toEqual([]);
    expect(fs.existsSync(f.env.WE_NEEDS_YOU_FEED)).toBe(false);
    expect(fs.existsSync(marker(f))).toBe(false);
    expect(fs.existsSync(`${sidecar(f)}.clone.lock`)).toBe(false);
    unchanged(f);
    expect(tick(f, { spawnFn: spawner() }).started).toEqual([ref]);
  });

  it.each([
    [124, 'remote termination unconfirmed'],
    [124, 'ordinary timeout'],
    [1, remoteUnconfirmed],
    [124, '', remoteUnconfirmed],
  ])('keeps test failure handling for other status/stderr combinations (%s, %s)', async (status, stderr, stdout = '') => {
    const f = fixture({ exhausted: true });
    f.deps.testRunner = async () => ({ status, stderr, stdout });
    await expect(job(f)).rejects.toThrow('operator review required');
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    attempted(f); unchanged(f);
  });

  it.each(['kick', 'worker'])('%s skips a stale registration without attention or failure memory, until one hour or registration changes', async entry => {
    const f = fixture(), git = f.deps.git, events = [], spawnFn = spawner();
    const started = 1_800_000_000_000, clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: {}, firstFailureAt: { [ref]: started - 3 * 60 * 60_000 },
      failureReason: { [ref]: 'previous failure' }, failureAlertedAt: { [ref]: started - 60_000 }, errorAt: { [ref]: started - 60_000 },
      attemptedMain: { [ref]: f.mainSha }, pushRetryMain: { [ref]: f.mainSha }, pushRetryAfter: { [ref]: started },
      retryMain: { [ref]: f.mainSha }, retryTries: { [ref]: 3 }, retryAfter: { [ref]: started + 30 * 60_000 } }));
    const missing = vi.fn((args, opts) => args[0] === 'fetch'
      ? { status: 128, stdout: '', stderr: `fatal: couldn't find remote ref refs/heads/${ref}\n` } : git(args, opts));
    f.deps.git = missing;
    f.deps.appendDaemonEvent = e => events.push(e);
    const invoke = () => entry === 'worker' ? job(f) : tick(f, { spawnFn, deps: f.deps });
    await invoke();
    expect(events).toEqual([{ kind: 'overlay-main-sync-skipped', detail: { ref, reason: 'stale-registration' } }]);
    expect(log).toHaveBeenCalledOnce();
    expect(json(sidecar(f)).staleRef[ref]).toBe(started);
    for (const key of ['firstFailureAt', 'failureAlertedAt', 'failureReason', 'errorAt', 'attemptedMain',
      'retryMain', 'retryTries', 'retryAfter', 'pushRetryMain', 'pushRetryAfter']) {
      expect(json(sidecar(f))[key][ref]).toBeUndefined();
    }
    expect(alerts(f)).toEqual([]); expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toEqual([]);
    missing.mockClear();
    clock.mockReturnValue(started + 60 * 60_000 - 1);
    await invoke();
    expect(missing).not.toHaveBeenCalled();
    expect(json(sidecar(f)).staleRef[ref]).toBe(started);
    clock.mockReturnValue(started + 60 * 60_000);
    await invoke();
    expect(missing.mock.calls.filter(([args]) => args[0] === 'fetch')).toHaveLength(1);
    expect(json(sidecar(f)).staleRef[ref]).toBe(Date.now());
    const registration = json(overlayFilePath(f.root, f.env));
    registration.overlays[0].addedAt = 'new-registration';
    fs.writeFileSync(overlayFilePath(f.root, f.env), JSON.stringify(registration));
    f.deps.git = git;
    expect(ok(f.root, ['rev-parse', 'origin/main'])).toBe(f.mainSha);
    if (entry === 'worker') expect(await invoke()).toMatchObject({ pushed: true });
    else expect(await invoke()).toMatchObject({ started: [ref] });
    expect(json(sidecar(f)).staleRef[ref]).toBeUndefined();
    expect(alerts(f)).toEqual([]); expect(f.pushes.length).toBe(entry === 'worker' ? 1 : 0);
    expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
  });

  it.each(['kick', 'worker'])('%s does not classify missing main or another ref as stale registration', async entry => {
    const f = fixture(), git = f.deps.git;
    f.deps.git = (args, opts) => args[0] === 'fetch'
      ? { status: 128, stdout: '', stderr: "fatal: couldn't find remote ref refs/heads/main\n" } : git(args, opts);
    if (entry === 'worker') await expect(job(f)).rejects.toMatchObject({ step: 'fetch' });
    else tick(f, { spawnFn: spawner() });
    expect(json(sidecar(f)).firstFailureAt[ref]).toBeTypeOf('number');
    expect(json(sidecar(f)).staleRef?.[ref]).toBeUndefined();
  });

  it.each([null, [], { [ref]: -1 }, { [ref]: 'yesterday' }, { [ref]: 123 }])('invalid stale state fails closed (%#)', async staleRef => {
    const f = fixture();
    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: {}, staleRef }));
    await expect(job(f)).rejects.toThrow(/state/);
    expect(f.deps.git).not.toHaveBeenCalled();
  });

  it('selects dependents of every own file and excludes main-only dependents', async () => {
    const f = fixture({ unrelated: true });
    // The real merge changes only unrelated.mjs on main; worker.mjs belongs to the overlay.
    const result = await job(f);
    expect(result.tests).toEqual(['overlay.test.mjs', 'worker0.test.mjs']);
  });

  it.each(['failed', 'missing', 'empty'])('later chunk %s evidence refuses push', async outcome => {
    const f = fixture({ count: 101 }), passing = f.deps.testRunner;
    let calls = 0;
    f.deps.testRunner = vi.fn(async options => {
      const result = await passing(options);
      if (++calls === 2) {
        if (outcome === 'failed') return { status: 1, stdout: '', stderr: 'chunk failed' };
        const path = options.testReport;
        const report = json(path);
        if (outcome === 'missing') report.testResults.pop();
        else report.testResults[0].assertionResults = [];
        fs.writeFileSync(path, JSON.stringify(report));
      }
      return result;
    });
    await expect(job(f)).rejects.toThrow(outcome === 'failed' ? /command failed/ : /did not pass or execute/);
    expect(calls).toBe(2); expect(f.pushes).toEqual([]);
  });

  it.each(['clone', 'fetch', 'checkout', 'merge', 'rev-parse'])('%s transient timeout retries three times, skips without penalty, and allows the next tick', async step => {
    const f = fixture(), git = f.deps.git, outcomes = [];
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.deps.appendDaemonEvent = e => { outcomes.push(e); };
    f.deps.gitBackoff = vi.fn();
    let tries = 0;
    f.deps.git = (args, opts) => gitCommand(args) === step
      ? (++tries, { status: null, stdout: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }) : git(args, opts);
    expect(await job(f)).toMatchObject({ skipped: true, reason: 'transient-git' });
    expect(tries).toBe(3); expect(f.deps.gitBackoff).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledOnce();
    expect(outcomes).toMatchObject([{ kind: 'overlay-main-sync-skipped', detail: { ref, reason: 'transient-git' } }]);
    expect(alerts(f)).toEqual([]);
    if (fs.existsSync(sidecar(f))) {
      const state = json(sidecar(f));
      for (const key of ['attemptedMain', 'retryMain', 'pushRetryMain', 'firstFailureAt']) expect(state[key]?.[ref]).toBeUndefined();
    }
    f.deps.git = git;
    expect(tick(f, { spawnFn: spawner() }).started).toEqual([ref]);
  });

  it.each([false, true])('checkout retry clears partial scratch state and syncs without touching root or symlink targets (index lock: %s)', async locked => {
    const f = fixture(), git = f.deps.git, rootIndex = fs.readFileSync(join(f.root, '.git', 'index'));
    const outside = join(f.base, 'outside');
    write(outside, 'keep.md', 'preserve outside scratch\n');
    f.deps.gitBackoff = vi.fn();
    f.deps.io.rmSync = vi.fn(fs.rmSync);
    f.deps.io.readdirSync = vi.fn(fs.readdirSync);
    let tries = 0, scratch, retryState;
    f.deps.git = vi.fn((args, opts) => {
      if (args[0] === 'checkout' && opts.cwd !== f.root) {
        scratch = opts.cwd;
        if (++tries === 1) {
          // Leave a real index plus untracked target files, as an interrupted checkout can.
          ok(scratch, ['read-tree', '--empty']);
          write(scratch, 'overlay.test.mjs', 'incomplete checkout\n');
          write(scratch, '.partial/nested.md', 'partial hidden directory\n');
          fs.symlinkSync(outside, join(scratch, 'outside-link'), 'dir');
          if (locked) write(scratch, '.git/index.lock', 'interrupted index write\n');
          return { status: null, stdout: '', stderr: '',
            error: Object.assign(new Error('checkout timed out'), { code: 'ETIMEDOUT' }) };
        }
        retryState = {
          entries: fs.readdirSync(scratch),
          index: fs.existsSync(join(scratch, '.git', 'index')),
          lock: fs.existsSync(join(scratch, '.git', 'index.lock')),
        };
      }
      return git(args, opts);
    });
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(tries).toBe(2);
    expect(retryState).toEqual({ entries: ['.git'], index: false, lock: false });
    expect(f.deps.gitBackoff).toHaveBeenCalledTimes(1);
    expect(f.deps.gitBackoff).toHaveBeenCalledWith(100);
    expect(f.deps.io.readdirSync).toHaveBeenCalledWith(scratch);
    for (const file of ['.git/index', '.git/index.lock']) {
      expect(f.deps.io.rmSync).toHaveBeenCalledWith(join(scratch, file), { force: true });
    }
    const checkouts = f.deps.git.mock.calls.filter(([args]) => args[0] === 'checkout');
    expect(checkouts).toHaveLength(2);
    for (const [args, opts] of checkouts) {
      expect(args).toEqual(['checkout', '--force', '-b', ref, `origin/${ref}`]);
      expect(opts).toMatchObject({ cwd: scratch, timeout: 300_000 });
    }
    expect(f.deps.git.mock.calls.filter(([args]) => args[0] !== 'checkout')
      .every(([, opts]) => opts.timeout === undefined)).toBe(true);
    expect(f.deps.git.mock.calls.some(([args]) => gitCommand(args) === 'merge')).toBe(true);
    expect(synced(f)).toHaveLength(1);
    expect(alerts(f)).toEqual([]);
    expect(fs.readFileSync(join(outside, 'keep.md'), 'utf8')).toBe('preserve outside scratch\n');
    expect(fs.readFileSync(join(f.root, '.git', 'index'))).toEqual(rootIndex);
    unchanged(f);
  });

  it('kick retries transient fetch and skips quietly without suppressing the next tick', () => {
    const f = fixture(), git = f.deps.git, outcomes = [], backoff = vi.fn(), spawnFn = spawner();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let tries = 0;
    const timeoutGit = (args, opts) => args[0] === 'fetch'
      ? (++tries, { status: 1, stdout: '', stderr: 'connection timed out' }) : git(args, opts);
    expect(tick(f, { spawnFn, git: timeoutGit, deps: { gitBackoff: backoff, appendDaemonEvent: e => outcomes.push(e) } }).started).toEqual([]);
    expect(tries).toBe(3); expect(backoff).toHaveBeenCalledTimes(2);
    expect(outcomes[0]).toMatchObject({ kind: 'overlay-main-sync-skipped', detail: { reason: 'transient-git' } });
    expect(log).toHaveBeenCalledOnce(); expect(alerts(f)).toEqual([]);
    expect(tick(f, { spawnFn }).started).toEqual([ref]);
  });

  it('transient retry can recover without skipping or alerting', async () => {
    const f = fixture(), git = f.deps.git;
    let tries = 0; f.deps.gitBackoff = vi.fn();
    f.deps.git = (args, opts) => args[0] === 'clone' && ++tries < 3
      ? { status: 1, stdout: '', stderr: 'ETIMEDOUT' } : git(args, opts);
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(tries).toBe(3); expect(alerts(f)).toEqual([]);
  });

  it('clone lock excludes a concurrent different ref and kick without running Git', async () => {
    const f = fixture(), passing = f.deps.testRunner, other = 'lane/other', outcomes = [];
    addOverlay(f.root, { ref: other }, { env: f.env });
    f.deps.appendDaemonEvent = e => outcomes.push(e);
    f.deps.testRunner = async options => {
      const git = vi.fn(), spawnFn = spawner();
      expect(await runOverlayMainSync({ root: f.root, ref: other, env: f.env, deps: { ...f.deps, git } }))
        .toMatchObject({ skipped: true, reason: 'clone-busy' });
      expect(tick(f, { git, spawnFn, deps: { appendDaemonEvent: e => outcomes.push(e) } }).started).toEqual([]);
      expect(git).not.toHaveBeenCalled(); expect(spawnFn).not.toHaveBeenCalled();
      return passing(options);
    };
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(outcomes.filter(e => e.detail.reason === 'clone-busy')).toHaveLength(3);
    expect(fs.existsSync(`${sidecar(f)}.clone.lock`)).toBe(false);
  });

  it.each(['synced', 'failed', 'busy'])('%s worker outcome emits exactly one line and one daemon event', async outcome => {
    const f = fixture(), events = [], log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.deps.appendDaemonEvent = e => events.push(e);
    if (outcome === 'failed') f.deps.testRunner = async () => ({ status: 1, stdout: '', stderr: 'broken tests' });
    if (outcome === 'busy') { fs.mkdirSync(dirname(marker(f)), { recursive: true }); fs.writeFileSync(marker(f), 'owner'); }
    await job(f).catch(() => {});
    expect(log).toHaveBeenCalledOnce(); expect(events).toHaveLength(1);
    expect(events[0].kind).toBe(`overlay-main-sync-${outcome === 'busy' ? 'skipped' : outcome}`);
  });

  it.each(['clone', 'fetch', 'checkout', 'merge-base', 'merge', 'tests', 'push'])('%s failure exposes the step and sanitized stderr tail in alerts, logs and daemon events', async step => {
    const f = fixture(), git = f.deps.git;
    ageFailure(f);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderr = 'discard-me'.repeat(100) + '\x00\x1b\r\nfinal diagnostic';
    if (step === 'tests') f.deps.testRunner = async () => ({ status: 1, stdout: '', stderr });
    else f.deps.git = (args, opts) => gitCommand(args) === step ? { status: 1, stdout: '', stderr } : git(args, opts);
    if (step === 'push') expect(await job(f)).toEqual({ pushed: false });
    else await expect(job(f)).rejects.toMatchObject({ step, stderrTail: expect.stringContaining('final diagnostic') });
    const failure = fs.readFileSync(f.env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    expect(failure).toMatchObject({ kind: 'overlay-main-sync-failed', detail: { ref, step, main: f.mainSha, stderrTail: expect.any(String) } });
    expect(failure.detail.stderrTail.length).toBeLessThanOrEqual(500);
    expect(failure.detail.stderrTail).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(failure.detail.stderrTail).toBe(stderr.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(-500));
    expect(alerts(f)[0].detail.reason).toContain(step);
    expect(log.mock.calls.flat().join('\n')).toContain(`step=${step}`);
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toContainEqual(expect.objectContaining({ kind: 'overlay-main-sync-needs-you', repo: 'web-everything', ref }));
  });

  it('invalid rev-parse evidence fails closed and names its step even without a main SHA', async () => {
    const f = fixture(), git = f.deps.git;
    ageFailure(f);
    f.deps.git = (args, opts) => args[0] === 'rev-parse' ? { status: 0, stdout: 'not-a-sha', stderr: '' } : git(args, opts);
    await expect(job(f)).rejects.toMatchObject({ step: 'rev-parse' });
    expect(alerts(f)[0].detail.reason).toBe('rev-parse: invalid Git SHA; operator review required');
    expect(f.pushes).toEqual([]); expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(f.env.WE_DAEMON_EVENTS, 'utf8'))).toMatchObject({
      kind: 'overlay-main-sync-failed', detail: { ref, step: 'rev-parse', main: null },
    });
  });

  it('a PR-less conflict aborts, publishes its top and files through the shared feed, and never retries', async () => {
    const f = fixture({ conflict: true });
    const state = json(overlayFilePath(f.root, f.env)); state.overlays[0].pr = null;
    fs.writeFileSync(overlayFilePath(f.root, f.env), JSON.stringify(state));
    await expect(job(f)).rejects.toThrow(/merge conflicts/);
    expect(f.deps.git.mock.calls.some(([args]) => args[0] === 'merge' && args[1] === '--abort')).toBe(true);
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toContainEqual(expect.objectContaining({
      kind: 'overlay-main-merge-conflict', repo: 'web-everything', pr: 0, ref, files: ['worker.mjs'],
      title: expect.stringContaining(ref),
    }));
    expect(readOverlayConflictWakes(f.env).size).toBe(0);
    attempted(f);
    expect(json(sidecar(f)).retryMain[ref]).toBeUndefined();
    expect(tick(f, { spawnFn: spawner() })).toMatchObject({ started: [], skipped: [ref] });
    expect(f.pushes).toEqual([]); unchanged(f);
  });

  it.each([
    [null, 'success'], [123, 'success'],
    [null, 'failed'], [123, 'failed'],
    [null, 'threw'], [123, 'threw'],
  ])('conflict notifications precede abort for PR %s even when abort %s', async (pr, outcome) => {
    const f = fixture({ conflict: true }), git = f.deps.git;
    const state = json(overlayFilePath(f.root, f.env)); state.overlays[0].pr = pr;
    fs.writeFileSync(overlayFilePath(f.root, f.env), JSON.stringify(state));
    let beforeAbort;
    f.deps.git = vi.fn((args, opts) => {
      if (args[0] !== 'merge' || args[1] !== '--abort') return git(args, opts);
      beforeAbort = {
        events: [...f.events],
        attention: replay({ path: f.env.WE_NEEDS_YOU_FEED }),
        wake: readOverlayConflictWakes(f.env).get(pr),
      };
      if (outcome === 'threw') throw new Error('abort unavailable');
      if (outcome === 'failed') return { status: 1, stdout: '', stderr: 'abort unavailable' };
      return git(args, opts);
    });
    await expect(job(f)).rejects.toThrow(outcome === 'success' ? /merge conflicts/ : /abort unavailable/);
    expect(beforeAbort?.events).toContainEqual(expect.objectContaining({
      kind: 'overlay-main-merge-conflict', ref, files: ['worker.mjs'],
    }));
    if (pr) expect(beforeAbort.wake).toMatchObject({ pr, ref, files: ['worker.mjs'], clone: f.root });
    else expect(beforeAbort.attention).toContainEqual(expect.objectContaining({
      kind: 'overlay-main-merge-conflict', repo: 'web-everything', pr: 0, ref, files: ['worker.mjs'],
    }));
    attempted(f);
    expect(json(sidecar(f)).retryMain[ref]).toBeUndefined();
    expect(f.pushes).toEqual([]); expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(fs.existsSync(marker(f))).toBe(false); unchanged(f);
  });

  it('non-conflict failures schedule exactly three retries at 10, 20 and 30 minutes then remember main', async () => {
    const f = fixture(), clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    f.deps.testRunner = vi.fn(async () => ({ status: 1, stdout: '', stderr: 'temporary failure' }));
    const spawnFn = spawner();
    for (const [index, delay] of [10, 20, 30].entries()) {
      await expect(job(f)).rejects.toThrow(/command failed/);
      const retry = json(sidecar(f));
      expect(retry.attemptedMain[ref]).toBeUndefined();
      expect(retry.retryMain[ref]).toBe(f.mainSha);
      expect(retry.retryTries[ref]).toBe(index + 1);
      expect(retry.retryAfter[ref]).toBe(Date.now() + delay * 60_000);
      expect(tick(f, { spawnFn }).started).toEqual([]);
      clock.mockReturnValue(retry.retryAfter[ref] - 1);
      expect(tick(f, { spawnFn }).started).toEqual([]);
      clock.mockReturnValue(retry.retryAfter[ref]);
      expect(tick(f, { spawnFn }).started).toEqual([ref]);
      fs.unlinkSync(marker(f));
    }
    await expect(job(f)).rejects.toThrow(/command failed/);
    attempted(f);
    expect(f.deps.testRunner).toHaveBeenCalledTimes(4);
    expect(spawnFn).toHaveBeenCalledTimes(3);
    expect(tick(f, { spawnFn }).started).toEqual([]);
    expect(alerts(f)).toHaveLength(0); // Exhaustion at one hour does not bypass the delay.
    clock.mockReturnValue(Date.now() + 60 * 60_000 + 1);
    expect(tick(f, { spawnFn }).started).toEqual([]);
    expect(alerts(f)).toHaveLength(1);
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toHaveLength(1); // shared publisher deduplicates
    expect(json(sidecarsOf(f.env.WE_NEEDS_YOU_FEED).state).openKeys).toHaveLength(1);
  });

  it('retry exhaustion still raises exactly one delayed alert on unchanged-main ticks after two hours', async () => {
    const f = fixture(), started = 1_800_000_000_000, spawnFn = spawner(), outcomes = [];
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    f.deps.testRunner = vi.fn(async () => ({ status: 1, stdout: '', stderr: 'persistent worker failure' }));
    for (const minutes of [0, 10, 30, 60]) {
      clock.mockReturnValue(started + minutes * 60_000);
      await expect(job(f)).rejects.toThrow(/persistent worker failure/);
    }
    attempted(f);
    expect(alerts(f)).toHaveLength(0);
    for (const [elapsed, count] of [[120 * 60_000, 0], [120 * 60_000 + 1, 1], [240 * 60_000, 1]]) {
      clock.mockReturnValue(started + elapsed);
      expect(tick(f, { spawnFn, deps: { appendDaemonEvent: e => outcomes.push(e) } }))
        .toMatchObject({ started: [], skipped: [ref] });
      expect(alerts(f)).toHaveLength(count);
    }
    expect(alerts(f)[0].detail.reason).toContain('persistent worker failure');
    expect(json(sidecar(f)).firstFailureAt[ref]).toBe(started);
    expect(json(sidecar(f)).retryMain[ref]).toBeUndefined();
    expect(outcomes.map(e => e.kind)).toEqual(Array(3).fill('overlay-main-sync-skipped'));
    expect(spawnFn).not.toHaveBeenCalled();
    expect(f.deps.testRunner).toHaveBeenCalledTimes(4);
    expect(f.pushes).toEqual([]);
  });

  it('main moving bypasses an old cooldown and resets the retry count; success clears retry maps', async () => {
    const f = fixture(), git = f.deps.git;
    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: {}, retryMain: { [ref]: f.baseSha },
      retryTries: { [ref]: 3 }, retryAfter: { [ref]: Date.now() + 60 * 60_000 } }));
    const spawnFn = spawner();
    expect(tick(f, { spawnFn }).started).toEqual([ref]); fs.unlinkSync(marker(f));
    f.deps.git = (args, opts) => args[0] === 'clone' ? { status: 1, stdout: '', stderr: 'temporary' } : git(args, opts);
    await expect(job(f)).rejects.toThrow();
    expect(json(sidecar(f)).retryTries[ref]).toBe(1);
    expect(json(sidecar(f)).retryMain[ref]).toBe(f.mainSha);
    f.deps.git = git;
    expect(await job(f)).toMatchObject({ pushed: true });
    for (const key of ['retryMain', 'retryTries', 'retryAfter']) expect(json(sidecar(f))[key][ref]).toBeUndefined();
  });

  it.each([
    { retryMain: null }, { retryMain: { [ref]: 'bad-sha' } }, { retryTries: [] },
    { retryTries: { [ref]: -1 } }, { retryTries: { [ref]: 4 } }, { retryTries: { [ref]: 1.5 } },
    { retryAfter: { [ref]: 'tomorrow' } }, { retryAfter: { [ref]: -1 } },
    { retryMain: { [ref]: 'a'.repeat(40) } },
    { retryTries: { [ref]: 1 }, retryAfter: { [ref]: 0 } },
  ])('invalid or incomplete retry state fails closed (%#)', async extra => {
    const f = fixture(), spawnFn = spawner();
    const raw = JSON.stringify({ lastSyncedMain: {}, ...extra }); fs.writeFileSync(sidecar(f), raw);
    const started = 1_800_000_000_000, clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    expect(tick(f, { spawnFn }).started).toEqual([]);
    expect(alerts(f)).toEqual([]);
    clock.mockReturnValue(started + 2 * 60 * 60_000 + 1);
    await expect(job(f)).rejects.toThrow(/state/);
    expect(spawnFn).not.toHaveBeenCalled(); expect(f.deps.git).not.toHaveBeenCalled();
    expect(fs.readFileSync(sidecar(f), 'utf8')).toBe(raw);
    expect(alerts(f)).toHaveLength(1);
  });

  it.each(['append', 'rotate', 'spawn-error', 'open-failure'])('worker log handles %s and closes the parent descriptor', outcome => {
    const f = fixture(), file = `${overlayFilePath(f.root, f.env)}.main-sync.log`;
    const before = outcome === 'rotate' ? 'x'.repeat(1024 * 1024 + 1) : 'previous log\n';
    fs.writeFileSync(file, before); fs.writeFileSync(`${file}.1`, 'older');
    if (outcome === 'open-failure') { fs.unlinkSync(file); fs.mkdirSync(file); }
    let fd, logClosed = false;
    const close = fs.closeSync;
    vi.spyOn(fs, 'closeSync').mockImplementation(value => {
      close(value);
      if (value === fd && !logClosed) {
        // Record the successful real close: another open can reuse this number
        // before a later fstatSync, especially during spawn-error reporting.
        logClosed = true;
      }
    });
    const spawnFn = vi.fn((bin, args, options) => {
      if (outcome === 'open-failure') expect(options.stdio).toBe('ignore');
      else {
        expect(options.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
        fd = options.stdio[1]; expect(options.stdio[2]).toBe(fd);
        fs.writeSync(fd, 'child log\n');
      }
      if (outcome === 'spawn-error') throw new Error('spawn unavailable');
      return { once: vi.fn(), unref: vi.fn() };
    });
    expect(tick(f, { spawnFn }).started).toEqual(outcome === 'spawn-error' ? [] : [ref]);
    expect(logClosed).toBe(outcome !== 'open-failure');
    if (outcome === 'rotate') {
      expect(fs.readFileSync(`${file}.1`, 'utf8')).toBe(before);
      expect(fs.readFileSync(file, 'utf8')).toBe('child log\n');
    } else if (outcome !== 'open-failure') expect(fs.readFileSync(file, 'utf8')).toBe(before + 'child log\n');
  });

  it.each(['mkdirSync', 'appendFileSync'])('spawn error releases its lock when needs-you %s fails in both alert paths', method => {
    const f = fixture(), child = { once: vi.fn(), unref: vi.fn() };
    expect(tick(f, { spawnFn: () => child }).started).toEqual([ref]);
    ageFailure(f);
    const file = alertsFilePath(f.root, f.env), original = fs[method];
    const target = method === 'mkdirSync' ? dirname(file) : file;
    const failedWrite = vi.fn(() => { throw new Error('local alert unavailable'); });
    vi.spyOn(fs, method).mockImplementation((path, ...args) => path === target
      ? failedWrite() : original(path, ...args));
    const onError = child.once.mock.calls.find(([name]) => name === 'error')[1];
    expect(() => onError(new Error('spawn unavailable'))).not.toThrow();
    expect(failedWrite).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(marker(f))).toBe(false);
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toContainEqual(expect.objectContaining({
      kind: 'overlay-main-sync-needs-you', ref, reason: 'spawn unavailable',
    }));
  });

  it.each(['mkdirSync', 'appendFileSync'])('alert-write fallback preserves firstFailureAt and the original two-hour deadline when %s fails', method => {
    const f = fixture(), started = 1_800_000_000_000, delay = 2 * 60 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    const spawnFn = vi.fn(() => { throw new Error('spawn unavailable'); });
    tick(f, { spawnFn });
    expect(json(sidecar(f)).firstFailureAt[ref]).toBe(started);
    clock.mockReturnValue(started + delay);
    tick(f, { spawnFn });
    expect(alerts(f)).toEqual([]);

    const file = alertsFilePath(f.root, f.env), original = fs[method];
    const target = method === 'mkdirSync' ? dirname(file) : file;
    const failedWrite = vi.fn(() => { throw new Error('local alert unavailable'); });
    const publication = vi.spyOn(fs, method).mockImplementation((path, ...args) => path === target
      ? failedWrite() : original(path, ...args));
    clock.mockReturnValue(started + delay + 1);
    tick(f, { spawnFn });
    expect(failedWrite).toHaveBeenCalledTimes(2);
    expect(alerts(f)).toEqual([]);
    const directory = `${file}.main-sync`;
    const entries = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
    expect(entries).toHaveLength(1);
    const diagnostic = join(directory, entries[0]);
    expect(json(diagnostic).firstFailureAt[ref]).toBe(started);
    expect(json(diagnostic).failureAlertedAt?.[ref]).toBeUndefined();

    publication.mockRestore();
    // Force recovery through the independent marker, with the original deadline
    // only just elapsed, rather than waiting two hours from the failed write.
    fs.writeFileSync(sidecar(f), '{broken');
    f.deps.git.mockClear();
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(1);
    expect(json(diagnostic).firstFailureAt[ref]).toBe(started);
    expect(json(diagnostic).failureAlertedAt[ref]).toBe(started + delay + 1);
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(1);
    expect(fs.readFileSync(sidecar(f), 'utf8')).toBe('{broken');
    expect(f.deps.git).not.toHaveBeenCalled();
    expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(f.pushes).toEqual([]);
    expect(fs.existsSync(marker(f))).toBe(false);
  });

  it('log close failure still attaches the child error handler and transfers the lock token', () => {
    const f = fixture(), child = { once: vi.fn(), unref: vi.fn() }, close = fs.closeSync;
    let fd, owner;
    const spawnFn = vi.fn((bin, args, options) => {
      fd = options.stdio[1]; owner = args.find(arg => arg.startsWith('--token=')).slice('--token='.length);
      return child;
    });
    const failedClose = vi.fn();
    vi.spyOn(fs, 'closeSync').mockImplementation(value => {
      close(value);
      if (value === fd) { failedClose(); throw new Error('log close unavailable'); }
    });
    expect(tick(f, { spawnFn })).toMatchObject({ started: [ref], skipped: [] });
    expect(failedClose).toHaveBeenCalledOnce();
    expect(child.once).toHaveBeenCalledWith('error', expect.any(Function));
    expect(child.unref).toHaveBeenCalledOnce();
    expect(fs.readFileSync(marker(f), 'utf8')).toBe(owner);
    const onError = child.once.mock.calls.find(([name]) => name === 'error')[1];
    expect(() => onError(new Error('spawn unavailable'))).not.toThrow();
    expect(fs.existsSync(marker(f))).toBe(false);
  });

  it('unavailable needs-you feed never masks a sync failure or its local alert', async () => {
    const f = fixture({ conflict: true });
    f.env.WE_NEEDS_YOU_FEED = f.base; // directory: publisher cannot append
    await expect(job(f)).rejects.toThrow(/merge conflicts/);
    expect(alerts(f)).toHaveLength(1); attempted(f);
  });

  it('clean merge pushes the same ref non-force and emits overlay-main-synced {ref,from,to,tests}', async () => {
    const f = fixture();
    await job(f);
    expect(f.pushes).toEqual([['push', 'origin', `HEAD:refs/heads/${ref}`]]);
    const to = ok(f.origin, ['rev-parse', `refs/heads/${ref}`]);
    expect(to).not.toBe(f.oldSha);
    expect(ok(f.origin, ['rev-list', '--parents', '-n', '1', to]).split(' ')).toEqual([to, f.oldSha, f.mainSha]);
    expect(synced(f)).toEqual([expect.objectContaining({ ref, from: f.oldSha, to,
      tests: expect.arrayContaining(['worker0.test.mjs', 'overlay.test.mjs']) })]);
    expect(f.deps.testRunner).toHaveBeenCalledOnce();
    expect(json(sidecar(f)).lastSyncedMain[ref]).toBe(f.mainSha);
    unchanged(f);
  });

  it('uses main union attributes absent from the overlay to merge both testing.md appends without conflict', async () => {
    const f = fixture({ mainUnion: true });
    expect(run(['cat-file', '-e', `${f.oldSha}:.gitattributes`], { cwd: f.root }).status).not.toBe(0);
    expect(ok(f.root, ['show', `${f.mainSha}:.gitattributes`])).toBe('docs/agent/testing.md merge=union');
    expect(await job(f)).toMatchObject({ pushed: true });
    const merged = ok(f.origin, ['show', `${ref}:docs/agent/testing.md`]);
    expect(merged.split('\n')).toEqual(expect.arrayContaining(['# Testing', 'Overlay testing notes', 'Main testing notes']));
    expect(merged).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
    expect(f.events.filter(e => e.kind === 'overlay-main-merge-conflict')).toEqual([]);
    expect(readOverlayConflictWakes(f.env).size).toBe(0);
    expect(alerts(f)).toEqual([]);
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toEqual([]);
    unchanged(f);
  });

  it.each([
    ['clean merge', false, false],
    ['non-union conflict', true, false],
    ['union append conflict', false, true],
  ])('unsupported attribute-source option falls back to the plain merge: %s', async (_, conflict, mainUnion) => {
    const f = fixture({ conflict, mainUnion }), git = f.deps.git;
    f.deps.git = vi.fn((args, opts) => args[0] === '--attr-source=origin/main'
      ? { status: 129, stdout: '', stderr: `unknown option: --attr-source${mainUnion ? '' : '=origin/main'}\nusage: git [<options>] <command> [<args>]\n` }
      : git(args, opts));
    if (conflict || mainUnion) {
      const files = [mainUnion ? 'docs/agent/testing.md' : 'worker.mjs'];
      await expect(job(f)).rejects.toMatchObject({ step: 'merge', message: expect.stringContaining(files[0]) });
      expect(f.events).toContainEqual(expect.objectContaining({ kind: 'overlay-main-merge-conflict', ref, files }));
      expect(f.deps.git).toHaveBeenCalledWith(['merge', '--abort'], expect.any(Object));
      expect(f.pushes).toEqual([]);
    } else expect(await job(f)).toMatchObject({ pushed: true });
    expect(f.deps.git.mock.calls.filter(([args]) => gitCommand(args) === 'merge' && !args.includes('--abort'))
      .map(([args]) => args)).toEqual([
      ['--attr-source=origin/main', 'merge', '--no-edit', 'origin/main'],
      ['merge', '--no-edit', 'origin/main'],
    ]);
    unchanged(f);
  });

  it.each([
    [129, 'unknown option: --another-option\n'],
    [128, 'fatal: bad tree object origin/main\n'],
  ])('attribute-source merge failure without an unsupported-option diagnostic refuses without fallback (%s)', async (status, stderr) => {
    const f = fixture(), git = f.deps.git;
    f.deps.git = vi.fn((args, opts) => args[0] === '--attr-source=origin/main'
      ? { status, stdout: '', stderr } : git(args, opts));
    await expect(job(f)).rejects.toMatchObject({ step: 'merge', stderrTail: stderr.trim() });
    expect(f.deps.git).not.toHaveBeenCalledWith(['merge', '--no-edit', 'origin/main'], expect.any(Object));
    expect(f.events.filter(e => e.kind === 'overlay-main-merge-conflict')).toEqual([]);
    expect(f.deps.testRunner).not.toHaveBeenCalled(); expect(f.pushes).toEqual([]);
    unchanged(f);
  });

  it('main union attributes still refuse a conflicting non-union file with abort, notifications and wake', async () => {
    const f = fixture({ mainUnion: true, conflict: true });
    await expect(job(f)).rejects.toMatchObject({ step: 'merge', message: expect.stringContaining('worker.mjs') });
    expect(f.events.filter(e => e.kind === 'overlay-main-merge-conflict')).toEqual([
      expect.objectContaining({ ref, files: ['worker.mjs'] }),
    ]);
    expect(f.deps.git.mock.calls.some(([args]) => args[0] === 'merge' && args[1] === '--abort')).toBe(true);
    expect(readOverlayConflictWakes(f.env).get(123)).toMatchObject({ pr: 123, ref, files: ['worker.mjs'], clone: f.root });
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toContainEqual(expect.objectContaining({
      kind: 'overlay-main-sync-needs-you', pr: 123, ref,
    }));
    expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    expect(ok(f.origin, ['rev-parse', ref])).toBe(f.oldSha);
    unchanged(f);
  });

  it('conflict -> no push, overlay-main-merge-conflict event + needs-you naming ref and files + conflict wake marked', async () => {
    const f = fixture({ conflict: true });
    await job(f).catch(() => {});
    expect(f.pushes).toEqual([]);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'overlay-main-merge-conflict', ref, files: ['worker.mjs'] }));
    expect(alerts(f)).toEqual(expect.arrayContaining([expect.objectContaining({
      detail: expect.objectContaining({ ref, reason: expect.stringContaining('worker.mjs') }),
    })]));
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toContainEqual(expect.objectContaining({
      kind: 'overlay-main-sync-needs-you', repo: 'web-everything', pr: 123, ref,
    }));
    expect(readOverlayConflictWakes(f.env).get(123)).toMatchObject({ pr: 123, ref, files: ['worker.mjs'], clone: f.root });
    expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(synced(f)).toEqual([]);
    expect(ok(f.origin, ['rev-parse', ref])).toBe(f.oldSha);
    unchanged(f);
  });

  it.each(['rejected', 'failed', 'threw'])('%s push persists a ten-minute cooldown, skips ticks and automatically retries non-force', async outcome => {
    const f = fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000), started = Date.now();
    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: { [ref]: f.baseSha } }));
    ageFailure(f);
    const git = f.deps.git;
    let reject = true;
    f.deps.git = vi.fn((args, opts) => {
      if (args[0] !== 'push' || !reject) return git(args, opts);
      reject = false;
      f.pushes.push([...args]);
      if (outcome === 'threw') throw new Error('push transport threw');
      if (outcome === 'failed') return { status: null, error: new Error('push transport failed'), stdout: '' };
      // Advance the real remote independently, then let Git reject the non-fast-forward push.
      const tree = ok(f.origin, ['rev-parse', `${f.oldSha}^{tree}`]);
      const moved = ok(f.origin, ['commit-tree', tree, '-p', f.oldSha, '-m', 'concurrent writer']);
      ok(f.origin, ['update-ref', `refs/heads/${ref}`, moved, f.oldSha]);
      const result = run(args, opts); expect(result.status).not.toBe(0); return result;
    });
    expect(await job(f)).toEqual({ pushed: false });
    expect(f.pushes).toHaveLength(1);
    expect(synced(f)).toEqual([]);
    expect(json(sidecar(f)).lastSyncedMain[ref]).toBe(f.baseSha);
    expect(json(sidecar(f)).attemptedMain?.[ref]).toBeUndefined();
    expect(json(sidecar(f)).pushRetryAfter[ref]).toBe(started + 10 * 60_000);
    expect(json(sidecar(f)).pushRetryMain[ref]).toBe(f.mainSha);
    for (const key of ['retryMain', 'retryTries', 'retryAfter']) expect(json(sidecar(f))[key][ref]).toBeUndefined();
    expect(alerts(f)).toHaveLength(1);
    expect(alerts(f)[0].detail.reason).toMatch(/push.*(failed|rejected|transport)/i);
    const spawnFn = spawner();
    f.deps.git.mockClear();
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    clock.mockReturnValue(started + 10 * 60_000 - 1);
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(spawnFn).not.toHaveBeenCalled(); expect(f.deps.git).not.toHaveBeenCalled();
    expect(f.deps.testRunner).toHaveBeenCalledOnce(); expect(f.scratched).toHaveLength(1);
    clock.mockReturnValue(started + 10 * 60_000);
    expect(tick(f, { spawnFn }).started).toEqual([ref]);
    expect(spawnFn).toHaveBeenCalledOnce();
    fs.unlinkSync(marker(f)); // The fake child hands off to the real worker below.
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(f.deps.testRunner).toHaveBeenCalledTimes(2);
    expect(f.pushes).toEqual(Array(2).fill(['push', 'origin', `HEAD:refs/heads/${ref}`]));
    expect(json(sidecar(f)).pushRetryAfter[ref]).toBeUndefined();
    expect(json(sidecar(f)).pushRetryMain[ref]).toBeUndefined();
    unchanged(f);
  });

  it.each(['returned', 'thrown', 'published'])('%s push timeout runs once and records a failure with a ten-minute cooldown', async mode => {
    const f = fixture(), git = f.deps.git, events = [], started = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(started);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.deps.gitBackoff = vi.fn();
    f.deps.appendDaemonEvent = e => events.push(e);
    f.deps.git = vi.fn((args, opts) => {
      if (args[0] !== 'push') return git(args, opts);
      if (mode === 'published') expect(git(args, opts).status).toBe(0);
      const error = Object.assign(new Error('push timed out'), { code: 'ETIMEDOUT' });
      if (mode === 'thrown') throw error;
      return { status: null, stdout: '', error };
    });
    expect(await job(f)).toEqual({ pushed: false });
    expect(f.deps.git.mock.calls.filter(([args]) => args[0] === 'push')).toHaveLength(1);
    expect(f.deps.gitBackoff).not.toHaveBeenCalled();
    const state = json(sidecar(f));
    expect(state.pushRetryAfter[ref]).toBe(started + 10 * 60_000);
    expect(state.pushRetryMain[ref]).toBe(f.mainSha);
    expect(state.firstFailureAt[ref]).toBe(started);
    expect(state.lastSyncedMain[ref]).toBeUndefined();
    expect(events).toEqual([{ kind: 'overlay-main-sync-failed', detail: expect.objectContaining({ ref, step: 'push' }) }]);
    expect(log).toHaveBeenCalledOnce();
    expect(alerts(f)).toEqual([]); expect(synced(f)).toEqual([]);
    expect(ok(f.origin, ['rev-parse', ref]) === f.oldSha).toBe(mode !== 'published');
    unchanged(f);
  });

  it('contained bases skipped', () => {
    const state = { corrupt: false, overlays: [{ ref: 'lane/base' }, { ref, stackBases: ['lane/base'] }, { ref: 'lane/solo' }] };
    expect(selectSyncTargets(state)).toEqual([ref, 'lane/solo']);
  });

  it('alerts once after strictly two hours per failure streak and success resets the streak', async () => {
    const f = fixture(), started = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started), git = f.deps.git;
    const fail = (args, opts) => args[0] === 'push'
      ? { status: 1, stdout: '', stderr: 'permission denied by branch protection' } : git(args, opts);
    f.deps.git = fail;
    for (const [elapsed, count] of [[0, 0], [60 * 60_000, 0], [120 * 60_000, 0], [120 * 60_000 + 1, 1], [240 * 60_000, 1]]) {
      clock.mockReturnValue(started + elapsed);
      expect(await job(f)).toEqual({ pushed: false });
      expect(alerts(f)).toHaveLength(count);
      expect(json(sidecar(f)).firstFailureAt[ref]).toBe(started);
    }
    expect(alerts(f)[0].detail.reason).toContain('permission denied by branch protection');
    f.deps.git = git;
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(json(sidecar(f)).firstFailureAt[ref]).toBeUndefined();
    f.deps.git = fail;
    expect(await job(f)).toEqual({ pushed: false });
    clock.mockReturnValue(Date.now() + 120 * 60_000 + 1);
    expect(await job(f)).toEqual({ pushed: false });
    expect(alerts(f)).toHaveLength(2);
  });

  it('corruption alerts again after recovery and successful sync reset the independent failure streak', async () => {
    const f = fixture(), started = 1_800_000_000_000, delay = 2 * 60 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    fs.writeFileSync(sidecar(f), '{broken');
    await expect(job(f)).rejects.toThrow();
    expect(alerts(f)).toHaveLength(0);
    clock.mockReturnValue(started + delay + 1);
    await expect(job(f)).rejects.toThrow();
    expect(alerts(f)).toHaveLength(1);
    await expect(job(f)).rejects.toThrow();
    expect(alerts(f)).toHaveLength(1);

    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: {} }));
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(json(sidecar(f)).firstFailureAt[ref]).toBeUndefined();
    expect(json(sidecar(f)).failureAlertedAt[ref]).toBeUndefined();

    const renewed = started + delay + 2;
    clock.mockReturnValue(renewed);
    fs.writeFileSync(sidecar(f), '{broken');
    await expect(job(f)).rejects.toThrow();
    expect(alerts(f)).toHaveLength(1);
    clock.mockReturnValue(renewed + delay);
    await expect(job(f)).rejects.toThrow();
    expect(alerts(f)).toHaveLength(1);
    clock.mockReturnValue(renewed + delay + 1);
    await expect(job(f)).rejects.toThrow();
    expect(alerts(f)).toHaveLength(2);
    await expect(job(f)).rejects.toThrow();
    expect(alerts(f)).toHaveLength(2);
  });

  it('state publication failure after push stays retryable instead of remembering a failed main', async () => {
    const f = fixture(), git = f.deps.git;
    ageFailure(f);
    let pushed = false, failed = false;
    f.deps.git = (args, opts) => {
      const result = git(args, opts);
      if (args[0] === 'push') pushed = true;
      return result;
    };
    f.deps.io.readFileSync = (file, ...args) => {
      if (file === sidecar(f) && pushed && !failed) {
        failed = true;
        throw new Error('state publication unavailable');
      }
      return fs.readFileSync(file, ...args);
    };
    await expect(job(f)).rejects.toThrow('state publication unavailable');
    expect(failed).toBe(true);
    expect(json(sidecar(f)).attemptedMain[ref]).toBeUndefined();
    for (const key of ['retryMain', 'retryTries', 'retryAfter']) expect(json(sidecar(f))[key][ref]).toBeUndefined();
    expect(alerts(f)[0].detail.reason).toContain('state publication unavailable');
  });

  it('no run while the auto-rebase marker is held', async () => {
    const f = fixture(), spawnFn = vi.fn();
    fs.mkdirSync(dirname(marker(f)), { recursive: true }); fs.writeFileSync(marker(f), 'auto-rebase-owner');
    expect(await tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(marker(f), 'utf8')).toBe('auto-rebase-owner');
  });

  it('>100 tests run sequentially in bounded admitted chunks with distinct reports before push', async () => {
    const f = fixture({ count: 101 }), passing = f.deps.testRunner;
    let active = false;
    f.deps.testRunner = vi.fn(async options => {
      expect(active).toBe(false); active = true;
      expect(f.pushes).toEqual([]);
      expect(options.args.slice(0, 2)).toEqual([join(f.root, 'scripts/readiness/heavy-admission.mjs'), 'run']);
      const result = await passing(options); active = false; return result;
    });
    const result = await job(f);
    expect(result.pushed).toBe(true); expect(result.tests).toHaveLength(102);
    const calls = f.deps.testRunner.mock.calls.map(([o]) => o.args);
    expect(calls.map(args => args.filter(a => a.endsWith('.test.mjs')).length)).toEqual([50, 50, 2]);
    expect(new Set(f.deps.testRunner.mock.calls.map(([o]) => o.testReport)).size).toBe(3);
    expect(alerts(f)).toEqual([]); unchanged(f);
  });

  it("no trigger when main's new commits don't touch the overlay's files", async () => {
    const f = fixture({ unrelated: true }), spawnFn = vi.fn();
    expect(await tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('shadow mode persists main SHA and logs, emits and returns would only once per ref and main', async () => {
    const f = fixture(), spawnFn = vi.fn(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await tick(f, { mode: 'shadow', spawnFn })).toMatchObject({ started: [], would: [ref] });
    expect(log.mock.calls.flat().join('\n')).toContain(`overlay-main-sync would merge main into ${ref}`);
    expect(spawnFn).not.toHaveBeenCalled();
    const eventFile = overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl');
    expect(json(sidecar(f)).shadowMain[ref]).toBe(f.mainSha);
    const eventsBefore = fs.readFileSync(eventFile, 'utf8');
    log.mockClear();
    expect(tick(f, { mode: 'shadow', spawnFn })).toMatchObject({ started: [], skipped: [ref], would: [] });
    expect(tick(f, { mode: 'shadow', spawnFn })).toMatchObject({ started: [], skipped: [ref], would: [] });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().every(line => line.includes('skipped') && line.includes('up-to-date'))).toBe(true);
    log.mockClear();
    expect(fs.readFileSync(eventFile, 'utf8')).toBe(eventsBefore);
    const tree = ok(f.origin, ['rev-parse', `${f.mainSha}^{tree}`]);
    const moved = ok(f.origin, ['commit-tree', tree, '-p', f.mainSha, '-m', 'next main']);
    ok(f.origin, ['update-ref', 'refs/heads/main', moved, f.mainSha]);
    expect(tick(f, { mode: 'shadow', spawnFn }).would).toEqual([ref]);
    expect(json(sidecar(f)).shadowMain[ref]).toBe(moved);
    expect(log).toHaveBeenCalledOnce();
    expect(fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(JSON.parse)
      .filter(e => e.kind === 'overlay-main-sync-shadow')).toHaveLength(2);
    expect(spawnFn).not.toHaveBeenCalled();
    // Shadow memory never blocks switching to live mode for the same main.
    const live = spawner();
    expect(tick(f, { spawnFn: live }).started).toEqual([ref]);
    expect(live).toHaveBeenCalledOnce();
  });

  it('a deleted origin branch skips as stale registration with no operator attention', () => {
    const f = fixture(), spawnFn = spawner();
    ok(f.origin, ['update-ref', '-d', `refs/heads/${ref}`]);
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(json(sidecar(f)).staleRef[ref]).toBeTypeOf('number');
    expect(json(sidecar(f)).firstFailureAt[ref]).toBeUndefined();
    expect(alerts(f)).toEqual([]);
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toEqual([]);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('fetch failure waits strictly more than two hours and alerts once per streak across ticks', () => {
    const f = fixture(), spawnFn = spawner(), started = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    const git = f.deps.git;
    f.deps.git = vi.fn((args, opts) => args[0] === 'fetch' ? { status: 1, stdout: '' } : git(args, opts));
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(alerts(f)).toHaveLength(0);
    expect(json(sidecar(f)).firstFailureAt[ref]).toBe(started);
    expect(json(sidecar(f)).failureAlertedAt[ref]).toBeUndefined();
    expect(json(sidecar(f)).errorAt[ref]).toBeUndefined();
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toEqual([]);
    tick(f, { spawnFn });
    clock.mockReturnValue(started + 2 * 60 * 60_000 - 1);
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(0);
    clock.mockReturnValue(started + 2 * 60 * 60_000);
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(0);
    const alertedAt = started + 2 * 60 * 60_000 + 1;
    clock.mockReturnValue(alertedAt);
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(1);
    expect(alerts(f)[0].detail.reason).toContain('fetch: command failed or incomplete');
    expect(json(sidecar(f)).errorAt[ref]).toBe(alertedAt);
    expect(json(sidecar(f)).failureAlertedAt[ref]).toBe(alertedAt);
    clock.mockReturnValue(started + 4 * 60 * 60_000);
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(1);
    expect(json(sidecar(f)).firstFailureAt[ref]).toBe(started);
    expect(json(sidecar(f)).failureAlertedAt[ref]).toBe(alertedAt);
    expect(json(sidecar(f)).errorAt[ref]).toBe(alertedAt);
    expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toHaveLength(1);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('mode cascade (default shadow, settings, env)', () => {
    const base = temp(), settingsPath = join(base, 'settings.json'), preferences = join(base, 'preferences.json');
    const env = { WE_PLATFORM_PREFERENCES_FILE: preferences };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolve = e => resolveOverlayMainSyncMode(e, { settingsPath });
    expect(resolve(env)).toEqual({ mode: 'shadow', source: 'standard' });
    write(base, 'preferences.json', JSON.stringify({ overlayMainSync: { mode: 'off' } }));
    expect(resolve(env)).toEqual({ mode: 'off', source: 'platform' });
    write(base, 'settings.json', JSON.stringify({ overlayMainSync: { mode: 'shadow' } }));
    expect(resolve(env)).toEqual({ mode: 'shadow', source: 'tool' });
    for (const mode of ['on', 'off', 'shadow']) expect(resolve({ ...env, WE_DAEMON_OVERLAY_MAIN_SYNC: mode })).toEqual({ mode, source: 'env' });
    expect(log.mock.calls.flat().join('\n')).toMatch(/source=env/);
  });

  // Reusable contract for off|shadow|on settings: malformed inputs never choose live mode.
  function assertInvalidModesStayShadow(resolveMode, settingsPath) {
    fs.writeFileSync(settingsPath, JSON.stringify({ overlayMainSync: { mode: 'shadow' } }));
    for (const value of ['bogus', 'ON', ' on ', '', 'true']) {
      expect(resolveMode({ WE_DAEMON_OVERLAY_MAIN_SYNC: value }).mode).toBe('shadow');
    }
    for (const raw of ['{broken', 'null', JSON.stringify({ overlayMainSync: { mode: 'bogus' } })]) {
      fs.writeFileSync(settingsPath, raw);
      expect(resolveMode({}).mode).toBe('shadow');
    }
  }

  it('invalid environment and corrupt settings resolve to shadow', () => {
    const base = temp(), settingsPath = join(base, 'settings.json');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    assertInvalidModesStayShadow(env => resolveOverlayMainSyncMode({
      WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), ...env,
    }, { settingsPath }), settingsPath);
  });

  it('unchanged mode provenance logs once across consecutive resolutions', () => {
    const base = temp(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing') };
    const options = { settingsPath: join(base, 'settings.json') };
    resolveOverlayMainSyncMode(env, options);
    resolveOverlayMainSyncMode(env, options);
    expect(log).toHaveBeenCalledTimes(1);
    resolveOverlayMainSyncMode({ ...env, WE_DAEMON_OVERLAY_MAIN_SYNC: 'off' }, options);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('off mode skips an eligible unsynced overlay without Git or spawn calls', () => {
    const f = fixture(), spawnFn = spawner();
    expect(tick(f, { mode: 'off', spawnFn })).toEqual({ started: [], skipped: [], would: [] });
    expect(f.deps.git).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(tick(f, { spawnFn }).started).toEqual([ref]);
  });

  it('eligible overlay launches a detached unreferenced worker', () => {
    const f = fixture(), unref = vi.fn(), spawnFn = vi.fn(() => ({ once: vi.fn(), unref }));
    expect(tick(f, { spawnFn }).started).toEqual([ref]);
    expect(spawnFn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([
      `--clone=${f.root}`, `--ref=${ref}`,
    ]), { cwd: f.root, env: f.env, detached: true, stdio: ['ignore', expect.any(Number), expect.any(Number)] });
    expect(unref).toHaveBeenCalledOnce();
  });

  it('unreadable graph input refuses publication', async () => {
    const f = fixture();
    ageFailure(f);
    f.deps.io.readFileSync = (file, ...args) => {
      if (String(file).endsWith('/repo/worker.mjs')) throw new Error('graph-source unreadable');
      return fs.readFileSync(file, ...args);
    };
    await expect(job(f)).rejects.toThrow('graph-source unreadable');
    expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(f.pushes).toEqual([]);
    expect(alerts(f)[0].detail.reason).toContain('graph-source unreadable');
  });

  it.each(['synced', 'retry'])('concurrent refs preserve each other’s sync and retry state (%s)', async outcome => {
    const f = fixture(), other = 'lane/other';
    addOverlay(f.root, { ref: other }, { env: f.env });
    let overlap, interleaved = false, pushReached = false;
    const git = f.deps.git;
    f.deps.git = (args, opts) => {
      if (args[0] === 'push') {
        pushReached = true;
        if (outcome === 'retry') return { status: 1, stdout: '', stderr: 'permission denied' };
      }
      return git(args, opts);
    };
    const otherGit = args => ({ status: 0, stdout: args[0] === 'fetch' ? ''
      : args[0] === 'diff' ? 'worker.mjs\0' : `${f.mainSha}\n` });
    const otherTick = () => tick(f, { mode: 'shadow', git: otherGit });
    // Pause writer A after reading its snapshot, then run writer B before A publishes.
    f.deps.io.readFileSync = (file, ...args) => {
      const value = fs.readFileSync(file, ...args);
      if (file === sidecar(f) && pushReached && !interleaved) {
        interleaved = true;
        overlap = otherTick();
      }
      return value;
    };
    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: {} }));
    await job(f);
    expect(interleaved).toBe(true);
    // A contending transaction may defer, but an acknowledged write must never disappear.
    if (overlap.would.includes(other)) expect(json(sidecar(f)).shadowMain[other]).toBe(f.mainSha);
    otherTick();
    const state = json(sidecar(f));
    expect(state.shadowMain[other]).toBe(f.mainSha);
    expect(state[outcome === 'synced' ? 'lastSyncedMain' : 'pushRetryMain'][ref]).toBe(f.mainSha);
    if (outcome === 'retry') expect(state.pushRetryAfter[ref]).toBeGreaterThan(Date.now());
  });

  it('already synced main is skipped and off mode spawns nothing', async () => {
    const f = fixture(), spawnFn = vi.fn();
    fs.writeFileSync(sidecar(f), JSON.stringify({ lastSyncedMain: { [ref]: f.mainSha } }));
    expect(await tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    await tick(f, { mode: 'off', spawnFn });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(readOverlayState(f.root, { env: f.env }).overlays.map(o => o.ref)).toEqual([ref]);
  });

  it('failing selected tests do not push and remember the attempted main', async () => {
    const f = fixture({ exhausted: true }), passing = f.deps.testRunner;
    f.deps.testRunner = vi.fn(async options => {
      await passing(options);
      return { status: 1, stdout: '', stderr: 'selected test failed' };
    });
    await expect(job(f)).rejects.toThrow(/command failed/);
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    attempted(f); unchanged(f);
  });

  it.each(['failed', 'nothing executed'])('testRunner reports %s: no push, flagged and remembered', async outcome => {
    const f = fixture({ exhausted: true }), passing = f.deps.testRunner;
    ageFailure(f);
    f.deps.testRunner = vi.fn(async options => {
      const result = await passing(options);
      const reportFile = options.testReport;
      const report = json(reportFile);
      for (const test of report.testResults) test.assertionResults = outcome === 'failed' ? [{ status: 'failed' }] : [];
      fs.writeFileSync(reportFile, JSON.stringify(report));
      return result;
    });
    await expect(job(f)).rejects.toThrow(/did not pass or execute/);
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    expect(alerts(f).some(e => /did not pass or execute/.test(e.detail.reason))).toBe(true);
    attempted(f); unchanged(f);
  });

  it.each([
    ['empty selection', { count: 0, overlayTest: false }],
    ['deleting the final relevant test', { overlayTest: false, deleteFinalTest: true }],
  ])('%s skips without push, attention or failure streak', async (_, options) => {
    const f = fixture(options), events = [];
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.deps.appendDaemonEvent = e => events.push(e);
    expect(await job(f)).toEqual({ skipped: true, reason: 'no-relevant-tests' });
    expect(f.deps.testRunner).not.toHaveBeenCalled();
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    expect(ok(f.origin, ['rev-parse', ref])).toBe(f.oldSha);
    expect(events).toEqual([{ kind: 'overlay-main-sync-skipped', detail: { ref, reason: 'no-relevant-tests' } }]);
    expect(log).toHaveBeenCalledOnce();
    expect(alerts(f)).toEqual([]); expect(replay({ path: f.env.WE_NEEDS_YOU_FEED })).toEqual([]);
    if (fs.existsSync(sidecar(f))) {
      const state = json(sidecar(f));
      for (const key of ['attemptedMain', 'retryMain', 'pushRetryMain', 'firstFailureAt', 'failureReason']) {
        expect(state[key]?.[ref]).toBeUndefined();
      }
    }
    expect(f.scratched.every(p => !fs.existsSync(p))).toBe(true);
    unchanged(f);
  });

  it('report over 8 MiB refuses a push and alerts that operator review is required', async () => {
    const f = fixture({ exhausted: true }), passing = f.deps.testRunner;
    ageFailure(f);
    f.deps.testRunner = vi.fn(async options => {
      const result = await passing(options);
      const reportFile = options.testReport;
      // Valid passing JSON remains valid after padding, so removing the cap would publish.
      fs.appendFileSync(reportFile, ' '.repeat(8 * 1024 * 1024));
      return result;
    });
    await expect(job(f)).rejects.toThrow('test report over 8 MiB; operator review required');
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    expect(alerts(f).some(e => e.detail.reason === 'tests: test report over 8 MiB; operator review required')).toBe(true);
    attempted(f); unchanged(f);
  });

  it('marker heartbeat refreshes lock mtime while tests run past the 30-minute expiry', async () => {
    const f = fixture(), passing = f.deps.testRunner, spawnFn = spawner();
    vi.useFakeTimers();
    f.deps.heartbeatMs = 1000;
    f.deps.testRunner = vi.fn(async options => {
      const before = fs.statSync(marker(f)).mtimeMs;
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(fs.statSync(marker(f)).mtimeMs).toBeGreaterThan(before + 30 * 60_000);
      expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
      expect(spawnFn).not.toHaveBeenCalled();
      return passing(options);
    });
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(vi.getTimerCount()).toBe(0);
    expect(fs.existsSync(marker(f))).toBe(false);
    unchanged(f);
  });

  it('marker token lost before push refuses publication and preserves the new owner', async () => {
    const f = fixture({ exhausted: true }), passing = f.deps.testRunner;
    ageFailure(f);
    f.deps.testRunner = vi.fn(async options => {
      const result = await passing(options);
      fs.writeFileSync(marker(f), 'new-owner');
      return result;
    });
    await expect(job(f)).rejects.toThrow(/marker changed/);
    expect(f.pushes).toEqual([]); expect(synced(f)).toEqual([]);
    expect(fs.readFileSync(marker(f), 'utf8')).toBe('new-owner');
    attempted(f); unchanged(f);
  });

  it('unsafe ref --upload-pack=x is refused by kick and run before any spawn', async () => {
    const f = fixture(), unsafe = '--upload-pack=x', spawnFn = spawner();
    const state = json(overlayFilePath(f.root, f.env));
    state.overlays[0].ref = unsafe;
    fs.writeFileSync(overlayFilePath(f.root, f.env), JSON.stringify(state));
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [unsafe] });
    await expect(runOverlayMainSync({ root: f.root, ref: unsafe, env: f.env, deps: f.deps })).rejects.toThrow(/unsafe overlay ref/);
    expect(spawnFn).not.toHaveBeenCalled(); expect(f.deps.git).not.toHaveBeenCalled();
    expect(json(sidecar(f)).firstFailureAt[unsafe]).toEqual(expect.any(Number));
    expect(alerts(f)).toEqual([]);
  });

  it.each([
    '{broken', '{}', JSON.stringify({ lastSyncedMain: { [ref]: 'origin/main' } }),
    JSON.stringify({ lastSyncedMain: {}, attemptedMain: { [ref]: 'not-a-sha' } }),
    JSON.stringify({ lastSyncedMain: {}, attemptedMain: null }),
    JSON.stringify({ lastSyncedMain: {}, pushRetryAfter: { [ref]: 1_800_000_000_000 } }),
    ...['shadowMain', 'pushRetryMain'].flatMap(key => [null, { [ref]: 'not-a-sha' }]
      .map(value => JSON.stringify({ lastSyncedMain: {}, [key]: value }))),
    ...['pushRetryAfter', 'errorAt'].flatMap(key => [null, { [ref]: 'tomorrow' }, { [ref]: -1 }]
      .map(value => JSON.stringify({ lastSyncedMain: {}, [key]: value }))),
  ])('corrupt/non-SHA sidecar fails closed with no spawn (%#)', async raw => {
    const f = fixture(), spawnFn = spawner();
    fs.writeFileSync(sidecar(f), raw);
    const started = 1_800_000_000_000, clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(alerts(f)).toEqual([]);
    clock.mockReturnValue(started + 2 * 60 * 60_000 + 1);
    await expect(job(f)).rejects.toThrow();
    expect(spawnFn).not.toHaveBeenCalled(); expect(f.deps.git).not.toHaveBeenCalled();
    expect(fs.readFileSync(sidecar(f), 'utf8')).toBe(raw);
    expect(alerts(f)).toHaveLength(1);
  });

  it('corrupt sidecar diagnostic alerts once only after more than two hours', () => {
    const f = fixture(), spawnFn = spawner(), started = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    fs.writeFileSync(sidecar(f), '{broken');
    tick(f, { spawnFn });
    clock.mockReturnValue(started + 2 * 60 * 60_000);
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(0);
    clock.mockReturnValue(started + 2 * 60 * 60_000 + 1);
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(1);
    clock.mockReturnValue(started + 4 * 60 * 60_000);
    tick(f, { spawnFn });
    expect(alerts(f)).toHaveLength(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(f.deps.git).not.toHaveBeenCalled();
  });

  it('unreadable sidecar fails closed and shares the independent diagnostic rate limit', async () => {
    const f = fixture(), started = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    f.deps.io.readFileSync = (file, ...args) => {
      if (file === sidecar(f)) throw Object.assign(new Error('sidecar unreadable'), { code: 'EACCES' });
      return fs.readFileSync(file, ...args);
    };
    await expect(job(f)).rejects.toThrow('sidecar unreadable');
    expect(alerts(f)).toEqual([]);
    clock.mockReturnValue(started + 2 * 60 * 60_000 + 1);
    await expect(job(f)).rejects.toThrow('sidecar unreadable');
    await expect(job(f)).rejects.toThrow('sidecar unreadable');
    expect(alerts(f)).toHaveLength(1);
    expect(alerts(f)[0].detail.reason).toBe('state: sidecar unreadable');
    expect(f.deps.git).not.toHaveBeenCalled();
    expect(f.deps.testRunner).not.toHaveBeenCalled();
  });

  it('diagnostic streak survives a fresh worker and alerts once after the original timestamp plus two hours', () => {
    const f = fixture(), started = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(started);
    fs.writeFileSync(sidecar(f), '{broken');
    tick(f, { spawnFn: spawner() });
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/lib/daemon-rebuild/overlay-main-sync.mjs')).href;
    const code = `
      import { readFileSync, existsSync } from 'node:fs';
      import { kickOverlayMainSync } from ${JSON.stringify(moduleUrl)};
      const { root, env, started, alertsFile } = JSON.parse(readFileSync(0, 'utf8'));
      const counts = [];
      for (const elapsed of [120 * 60_000, 120 * 60_000 + 1, 240 * 60_000]) {
        Date.now = () => started + elapsed;
        kickOverlayMainSync({ root, env, mode: 'on',
          git: () => { throw new Error('unexpected Git'); },
          spawnFn: () => { throw new Error('unexpected spawn'); },
        });
        counts.push(existsSync(alertsFile) ? readFileSync(alertsFile, 'utf8').trim().split('\\n').length : 0);
      }
      console.log(JSON.stringify(counts));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      input: JSON.stringify({ root: f.root, env: f.env, started, alertsFile: alertsFilePath(f.root, f.env) }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([0, 1, 1]);
  });

  it('stale marker older than 30 minutes is taken over', () => {
    const f = fixture(), spawnFn = spawner();
    fs.mkdirSync(dirname(marker(f)), { recursive: true }); fs.writeFileSync(marker(f), 'stale-owner');
    const stale = new Date(Date.now() - 31 * 60_000);
    fs.utimesSync(marker(f), stale, stale);
    expect(tick(f, { spawnFn }).started).toEqual([ref]);
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(fs.readFileSync(marker(f), 'utf8')).not.toBe('stale-owner');
  });

  it('failure memory skips the same main after conflict and spawns again after main moves', async () => {
    const f = fixture({ conflict: true }), spawnFn = spawner();
    await expect(job(f)).rejects.toThrow(/merge conflicts/);
    attempted(f);
    const eventFile = overlayFilePath(f.root, f.env).replace(/\.json$/, '.events.jsonl');
    const eventsBefore = fs.readFileSync(eventFile, 'utf8'), alertsBefore = alerts(f);
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(tick(f, { spawnFn })).toMatchObject({ started: [], skipped: [ref] });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(fs.readFileSync(eventFile, 'utf8')).toBe(eventsBefore);
    expect(alerts(f)).toEqual(alertsBefore);
    const tree = ok(f.origin, ['rev-parse', `${f.mainSha}^{tree}`]);
    const moved = ok(f.origin, ['commit-tree', tree, '-p', f.mainSha, '-m', 'main moves again']);
    ok(f.origin, ['update-ref', 'refs/heads/main', moved, f.mainSha]);
    expect(tick(f, { spawnFn }).started).toEqual([ref]);
    expect(spawnFn).toHaveBeenCalledOnce();
  });
});

describe('health-watch overlay main sync wiring', () => {
  it('tick registers overlayMainSync and forwards the actual flags through its error boundary', () => {
    const source = fs.readFileSync(join(process.cwd(), 'scripts/conveyor/health-watch.mjs'), 'utf8');
    const ast = ts.createSourceFile('health-watch.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const tickNode = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'tick');
    const assignments = [];
    const visit = node => {
      if (ts.isBinaryExpression(node) && node.left.getText(ast) === 'probes.overlayMainSync') assignments.push(node);
      ts.forEachChild(node, visit);
    };
    visit(tickNode.body);
    expect(assignments).toHaveLength(1);
    const probe = vi.fn(() => 'probe-result'), attempt = vi.fn((name, fn) => fn());
    const flags = { 'state-root': '/fixture', 'dry-run': true }, probes = {};
    // Execute the real assignment extracted from tick, without invoking unrelated host probes.
    Function('probes', 'attempt', 'probeOverlayMainSync', 'flags', assignments[0].getText(ast))(probes, attempt, probe, flags);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith(flags);
    expect(attempt).toHaveBeenCalledWith('overlayMainSync', expect.any(Function));
    expect(probes.overlayMainSync).toBe('probe-result');
  });
  it.each(['logs-dir', 'lock-root', 'state-root', 'dry-run', 'ps-fixture', 'arbitrary-fixture'])(
    '%s suppresses clone discovery and overlay kicks', flag => {
      const roots = vi.fn(), kick = vi.fn();
      expect(probeOverlayMainSync({ [flag]: true }, roots, kick)).toBeUndefined();
      expect(roots).not.toHaveBeenCalled(); expect(kick).not.toHaveBeenCalled();
    });

  it('one clone throwing returns its root and error and still kicks the next clone', () => {
    const kick = vi.fn(({ root }) => { if (root === 'broken') throw new Error('corrupt overlay'); return { started: [ref] }; });
    expect(probeOverlayMainSync({}, () => ['broken', 'healthy'], kick)).toEqual([
      { root: 'broken', error: 'corrupt overlay' }, { started: [ref] },
    ]);
    expect(kick.mock.calls).toEqual([[{ root: 'broken' }], [{ root: 'healthy' }]]);
  });
});
