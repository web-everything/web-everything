import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as sync from '../daemon-rebuild/overlay-main-sync.mjs';
import { runHeavyTests } from '../daemon-rebuild/auto-rebase.mjs';
import { scratchTestOutput } from '../../conveyor/soak/breaks/scratch-tests-forge-command.mjs';
import { addOverlay, appendOverlayEvent, overlayFilePath } from '../daemon-overlays.mjs';
import { alertsFilePath } from '../daemon-rebuild/state.mjs';

// Same real-tree / injected-runner fixture style as daemon-rebuild-overlay-main-sync.test.mjs.
const temps = [], ref = 'lane/fix', failedFile = 'worker0.test.mjs';
const selectedFiles = options => options.args.filter(arg => /\.test\.mjs$/.test(arg));
const temp = () => {
  const path = fs.mkdtempSync(join(tmpdir(), 'we-main-sync-rerun-test-'));
  temps.push(path);
  return path;
};
afterEach(() => {
  vi.restoreAllMocks();
  temps.splice(0).forEach(path => fs.rmSync(path, { recursive: true, force: true }));
});
const run = (args, opts = {}) => spawnSync('git',
  ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args],
  { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024, ...opts,
    env: { ...process.env, ...opts.env } });
const ok = (cwd, args) => {
  const result = run(args, { cwd });
  if (result.status !== 0) throw new Error(`${args}: ${result.stderr}`);
  return result.stdout.trim();
};
const write = (root, file, text) => {
  fs.mkdirSync(dirname(join(root, file)), { recursive: true });
  fs.writeFileSync(join(root, file), text);
};
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture({ reruns } = {}) {
  const base = temp(), root = join(base, 'clone'), origin = join(base, 'origin.git');
  fs.mkdirSync(root); fs.mkdirSync(join(root, 'node_modules'));
  ok(root, ['init', '-q', '-b', 'main']);
  write(root, '.gitignore', 'node_modules/\n');
  const lines = Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i};`);
  write(root, 'worker.mjs', `${lines.join('\n')}\n`);
  for (let i = 0; i < 3; i++) write(root, `worker${i}.test.mjs`, "import './worker.mjs';\n");
  ok(root, ['add', '.']); ok(root, ['commit', '-qm', 'base']);
  ok(root, ['checkout', '-qb', ref]);
  const overlay = [...lines]; overlay[0] = 'export const value0 = 100;';
  write(root, 'worker.mjs', `${overlay.join('\n')}\n`);
  ok(root, ['commit', '-qam', 'overlay']);
  const oldSha = ok(root, ['rev-parse', 'HEAD']);
  ok(root, ['checkout', '-q', 'main']);
  const main = [...lines]; main[29] = 'export const value29 = 200;';
  write(root, 'worker.mjs', `${main.join('\n')}\n`);
  ok(root, ['commit', '-qam', 'main advanced']);
  const mainSha = ok(root, ['rev-parse', 'HEAD']);
  ok(base, ['clone', '-q', '--bare', root, origin]);
  ok(root, ['remote', 'add', 'origin', origin]);
  ok(root, ['update-ref', 'refs/remotes/origin/main', mainSha]);
  ok(root, ['update-ref', `refs/remotes/origin/${ref}`, oldSha]);
  const env = { ...process.env, TMPDIR: base, WE_DAEMON_OVERLAY_DIR: join(base, 'overlays'),
    WE_DAEMON_STATE_DIR: join(base, 'state'), WE_DAEMON_EVENTS: join(base, 'daemon-events.jsonl'),
    WE_NEEDS_YOU_FEED: join(base, 'needs-you-events.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(base, 'missing'), WE_DAEMON_OVERLAY_MAIN_SYNC: 'on' };
  delete env.WE_DAEMON_OVERLAY_MAIN_SYNC_FLAKE_RERUNS;
  if (reruns !== undefined) env.WE_DAEMON_OVERLAY_MAIN_SYNC_FLAKE_RERUNS = String(reruns);
  addOverlay(root, { ref, pr: 123 }, { env });
  // Make an accidental operator failure observable immediately rather than waiting two hours.
  fs.writeFileSync(`${overlayFilePath(root, env)}.main-sync.state`, JSON.stringify({
    lastSyncedMain: {}, firstFailureAt: { [ref]: Date.now() - 3 * 60 * 60_000 },
  }));
  const events = [], outcomes = [], pushes = [], scratched = [];
  const deps = {
    io: { ...fs, mkdtempSync: prefix => {
      const path = fs.mkdtempSync(prefix); scratched.push(path); temps.push(path); return path;
    } },
    git: vi.fn((args, opts) => {
      // All objects already exist locally; observe publication without fetching or pushing.
      if (args[0] === 'push') { pushes.push([...args]); return { status: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
      return run(args, opts);
    }),
    appendOverlayEvent: (root, event, opts) => {
      events.push(event); return appendOverlayEvent(root, event, opts);
    },
    appendDaemonEvent: event => { outcomes.push(event); },
    now: () => new Date().toISOString(),
  };
  return { base, root, env, mainSha, events, outcomes, pushes, scratched, deps };
}

// Return valid Vitest evidence; a zero exit alone must never hide failed or unexecuted files.
function report(options, evidence = 'passed', status = 0) {
  const testResults = selectedFiles(options).flatMap(file => {
    const state = file === failedFile ? evidence : 'passed';
    if (state === 'missing') return [];
    return [{ name: join(fs.realpathSync(options.root), file),
      assertionResults: state === 'empty' ? [] : [{ status: state, title: 'worker behaves', ancestorTitles: ['worker'] }] }];
  });
  fs.writeFileSync(options.testReport, JSON.stringify({ testResults }));
  return { status, stdout: '', stderr: '' };
}
function runners(f, sequence, mainEvidence = 'passed', initialStatus = 0) {
  const trees = [];
  f.deps.testRunner = vi.fn(async options => {
    const index = trees.length;
    trees.push({ root: fs.realpathSync(options.root), head: ok(options.root, ['rev-parse', 'HEAD']) });
    expect(fs.readFileSync(join(options.root, 'worker.mjs'), 'utf8')).toContain('value0 = 100');
    expect(fs.readFileSync(join(options.root, 'worker.mjs'), 'utf8')).toContain('value29 = 200');
    return report(options, sequence[index] ?? 'failed', index === 0 ? initialStatus : 0);
  });
  // New injection contract: same invocation shape as testRunner, in a plain-main scratch checkout.
  f.deps.mainTestRunner = vi.fn(async options => {
    expect(selectedFiles(options)).toEqual([failedFile]);
    expect(fs.realpathSync(options.root)).not.toBe(fs.realpathSync(f.root));
    expect(ok(options.root, ['rev-parse', 'HEAD'])).toBe(f.mainSha);
    expect(fs.readFileSync(join(options.root, 'worker.mjs'), 'utf8')).toContain('value0 = 0;');
    return report(options, mainEvidence);
  });
  return trees;
}
const job = f => sync.runOverlayMainSync({ root: f.root, ref, env: f.env, deps: f.deps });
const kinds = f => f.events.map(event => event.kind);
const failure = 'selected tests did not pass or execute; operator review required';
const noPublication = f => {
  expect(f.pushes).toEqual([]);
  expect(kinds(f)).not.toContain('overlay-main-synced');
  expect(f.outcomes.some(event => event.kind === 'overlay-main-sync-synced')).toBe(false);
};
const sameMergedTree = trees => {
  expect(trees.length).toBeGreaterThan(1);
  for (const tree of trees.slice(1)) expect(tree).toEqual(trees[0]);
};

// Real Vitest reporters and the production runner; only process execution is injected.
function tapRunners(f, { flaky = false, mainTitle = 'worker behaves', mainSuite = 'worker', corrupt } = {}) {
  const calls = [];
  const runner = vi.fn(async options => runHeavyTests(options, { exec: async () => {
    const main = ok(options.root, ['rev-parse', 'HEAD']) === f.mainSha;
    const red = main || !flaky || calls.length === 0;
    calls.push({ main, files: selectedFiles(options), head: ok(options.root, ['rev-parse', 'HEAD']) });
    const state = failed => ({ state: failed ? 'fail' : 'pass', duration: 1,
      ...(failed ? { errors: [{ message: 'expected worker to behave', stack: '' }] } : {}) });
    let stdout = await scratchTestOutput(selectedFiles(options).map(name => {
      const failed = red && name === failedFile;
      return { type: 'suite', name, mode: 'run', result: state(failed), tasks: [
        { type: 'suite', name: main ? mainSuite : 'worker', mode: 'run', result: state(failed), tasks: [
          { type: 'suite', name: 'nested', mode: 'run', result: state(failed), tasks: [
            { type: 'test', name: main ? mainTitle : 'worker behaves', mode: 'run', result: state(failed) },
          ] },
        ] },
      ] };
    }));
    if (corrupt) stdout = corrupt(stdout);
    return { status: red ? 1 : 0, stdout, stderr: red ? 'tests failed' : '',
      ...(red ? { error: Object.assign(new Error('Command failed: tests'), { code: 1 }) } : {}) };
  } }));
  f.deps.testRunner = runner;
  f.deps.mainTestRunner = runner;
  return calls;
}

describe('production heavy runner failing TAP evidence', () => {
  it('retries a real nonzero-with-error run, then emits flaky-retried and syncs', async () => {
    const f = fixture(), calls = tapRunners(f, { flaky: true });
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(calls).toHaveLength(2);
    expect(calls[0].files).toHaveLength(3);
    expect(calls[1]).toMatchObject({ main: false, files: [failedFile], head: calls[0].head });
    expect(kinds(f)).toContain('overlay-main-flaky-retried');
    expect(kinds(f)).toContain('overlay-main-synced');
    expect(f.pushes).toHaveLength(1);
  });

  it('classifies the same nested assertion on merged tree and plain main as main-red', async () => {
    const f = fixture(), calls = tapRunners(f);
    expect(await job(f)).toMatchObject({ skipped: true, reason: 'main-red' });
    expect(calls.map(call => call.main)).toEqual([false, false, true]);
    expect(calls.slice(1).map(call => call.files)).toEqual([[failedFile], [failedFile]]);
    expect(kinds(f)).toContain('overlay-main-red');
    expect(f.outcomes.some(event => /failed|needs-you/.test(event.kind))).toBe(false);
    noPublication(f);
  });

  it.each([
    { mainTitle: 'different assertion' },
    { mainSuite: 'different suite' },
  ])('retains operator failure when main has a different assertion identity (%j)', async different => {
    const f = fixture(), calls = tapRunners(f, different);
    await expect(job(f)).rejects.toThrow(failure);
    expect(calls.map(call => call.main)).toEqual([false, false, true]);
    expect(kinds(f)).not.toContain('overlay-main-red');
    expect(f.outcomes.map(event => event.kind)).toContain('overlay-main-sync-failed');
    noPublication(f);
  });

  it.each([
    ['incomplete plan', stdout => stdout.replace('1..3', '1..4')],
    ['missing typed count', stdout => stdout.replace(/^      Tests  .*$/m, '')],
    ['oversized inventory', stdout => stdout + ' '.repeat(8 * 1024 * 1024)],
  ])('fails closed with operator review for nonzero-with-error and %s', async (_, corrupt) => {
    const f = fixture(), calls = tapRunners(f, { corrupt });
    await expect(job(f)).rejects.toThrow(/operator review required/);
    expect(calls).toHaveLength(1);
    expect(kinds(f)).not.toContain('overlay-main-red');
    expect(kinds(f)).not.toContain('overlay-main-flaky-retried');
    noPublication(f);
  });
});

describe('overlay main sync failed-file reruns', () => {
  it.each([0, 1])('flaky pass emits retried event and ends synced with push (initial exit %i)', async status => {
    const f = fixture(), trees = runners(f, ['failed', 'passed'], 'passed', status);
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(f.deps.testRunner).toHaveBeenCalledTimes(2);
    sameMergedTree(trees);
    expect(f.deps.mainTestRunner).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(expect.objectContaining({
      kind: 'overlay-main-flaky-retried', ref, files: [failedFile],
    }));
    expect(kinds(f).indexOf('overlay-main-flaky-retried')).toBeLessThan(kinds(f).indexOf('overlay-main-synced'));
    expect(f.outcomes.map(event => event.kind)).toContain('overlay-main-sync-synced');
    expect(f.outcomes.map(event => event.kind)).not.toContain('overlay-main-sync-failed');
    expect(f.pushes).toHaveLength(1);
  });

  it('reruns only failed files, excluding the two passing files in the chunk', async () => {
    const f = fixture(); runners(f, ['failed', 'passed']);
    await job(f);
    expect(selectedFiles(f.deps.testRunner.mock.calls[0][0])).toEqual([
      failedFile, 'worker1.test.mjs', 'worker2.test.mjs',
    ]);
    expect(selectedFiles(f.deps.testRunner.mock.calls[1][0])).toEqual([failedFile]);
  });

  it('persistent failure also red on plain main emits main-red, with no failed outcome, needs-you or push', async () => {
    const f = fixture(), trees = runners(f, ['failed', 'failed'], 'failed');
    expect(await job(f)).toMatchObject({ skipped: true, reason: 'main-red' });
    expect(f.deps.testRunner).toHaveBeenCalledTimes(2);
    sameMergedTree(trees);
    expect(f.deps.mainTestRunner).toHaveBeenCalledOnce();
    expect(f.events).toContainEqual(expect.objectContaining({ kind: 'overlay-main-red', ref, files: [failedFile] }));
    expect(f.outcomes.some(event => /failed|needs-you/.test(event.kind))).toBe(false);
    const alerts = alertsFilePath(f.root, f.env);
    expect(fs.existsSync(alerts) ? fs.readFileSync(alerts, 'utf8') : '').not.toContain('needs-you');
    expect(fs.existsSync(f.env.WE_NEEDS_YOU_FEED) ? fs.readFileSync(f.env.WE_NEEDS_YOU_FEED, 'utf8') : '').not.toContain('needs-you');
    noPublication(f);
  });

  it('persistent failure with green main fails exactly as today after one main comparison', async () => {
    const f = fixture(); runners(f, ['failed', 'failed']);
    await expect(job(f)).rejects.toThrow(failure);
    expect(f.deps.testRunner).toHaveBeenCalledTimes(2);
    expect(f.deps.mainTestRunner).toHaveBeenCalledOnce();
    expect(f.outcomes.map(event => event.kind)).toContain('overlay-main-sync-failed');
    expect(kinds(f)).not.toContain('overlay-main-red');
    noPublication(f);
  });

  it.each(['missing', 'empty'])('not-executed evidence on rerun (%s) is not a pass', async evidence => {
    const f = fixture(); runners(f, ['failed', evidence]);
    await expect(job(f)).rejects.toThrow(failure);
    expect(f.deps.testRunner).toHaveBeenCalledTimes(2);
    expect(f.deps.mainTestRunner).toHaveBeenCalledOnce();
    expect(kinds(f)).not.toContain('overlay-main-flaky-retried');
    noPublication(f);
  });

  it.each(['missing', 'empty'])('not-executed evidence on main (%s) fails closed instead of declaring main-red', async evidence => {
    const f = fixture(); runners(f, ['failed', 'failed'], evidence);
    await expect(job(f)).rejects.toThrow(failure);
    expect(f.deps.mainTestRunner).toHaveBeenCalledOnce();
    expect(kinds(f)).not.toContain('overlay-main-red');
    noPublication(f);
  });

  it('flakeReruns=0 disables reruns and main comparison and fails as today', async () => {
    const f = fixture({ reruns: 0 }); runners(f, ['failed', 'passed']);
    await expect(job(f)).rejects.toThrow(failure);
    expect(f.deps.testRunner).toHaveBeenCalledOnce();
    expect(f.deps.mainTestRunner).not.toHaveBeenCalled();
    expect(f.outcomes.map(event => event.kind)).toContain('overlay-main-sync-failed');
    noPublication(f);
  });

  it('flakeReruns=2 permits two reruns on the same merged tree before syncing', async () => {
    const f = fixture({ reruns: 2 }), trees = runners(f, ['failed', 'failed', 'passed']);
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(f.deps.testRunner).toHaveBeenCalledTimes(3);
    sameMergedTree(trees);
    for (const [options] of f.deps.testRunner.mock.calls.slice(1)) expect(selectedFiles(options)).toEqual([failedFile]);
    expect(f.deps.mainTestRunner).not.toHaveBeenCalled();
    expect(kinds(f)).toContain('overlay-main-flaky-retried');
    expect(f.pushes).toHaveLength(1);
  });

  it('flakeReruns=2 stops after exactly two failing reruns then compares main once', async () => {
    const f = fixture({ reruns: 2 }); runners(f, ['failed', 'failed', 'failed']);
    await expect(job(f)).rejects.toThrow(failure);
    expect(f.deps.testRunner).toHaveBeenCalledTimes(3);
    expect(f.deps.mainTestRunner).toHaveBeenCalledOnce();
    noPublication(f);
  });
});

// Override only assertion evidence while retaining the real checkout and report path checks.
function assertionRunner(runner, assertions) {
  return async options => {
    const result = await runner(options);
    const evidence = json(options.testReport);
    evidence.testResults.find(r => r.name.endsWith(`/${failedFile}`)).assertionResults = assertions;
    fs.writeFileSync(options.testReport, JSON.stringify(evidence));
    return result;
  };
}
const failedAssertion = title => ({ status: 'failed', title, ancestorTitles: ['worker'] });

describe('main-red assertion identity and bookkeeping', () => {
  it.each([
    ['different assertion in the same file', [failedAssertion('overlay only')], [failedAssertion('main only')]],
    ['strict subset on main', [failedAssertion('shared'), failedAssertion('overlay only')], [failedAssertion('shared')]],
    ['same title under different ancestors', [failedAssertion('same')], [{ ...failedAssertion('same'), ancestorTitles: ['other'] }]],
    ['missing identity on merged tree', [{ status: 'failed' }], [failedAssertion('shared')]],
    ['missing identity on main', [failedAssertion('shared')], [{ status: 'failed' }]],
  ])('%s retains operator-review failure', async (_label, merged, main) => {
    const f = fixture(); runners(f, ['failed', 'failed'], 'failed');
    f.deps.testRunner = assertionRunner(f.deps.testRunner, merged);
    f.deps.mainTestRunner = assertionRunner(f.deps.mainTestRunner, main);
    await expect(job(f)).rejects.toThrow(failure);
    expect(kinds(f)).not.toContain('overlay-main-red');
    expect(f.outcomes.some(e => e.kind === 'overlay-main-sync-failed')).toBe(true);
    noPublication(f);
  });

  it.each(['fullName', 'title'])('main may have additional failures when every persistent %s identity matches', async form => {
    const f = fixture(); runners(f, ['failed', 'failed'], 'failed');
    const shared = form === 'fullName' ? { status: 'failed', fullName: 'worker shared' } : failedAssertion('shared');
    f.deps.testRunner = assertionRunner(f.deps.testRunner, [shared]);
    f.deps.mainTestRunner = assertionRunner(f.deps.mainTestRunner, [shared, failedAssertion('main only')]);
    expect(await job(f)).toMatchObject({ skipped: true, reason: 'main-red' });
    noPublication(f);
  });

  it.each(['main', 'tip'])('known main-red pair skips the second kick and reruns when %s moves', async moved => {
    const f = fixture(); runners(f, ['failed', 'failed'], 'failed');
    const spawnFn = vi.fn(() => ({ once: vi.fn(), unref: vi.fn() }));
    const kick = () => sync.kickOverlayMainSync({ root: f.root, env: f.env, mode: 'on',
      git: f.deps.git, spawnFn, deps: f.deps });
    expect(await job(f)).toMatchObject({ skipped: true, reason: 'main-red' });
    const saved = json(`${overlayFilePath(f.root, f.env)}.main-sync.state`);
    expect(saved.mainRedMain[ref]).toBe(f.mainSha);
    expect(saved.mainRedTip[ref]).toBe(ok(f.root, ['rev-parse', `origin/${ref}`]));
    expect(saved.attemptedMain[ref]).toBeUndefined();
    expect(saved.retryMain[ref]).toBeUndefined();
    expect(await job(f)).toMatchObject({ skipped: true, reason: 'main-red-known' });
    expect(f.deps.testRunner).toHaveBeenCalledTimes(2);
    expect(kick()).toMatchObject({ started: [], skipped: [ref] });
    expect(spawnFn).not.toHaveBeenCalled();
    const movedRef = moved === 'main' ? 'origin/main' : `origin/${ref}`;
    const previous = ok(f.root, ['rev-parse', movedRef]);
    const tree = ok(f.root, ['rev-parse', `${previous}^{tree}`]);
    const next = ok(f.root, ['commit-tree', tree, '-p', previous, '-m', 'advance pair']);
    ok(f.root, ['update-ref', `refs/remotes/${movedRef}`, next]);
    expect(kick()).toMatchObject({ started: [ref] });
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(f.outcomes.some(e => /failed|needs-you/.test(e.kind))).toBe(false);
    expect(fs.existsSync(f.env.WE_NEEDS_YOU_FEED) ? fs.readFileSync(f.env.WE_NEEDS_YOU_FEED, 'utf8') : '').not.toContain('needs-you');
    noPublication(f);
  });

  it('compares the final persistent rerun assertions rather than the initial failure', async () => {
    const f = fixture(); runners(f, ['failed', 'failed'], 'failed');
    const runner = f.deps.testRunner;
    let attempt = 0;
    f.deps.testRunner = options => assertionRunner(runner,
      [failedAssertion(attempt++ === 0 ? 'initial' : 'persistent')])(options);
    f.deps.mainTestRunner = assertionRunner(f.deps.mainTestRunner, [failedAssertion('initial')]);
    await expect(job(f)).rejects.toThrow(failure);
    expect(kinds(f)).not.toContain('overlay-main-red');
    noPublication(f);
  });

  it.each([
    { mainRedMain: { [ref]: 'a'.repeat(40) } },
    { mainRedTip: { [ref]: 'b'.repeat(40) } },
    { mainRedMain: { [ref]: 'invalid' }, mainRedTip: { [ref]: 'b'.repeat(40) } },
  ])('incomplete or invalid persisted main-red evidence fails closed (%j)', async state => {
    const f = fixture(); runners(f, ['failed', 'failed'], 'failed');
    fs.writeFileSync(`${overlayFilePath(f.root, f.env)}.main-sync.state`, JSON.stringify({ lastSyncedMain: {}, ...state }));
    await expect(job(f)).rejects.toThrow(/state.*operator repair required/);
    expect(f.deps.testRunner).not.toHaveBeenCalled();
    noPublication(f);
  });

  it('flaky-retried event includes the effective rerun value and source', async () => {
    const f = fixture({ reruns: 2 }); runners(f, ['failed', 'passed']);
    expect(await job(f)).toMatchObject({ pushed: true });
    expect(f.events).toContainEqual(expect.objectContaining({
      kind: 'overlay-main-flaky-retried', flakeReruns: 2, flakeRerunsSource: 'env',
    }));
  });
});

describe('resolveOverlayFlakeReruns policy cascade', () => {
  function policy() {
    const base = temp(), settingsPath = join(base, 'settings.json');
    const preferences = join(base, 'preferences.json');
    const env = { WE_PLATFORM_PREFERENCES_FILE: preferences };
    const resolve = (overrides = {}) => sync.resolveOverlayFlakeReruns({ ...env, ...overrides }, { settingsPath });
    return { base, settingsPath, preferences, resolve };
  }

  it('defaults to one rerun with standard provenance when settings are absent', () => {
    expect(policy().resolve()).toEqual({ value: 1, source: 'standard' });
  });

  it('resolves overlay.mainSync.flakeReruns through platform, tool and environment layers', () => {
    const p = policy();
    fs.writeFileSync(p.preferences, JSON.stringify({ overlay: { mainSync: { flakeReruns: 2 } } }));
    expect(p.resolve()).toEqual({ value: 2, source: 'platform' });
    fs.writeFileSync(p.settingsPath, JSON.stringify({ overlay: { mainSync: { flakeReruns: 0 } } }));
    expect(p.resolve()).toEqual({ value: 0, source: 'tool' });
    expect(p.resolve({ WE_DAEMON_OVERLAY_MAIN_SYNC_FLAKE_RERUNS: '1' })).toEqual({ value: 1, source: 'env' });
  });

  it.each(['0', '1', '2'])('accepts environment override %s with env provenance', value => {
    expect(policy().resolve({ WE_DAEMON_OVERLAY_MAIN_SYNC_FLAKE_RERUNS: value }))
      .toEqual({ value: Number(value), source: 'env' });
  });

  it.each(['', '-1', '1.5', 'bogus', 'Infinity', '9007199254740992'])('invalid environment value %j falls back to default one', value => {
    expect(policy().resolve({ WE_DAEMON_OVERLAY_MAIN_SYNC_FLAKE_RERUNS: value }))
      .toEqual({ value: 1, source: 'standard' });
  });

  it.each([-1, 1.5, 'bogus', null, true, 9007199254740992])('invalid settings value %j falls back to default one', value => {
    const p = policy();
    fs.writeFileSync(p.settingsPath, JSON.stringify({ overlay: { mainSync: { flakeReruns: value } } }));
    expect(p.resolve()).toEqual({ value: 1, source: 'standard' });
  });

  it('logs the effective rerun setting and its source', () => {
    const p = policy(), log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(p.resolve({ WE_DAEMON_OVERLAY_MAIN_SYNC_FLAKE_RERUNS: '2', WE_POLICY_CASCADE_LOG: '1' }))
      .toEqual({ value: 2, source: 'env' });
    expect(log.mock.calls.flat().join('\n')).toMatch(/(?:flakeReruns|FlakeReruns).*2.*env/);
  });
});
