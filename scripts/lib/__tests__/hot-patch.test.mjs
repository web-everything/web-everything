import { vi } from 'vitest';
/** @file hot-patch.test.mjs - R1100 decisions, durable rollback and bounded wake regressions. */
import { test as nodeTest } from 'node:test';
const test = process.env.VITEST ? (await import('vitest')).test : nodeTest;
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGhSync } from '../gh-throttle.mjs';
vi.mock('../gh-throttle.mjs', async importOriginal => ({ ...(await importOriginal()), runGhSync: vi.fn() }));
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { classifyHotPatch, requestHotPatch, readHotPatch, hotPatchPath, evaluateOwed, openHotPatchWatch,
  recordVerifyResult, recordHotPatchPr, runOwedTick, closeHotPatch } from '../hot-patch.mjs';
import { hotPatchDefaults, resolveHotPatchSettings } from '../hot-patch-settings.mjs';
import { evaluateForceWatch, readForceWatch, runForceWatchTick, watchPath, transitionWatch } from '../daemon-force-adopt.mjs';
import { addOverlay, readOverlays } from '../daemon-overlays.mjs';
import { createMainMoveReader, createEarlyLaunchWatcher } from '../daemon-rebuild-early-watch.mjs';
import { rebuildCloneAsJob, REBUILD_JOB_KIND } from '../daemon-rebuild/rebuild-job.mjs';
import { createJobStore, enqueueJob } from '../daemon-jobs-runtime.mjs';
import { markSucceeded } from '../daemon-jobs.mjs';
import { main, easternIso } from '../../hot-patch.mjs';

let sha = 'b'.repeat(40), good = 'a'.repeat(40);
const at = 1700000000000;
const verifiedPr = () => ({ status: 0, stdout: JSON.stringify({ headRefName: 'lane/repair', headRefOid: sha, state: 'OPEN' }) });
const verifyMarker = (env, sha, result) => {
  env.WE_HOT_PATCH = JSON.stringify({ verifyRepo: 'owner/repo' });
  runGhSync.mockReturnValue(JSON.stringify([{ id: 1, name: 'test', head_sha: sha,
    app: { id: 15368, slug: 'github-actions' }, status: 'completed', conclusion: result === 'red' ? 'failure' : 'success' }]));
};
const fixture = fn => async () => {
  const home = mkdtempSync(join(tmpdir(), 'hot-patch-'));
  const origin = join(home, 'origin'), root = join(home, 'clone');
  const git = (args, cwd = home) => {
    const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-q', '-b', 'main', origin]);
  writeFileSync(join(origin, 'README.md'), 'base\n'); git(['add', '.'], origin); git(['commit', '-qm', 'base'], origin);
  git(['clone', '-q', origin, root]); good = git(['rev-parse', 'HEAD'], root);
  git(['checkout', '-qb', 'lane/repair'], root);
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  writeFileSync(join(root, 'scripts/lib/daemon-tool.mjs'), 'export const fix = true;\n');
  git(['add', '.'], root); git(['commit', '-qm', 'patch'], root); sha = git(['rev-parse', 'HEAD'], root);
  const env = { HOME: root, WE_DAEMON_STATE_DIR: join(root, 'state'), WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
    WE_DAEMON_CLONE_LOCK_ROOT: join(root, 'locks'), WE_DAEMON_EVENTS: join(root, 'events.jsonl'),
    WE_FORCE_ADOPT_HANDOFF: join(root, 'handoff.md'), WE_FORCE_ADOPT_CORONER: join(root, 'coroner.jsonl'),
    WE_PLATFORM_PREFERENCES_FILE: join(root, 'platform.json'), WE_POLICY_CASCADE_LOG: '0' };
  const events = [], emit = async e => { events.push(e); return true; };
  const request = { root, env, sha, daemon: 'review', branch: 'lane/repair', files: ['scripts/lib/daemon-tool.mjs'],
    kind: 'daemon-tooling', now: () => at, emit };
  const plan = { finalSha: sha, applied: [{ ref: request.branch, sha }] };
  const arm = () => openHotPatchWatch({ root, env, plan, lastGood: { head: good }, smokePassed: true, now: () => at });
  try { await fn({ root, env, events, emit, request, plan, arm, git: args => git(args, root) }); }
  finally { rmSync(home, { recursive: true, force: true }); }
};

for (const path of ['scripts/security.mjs', 'scripts/lib/credentials.mjs', 'config/secrets.json', '.env.local',
  '.claude/hooks/check.mjs', 'scripts/hooks/check.mjs', 'scripts/guard-anything.mjs', 'scripts/pr-merge-gate.mjs',
  'scripts/lib/verify-receipts.mjs', 'scripts/guard-delivery-mode.mjs', 'scripts/state-migrations/001.mjs',
  'scripts/lib/drain-gate.mjs']) {
  test(`never-patch touch class refuses ${path}`, () => {
    assert.equal(classifyHotPatch({ files: [path], kind: 'incident' }).ok, false);
  });
}
test('checklist-7: unknown, oversized and malformed classifier evidence refuses with fallback', () => {
  assert.equal(classifyHotPatch({ files: ['scripts/lib/daemon-tool.mjs'], kind: 'daemon-tooling' }).ok, true);
  for (const files of [[], undefined, Array(hotPatchDefaults.maxFiles + 1).fill('a'), ['a'.repeat(hotPatchDefaults.maxPathChars + 1)],
    ['../a'], ['/etc/a'], ['scripts/*.mjs'], ['x\ny'], ['we:scripts/a']]) {
    assert.equal(classifyHotPatch({ files, kind: 'incident' }).ok, false);
  }
  assert.equal(classifyHotPatch({ files: ['a'], kind: 'feature' }).reason, 'ineligible-kind');
  assert.equal(classifyHotPatch({ files: ['scripts/verify.mjs'], kind: 'incident', settings: { ...hotPatchDefaults, neverPatchPaths: [] } }).ok, false);
});

test('settings use cascade provenance and retain never-patch floor', fixture(({ env }) => {
  writeFileSync(env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ hotPatch: { ticks: 12, wake: false } }));
  const logs = [];
  const settings = resolveHotPatchSettings({ env: { ...env, WE_HOT_PATCH: '{"ticks":14,"queueExemptionMinutes":60,"ciUnknownMaxTicks":4}', WE_POLICY_CASCADE_LOG: '1' },
    tool: { owedPrMinutes: 30, neverPatchPaths: ['extra/**'] }, log: line => logs.push(line) });
  assert.equal(settings.ticks, 14); assert.equal(settings.wake, false); assert.equal(settings.owedPrMinutes, 30);
  assert(settings.neverPatchPaths.includes('extra/**')); assert(settings.neverPatchPaths.includes('scripts/guard-*'));
  assert.match(logs.join('\n'), /ticks=14.*env/);
  assert.equal(settings.ciUnknownMaxTicks, 4);
  assert.match(logs.join('\n'), /ciUnknownMaxTicks=4.*env/);
  assert.equal(hotPatchDefaults.ciUnknownMaxTicks, 6);
  assert.equal(hotPatchDefaults.queueExemptionMinutes, 120);
  assert.equal(settings.queueExemptionMinutes, 60);
  assert.match(logs.join('\n'), /queueExemptionMinutes=60.*env/);
}));

test('checklist-4: concurrent requests for one daemon open exactly once; dry-run and deadlines', fixture(async ({ request, events, env, root }) => {
  assert.equal((await requestHotPatch({ ...request, sha: 'short' })).ok, false);
  assert.equal((await requestHotPatch({ ...request, dryRun: true })).ok, true);
  assert.equal(readHotPatch(root, env), null); assert.equal(events.length, 0);
  const results = await Promise.all([requestHotPatch(request), requestHotPatch(request)]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(events[0].kind, 'hot-patch-loaded');
  assert.equal((await requestHotPatch({ ...request, now: () => at + 120 * 60000 })).reason, 'owed-deadline-missed');
}));

test('checklist-2: unreadable ledger and watch refuse without replacement', fixture(async ({ request, root, env }) => {
  mkdirSync(env.WE_DAEMON_STATE_DIR);
  writeFileSync(hotPatchPath(root, env), '{bad');
  assert.equal((await requestHotPatch(request)).ok, false);
  rmSync(hotPatchPath(root, env)); writeFileSync(watchPath(root, env), '{bad');
  assert.equal((await requestHotPatch(request)).ok, false);
}));

test('owed decisions: ok, PR missing, verify missing, merge rollback and queue exemption', () => {
  const record = { owed: { prBy: new Date(at + 120 * 60000).toISOString(), mergeBy: new Date(at + 24 * 3600000).toISOString(), pr: null, verify: 'pending' } };
  assert.equal(evaluateOwed({ record, now: at }), 'ok');
  assert.equal(evaluateOwed({ record, now: at + 120 * 60000 }), 'block-new');
  record.owed.pr = 42;
  assert.equal(evaluateOwed({ record, now: at + 120 * 60000 }), 'block-new');
  record.owed.verify = 'green';
  assert.equal(evaluateOwed({ record, now: at + 120 * 60000 }), 'ok');
  assert.equal(evaluateOwed({ record, now: at + 24 * 3600000 }), 'rollback');
  record.inMergeQueue = true;
  record.inMergeQueueAt = new Date(at + 24 * 3600000).toISOString();
  assert.equal(evaluateOwed({ record, now: at + 24 * 3600000 }), 'ok');
  record.owed.verify = 'pending';
  assert.equal(evaluateOwed({ record, now: at + 24 * 3600000 }), 'block-new');
  assert.equal(evaluateOwed({ record: {}, now: at }), 'block-new');
});

test('matching smoke pass arms 10 ticks AND 15 minutes; old force records still retire by ticks', fixture(async ({ request, arm, root, env, plan }) => {
  await requestHotPatch(request); assert.equal(arm().ok, true);
  let watch = readForceWatch(root, env);
  assert.equal(watch.ticksLeft, 10); assert.equal(Date.parse(watch.minUntil), at + 15 * 60000);
  for (let i = 0; i < 12; i++) { const v = evaluateForceWatch({ watch, healthy: true, now: at + i }); assert.equal(v.action, 'continue'); watch = v.watch; }
  assert.equal(evaluateForceWatch({ watch, healthy: true, now: at + 15 * 60000 }).action, 'continue');
  assert.equal(evaluateForceWatch({ watch: { ...watch, ciState: 'green' }, healthy: true, now: at + 15 * 60000 }).action, 'done');
  assert.equal(evaluateForceWatch({ watch: { ticksLeft: 2 }, healthy: true, now: at + 10000000 }).action, 'continue');
  assert.equal(evaluateForceWatch({ watch: { ticksLeft: 1 }, healthy: true, now: at }).action, 'done');
  assert.equal(evaluateForceWatch({ watch: { ticksLeft: 0, minUntil: 'bad' }, healthy: true }).action, 'continue');
  assert.equal(openHotPatchWatch({ root, env, plan: { ...plan, finalSha: 'c'.repeat(40), applied: [] }, smokePassed: false }).ok, false);
}));

test('checklist-2: missing lastGood, failed smoke, corrupt watch and red verify refuse adoption', fixture(async ({ root, env, request, plan, arm }) => {
  await requestHotPatch(request);
  assert.equal(openHotPatchWatch({ root, env, plan, smokePassed: true }).ok, false);
  assert.equal(openHotPatchWatch({ root, env, plan, lastGood: { head: good }, smokePassed: false }).ok, false);
  assert.equal(readForceWatch(root, env), null);
  writeFileSync(watchPath(root, env), '{bad'); assert.equal(arm().ok, false);
  writeFileSync(watchPath(root, env), JSON.stringify({ hotPatchSha: sha })); assert.equal(arm().ok, false);
  rmSync(watchPath(root, env));
  verifyMarker(env, sha, 'red');
  await recordVerifyResult({ root, env, sha, removeOverlay: () => {} });
  assert.equal(arm().ok, false);
}));

test('red verify withdraws overlay, marks watch, rollback failure stays owed, healthy next tick still reverts', fixture(async ({ root, env, request, arm, emit }) => {
  addOverlay(root, { ref: request.branch, pinned: true }, { env });
  await requestHotPatch(request); arm();
  verifyMarker(env, sha, 'red');
  assert.equal((await recordVerifyResult({ root, env, sha, emit })).ok, true);
  assert.equal(readOverlays(root, { env }).length, 0);
  assert.equal(readForceWatch(root, env).rollbackPending, 'verify-red');
  const args = { root, env, currentHead: sha, probe: async () => ({ healthy: true }), emit, now: () => at + 1 };
  assert.equal((await runForceWatchTick({ ...args, rollback: async () => ({ ok: false }) })).action, 'rollback-failed');
  let reverted;
  const result = await runForceWatchTick({ ...args, rollback: async last => { reverted = last.head; return { ok: true }; } });
  assert.equal(result.action, 'rollback'); assert.equal(reverted, good); assert.equal(readForceWatch(root, env), null);
}));

test('late red recreates watch after health watch passes; later green cannot waive rollback', fixture(async ({ request, root, env, arm }) => {
  await requestHotPatch(request); arm();
  verifyMarker(env, sha, 'green');
  await runOwedTick({ root, env, now: at });
  for (let i = 0; i < 10; i++) await runForceWatchTick({ root, env, currentHead: sha, probe: async () => ({ healthy: true }), now: () => at + 15 * 60000 });
  assert.equal(readForceWatch(root, env), null);
  verifyMarker(env, sha, 'red');
  await recordVerifyResult({ root, env, sha });
  verifyMarker(env, sha, 'green');
  await recordVerifyResult({ root, env, sha });
  assert.equal(readForceWatch(root, env).rollbackPending, 'verify-red');
  assert.equal(readHotPatch(root, env).owed.verify, 'red');
}));

test('PR linkage updates pinned registration; owed tick withdraws and watches; close clears ledger', fixture(async ({ root, env, request, arm, emit, events }) => {
  addOverlay(root, { ref: request.branch, pinned: true }, { env });
  await requestHotPatch(request); arm();
  assert.equal(recordHotPatchPr({ root, env, sha: good, pr: 42 }).ok, false);
  assert.equal(recordHotPatchPr({ root, env, sha, pr: 42, run: verifiedPr, inMergeQueue: false }).ok, true);
  assert.equal(readOverlays(root, { env })[0].pr, 42);
  assert.equal(await runOwedTick({ root, env, now: () => at + 24 * 3600000, emit }), 'rollback');
  assert.equal(readOverlays(root, { env }).length, 0);
  assert.equal(readForceWatch(root, env).rollbackPending, 'owed-merge-deadline');
  await closeHotPatch({ root, env, sha, reason: 'merged', emit });
  assert.equal(readHotPatch(root, env), null); assert.equal(events.at(-1).kind, 'hot-patch-closed');
}));

test('hot-patch-loaded producer wakes with earlyLaunch disabled, skips debounce and rate limits', fixture(async ({ root, env, request }) => {
  let clock = at;
  const read = createMainMoveReader({ env, root, now: () => clock });
  const launches = [];
  const w = createEarlyLaunchWatcher({ settings: { enabled: false, debounceMs: 9999999, hotPatch: hotPatchDefaults },
    readSignal: read, now: () => clock, inFlight: () => false, launch: o => launches.push(o), schedule: () => null });
  await requestHotPatch({ ...request, emit: undefined });
  await w.poll(); assert.equal(launches.length, 1); assert.equal(launches[0].launchedBy, 'hot-patch');
  const line = JSON.stringify({ kind: 'hot-patch-loaded', repo: 'web-everything', detail: { root, sha } }) + '\n';
  appendFileSync(env.WE_DAEMON_EVENTS, line); clock += 1;
  await w.poll(); assert.equal(launches.length, 1);
  clock = at + 120000; await w.poll(); assert.equal(launches.length, 2);
  appendFileSync(env.WE_DAEMON_EVENTS, JSON.stringify({ kind: 'hot-patch-loaded', repo: 'web-everything', detail: { root: join(root, 'other'), sha } }) + '\n');
  clock += 120000; await w.poll(); assert.equal(launches.length, 2);
}));

test('hot-patch wake bypasses 15-minute job cooldown once; matching SHA and two-minute rate bound required', fixture(async ({ root, env, request, plan }) => {
  await requestHotPatch(request);
  mkdirSync(join(root, 'jobs'));
  const store = createJobStore(join(root, 'jobs'));
  const seed = enqueueJob({ store, kindDef: REBUILD_JOB_KIND, codeSha: good, input: { root }, now: at - 2000 });
  store.update(seed.id, r => markSucceeded(r, { at: new Date(at - 1000).toISOString() }));
  let clock = at;
  const launch = p => rebuildCloneAsJob({ root, env, store, entries: [], codeSha: good, now: () => clock,
    adopt: async () => ({ reason: 'needs-build', plan: p }), reattach: async () => ({}), evict: () => ({}),
    log: { error() {} }, settings: { entries: [], minIntervalMs: 900000, minIntervalJitterPct: 0 } });
  assert.equal((await launch({ finalSha: good, applied: [] })).reason, 'rebuild-job-spaced');
  const first = await launch(plan); assert.equal(first.reason, 'rebuild-job-started');
  store.update(first.job.id, r => markSucceeded(r, { at: new Date(clock).toISOString() }));
  clock += 119999; assert.equal((await launch(plan)).reason, 'rebuild-job-spaced');
  clock += 1; assert.equal((await launch(plan)).reason, 'rebuild-job-started');
}));

test('CLI refuses ineligible request before registration and status uses ET ISO with watch deadlines', fixture(async ({ root, env, request, arm }) => {
  let output = '', error = '', calls = 0;
  const deps = { cwd: root, env, run: () => { calls++; throw new Error('unexpected command'); }, stdout: s => { output += s; }, stderr: s => { error += s; } };
  assert.equal(await main(['request', '--daemon', root, '--branch', request.branch, '--sha', sha, '--kind', 'feature', '--files', 'a'], deps), 1);
  assert.equal(calls, 0); assert.match(error, /ineligible-kind/);
  await requestHotPatch(request); arm(); output = '';
  assert.equal(await main(['status', '--daemon', root], deps), 0);
  const status = JSON.parse(output)[0]; assert.equal(status.watch.ticksLeft, 10);
  assert.match(status.owed.prBy, /T.*-05:00$/);
  assert.match(easternIso('2026-07-01T12:00:00Z'), /-04:00$/);
}));

// Real commit trees and diff output; registration alone is injected to avoid remote IO.
function cliGitFixture({ root, env }, baseFiles = { 'README.md': 'base\n' }) {
  const cwd = join(root, 'checkout'); mkdirSync(cwd);
  const gitEnv = { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-gitconfig') };
  const git = args => {
    const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args],
      { cwd, env: gitEnv, encoding: 'utf8', timeout: hotPatchDefaults.ioTimeoutMs, maxBuffer: hotPatchDefaults.maxOutputBytes });
    assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout.trim();
  };
  const put = (name, content) => {
    const path = join(cwd, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content);
  };
  const commit = () => { git(['add', '--all']); git(['commit', '-q', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  git(['init', '-q', '-b', 'main']);
  for (const [name, content] of Object.entries(baseFiles)) put(name, content);
  const base = commit(); git(['update-ref', 'refs/remotes/origin/main', base]);
  let registrations = 0, output = '', error = '';
  const calls = [];
  const deps = { cwd, env: gitEnv, stdout: s => { output += s; }, stderr: s => { error += s; }, run: (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === 'git') return spawnSync(cmd, args, options);
    assert.equal(cmd, process.execPath); assert(args.includes('add')); assert(args.includes('--pinned'));
    const record = readHotPatch(root, env);
    assert.equal(record.daemon, root); assert.equal(record.sha, args.find(a => a.startsWith('--expected-sha=')).split('=')[1]);
    assert(args.includes('--allow-no-pr'));
    registrations++;
    addOverlay(root, { ref: 'lane/repair', pinned: true }, { env });
    return { status: 0, stdout: '{}', stderr: '' };
  } };
  const argv = (sha, files) => ['request', '--daemon', root, '--branch', 'lane/repair', '--sha', sha, '--kind', 'daemon-tooling',
    ...(files === undefined ? [] : ['--files', files])];
  return { cwd, git, put, commit, base, deps, argv, calls, registrations: () => registrations,
    output: () => output, error: () => error };
}

for (const protectedPath of ['scripts/security.mjs', 'scripts/lib/verify-receipts.mjs']) {
  test(`CLI falsified --files cannot authorize a commit containing ${protectedPath}`, fixture(async f => {
    const c = cliGitFixture(f);
    c.put('scripts/lib/daemon-tool.mjs', 'export const fix = true;\n');
    c.put(protectedPath, 'export const protection = false;\n');
    const sha = c.commit();
    assert.equal(await main(c.argv(sha, 'scripts/lib/daemon-tool.mjs'), c.deps), 1);
    assert.match(c.error(), /complete commit diff/);
    assert.equal(await main(c.argv(sha), c.deps), 1);
    assert.match(c.error(), /never-patch-touch-set/);
    assert.equal(c.registrations(), 0); assert.equal(readHotPatch(f.root, f.env), null);
    assert.deepEqual(readOverlays(f.root, { env: f.env }), []);
  }));
}

for (const [oldPath, newPath] of [
  ['scripts/lib/verify-receipts.mjs', 'scripts/lib/daemon-tool.mjs'],
  ['scripts/lib/daemon-tool.mjs', 'scripts/lib/verify-receipts.mjs'],
]) {
  test(`CLI rename evidence includes protected endpoint: ${oldPath} -> ${newPath}`, fixture(async f => {
    const c = cliGitFixture(f, { [oldPath]: 'export const renamed = true;\n' });
    c.git(['mv', oldPath, newPath]); const sha = c.commit();
    assert.equal(await main(c.argv(sha, 'scripts/lib/daemon-tool.mjs'), c.deps), 1);
    assert.match(c.error(), /complete commit diff/);
    assert.equal(await main(c.argv(sha, `${oldPath},${newPath}`), c.deps), 1);
    assert.match(c.error(), /never-patch-touch-set/);
    assert.equal(c.registrations(), 0); assert.equal(readHotPatch(f.root, f.env), null);
  }));
}

for (const supplied of [false, true]) {
  test(`CLI registers eligible real commit using complete diff (supplied=${supplied})`, fixture(async f => {
    const c = cliGitFixture(f), path = 'scripts/lib/daemon-tool.mjs';
    c.put(path, 'export const fix = true;\n'); const sha = c.commit();
    assert.equal(await main(c.argv(sha, supplied ? path : undefined), c.deps), 0, c.error());
    assert.equal(c.registrations(), 1); assert.equal(readHotPatch(f.root, f.env).sha, sha);
    const diff = c.calls.find(call => call.args.includes('diff'));
    assert(diff.args.includes(`${c.base}..${sha}`)); assert(diff.args.includes('--no-renames'));
    assert(diff.args.includes('--no-replace-objects')); assert.equal(diff.options.env.GIT_NO_LAZY_FETCH, '1');
    assert(c.calls.find(call => call.cmd === process.execPath).args.includes(`--expected-sha=${sha}`));
  }));
}

test('CLI pins trusted base before diff even if origin/main moves during the proof', fixture(async f => {
  const c = cliGitFixture(f);
  c.put('scripts/lib/daemon-tool.mjs', 'export const fix = true;\n'); c.put('scripts/security.mjs', 'unsafe\n');
  const sha = c.commit(), run = c.deps.run;
  c.deps.run = (cmd, args, opts) => {
    if (cmd === 'git' && args.includes('diff')) c.git(['update-ref', 'refs/remotes/origin/main', sha]);
    return run(cmd, args, opts);
  };
  assert.equal(await main(c.argv(sha, 'scripts/lib/daemon-tool.mjs'), c.deps), 1);
  assert.match(c.error(), /complete commit diff/); assert.equal(c.registrations(), 0);
  assert(c.calls.find(call => call.args.includes('diff')).args.includes(`${c.base}..${sha}`));
}));

test('CLI complete diff cannot hide protected paths through relative-diff configuration', fixture(async f => {
  const c = cliGitFixture(f);
  c.put('scripts/lib/daemon-tool.mjs', 'export const fix = true;\n'); c.put('scripts/security.mjs', 'unsafe\n');
  const sha = c.commit(); c.git(['config', 'diff.relative', 'true']);
  c.deps.cwd = join(c.cwd, 'scripts/lib');
  assert.equal(await main(c.argv(sha), c.deps), 1);
  assert.match(c.error(), /never-patch-touch-set/); assert.equal(c.registrations(), 0);
  assert.equal(readHotPatch(f.root, f.env), null);
}));

for (const missing of ['base', 'commit', 'incomplete-diff', 'oversized-output']) {
  test(`CLI fails closed on ${missing} evidence before registration with ordinary-delivery fallback`, fixture(async f => {
    const c = cliGitFixture(f);
    c.put(`scripts/${'a'.repeat(100)}.mjs`, 'one\n'); c.put(`scripts/${'b'.repeat(100)}.mjs`, 'two\n');
    let sha = c.commit();
    if (missing === 'base') c.git(['update-ref', '-d', 'refs/remotes/origin/main']);
    if (missing === 'commit') sha = 'c'.repeat(40);
    if (missing === 'incomplete-diff') {
      const run = c.deps.run;
      c.deps.run = (cmd, args, opts) => cmd === 'git' && args.includes('diff')
        ? { status: 0, stdout: 'scripts/lib/daemon-tool.mjs', stderr: '' } : run(cmd, args, opts);
    }
    if (missing === 'oversized-output') c.deps.env = { ...c.deps.env, WE_HOT_PATCH: '{"maxOutputBytes":128}' };
    assert.equal(await main(c.argv(sha), c.deps), 1);
    assert.match(c.error(), /ordinary delivery/); assert.equal(c.registrations(), 0);
    assert.equal(readHotPatch(f.root, f.env), null);
  }));
}


test('checklist-2: missing owed record cannot adopt a registered hot-patch', fixture(({ root, env, request, plan }) => {
  addOverlay(root, { ref: request.branch, pinned: true, reason: 'R1100 hot-patch' }, { env });
  for (const candidate of [plan, { ...plan, applied: [] }])
    assert.equal(openHotPatchWatch({ root, env, plan: candidate, lastGood: { head: good }, smokePassed: true }).ok, false);
  assert.equal(readForceWatch(root, env), null);
}));

for (const evidence of ['record', 'watch']) {
  test(`checklist-4: ${evidence} appearing during wake is re-read and refuses publication`, fixture(async ({ root, env, request }) => {
    const result = await requestHotPatch({ ...request, emit: async () => {
      if (evidence === 'record') writeFileSync(hotPatchPath(root, env), JSON.stringify({ ...request,
        loadedAt: new Date(at).toISOString(), owed: { prBy: new Date(at + 1).toISOString(),
          mergeBy: new Date(at + 2).toISOString(), pr: null, verify: 'pending' }, daemon: 'concurrent' }));
      else writeFileSync(watchPath(root, env), JSON.stringify({ sha: good, version: 1 }));
      return true;
    } });
    assert.equal(result.ok, false);
    assert.equal(readHotPatch(root, env)?.daemon ?? null, evidence === 'record' ? 'concurrent' : null);
    assert.equal(existsSync(`${hotPatchPath(root, env)}.pending`), false);
  }));
}

test('checklist-5: moved real clone HEAD cannot arm or retarget a hot-patch rollback', fixture(async ({ root, env, request, arm, git }) => {
  await requestHotPatch(request);
  git(['commit', '--allow-empty', '-qm', 'successor']); const successor = git(['rev-parse', 'HEAD']);
  assert.equal(arm().ok, false); assert.equal(readForceWatch(root, env), null);
  git(['reset', '--hard', sha]); assert.equal(arm().ok, true);
  verifyMarker(env, sha, 'red');
  await recordVerifyResult({ root, env, sha });
  git(['reset', '--hard', successor]);
  const out = await runForceWatchTick({ root, env, currentHead: () => git(['rev-parse', 'HEAD']),
    probe: async () => ({ healthy: false }), rollback: async () => { assert.fail('rollback of successor'); } });
  assert.equal(out.action, 'superseded'); assert.equal(git(['rev-parse', 'HEAD']), successor);
  assert.equal(readForceWatch(root, env).sha, sha);
}));

test('checklist-5: non-40-hex request and adoption heads refuse', fixture(async ({ request, root, env, plan }) => {
  for (const bad of ['short', 'z'.repeat(40)]) assert.equal((await requestHotPatch({ ...request, sha: bad })).ok, false);
  await requestHotPatch(request);
  assert.equal(openHotPatchWatch({ root, env, plan: { ...plan, finalSha: 'short' }, lastGood: { head: good }, smokePassed: true }).ok, false);
  assert.equal(readForceWatch(root, env), null);
}));

test('checklist-7: unreadable settings and malformed classifier settings refuse', fixture(async ({ request, env, root }) => {
  mkdirSync(env.WE_PLATFORM_PREFERENCES_FILE);
  await assert.rejects(requestHotPatch(request), /unreadable.*settings/);
  assert.equal(readHotPatch(root, env), null);
  for (const input of [null, 'bad', []]) assert.equal(classifyHotPatch(input).ok, false);
  for (const settings of [null, {}, { eligibleKinds: null }])
    assert.equal(classifyHotPatch({ files: ['scripts/a.mjs'], kind: 'incident', settings }).ok, false);
}));

for (const failure of ['overlay', 'event']) {
  test(`checklist-8: failed ${failure} leaves no open record or reservation`, fixture(async ({ root, env, request }) => {
    const out = await requestHotPatch({ ...request,
      ...(failure === 'overlay' ? { registerOverlay: () => { addOverlay(root, { ref: request.branch, pinned: true, reason: 'R1100 hot-patch' }, { env }); throw new Error('overlay failed'); } }
        : { emit: () => { assert.equal(readHotPatch(root, env).sha, request.sha);
          assert.equal(readOverlays(root, { env }).length, 1); throw new Error('sink failed'); } }) });
    assert.equal(out.ok, false);
    assert.equal(readHotPatch(root, env), null); assert.equal(existsSync(`${hotPatchPath(root, env)}.pending`), false);
    assert.deepEqual(readOverlays(root, { env }), []);
    assert.equal((await requestHotPatch(request)).ok, true, 'failure must permit a retry');
  }));
}

test('checklist-9: crash after registration retains the owed ledger and rolls back on deadline', fixture(async f => {
  const { root, env, plan, git } = f;
  git(['checkout', '-q', 'main']);
  // Die after the real registration, bypassing finally as an actual crash would.
  nativeWriteProbe(`request.emit = () => process.exit(0); await requestHotPatch(request); assert.fail('must exit before publication');`, f);
  assert.equal(readHotPatch(root, env).sha, sha); assert.equal(readOverlays(root, { env }).length, 1);
  assert.equal(existsSync(`${hotPatchPath(root, env)}.pending`), true);
  assert.equal(await runOwedTick({ root, env, now: () => Date.now() + 25 * 3600000 }), 'rollback');
  assert.deepEqual(readOverlays(root, { env }), []); assert.equal(readForceWatch(root, env), null);
  assert.equal(git(['rev-parse', 'HEAD']), good);
}));


test('checklist-9: rollbackPending survives a process restart and retries the real reset', fixture(async ({ root, env, request, arm }) => {
  await requestHotPatch(request); assert.equal(arm().ok, true);
  verifyMarker(env, sha, 'red');
  await recordVerifyResult({ root, env, sha });
  assert.equal((await runForceWatchTick({ root, env, currentHead: sha, rollback: async () => ({ ok: false }),
    probe: async () => ({ healthy: true }) })).action, 'rollback-failed');
  const script = `import { spawnSync } from 'node:child_process';
    import { runOwedTick } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/hot-patch.mjs')).href)};
    import { runForceWatchTick } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/daemon-force-adopt.mjs')).href)};
    const root = process.env.FIXTURE_ROOT;
    const git = args => { const r = spawnSync('git', args, {cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 4096});
      if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
    await runOwedTick({root, runGh: () => '[]'});
    const out = await runForceWatchTick({root, currentHead: () => git(['rev-parse', 'HEAD']),
      probe: async () => ({healthy: true}), rollback: async last => { git(['reset', '--hard', last.head]); return {ok: true}; }});
    if (out.action !== 'rollback' || git(['rev-parse', 'HEAD']) !== process.env.FIXTURE_GOOD) process.exitCode = 1;`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, ...env, FIXTURE_ROOT: root, FIXTURE_GOOD: good }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.equal(child.status, 0, child.stderr); assert.equal(readForceWatch(root, env), null);
}));

test('checklist-14: owed deadlines share the existing force-watch tick without a scheduler', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/lib/daemon-rebuild/rebuild.mjs'), 'utf8');
  assert.match(source, /await runOwedTick[\s\S]*?await runForceWatchTick/);
  const ledger = readFileSync(join(process.cwd(), 'scripts/lib/hot-patch.mjs'), 'utf8');
  assert.doesNotMatch(ledger, /\b(?:setInterval|setTimeout)\s*\(/);
});


// Native imports preserve Node's live builtin bindings when wrapping actual writes.
function nativeWriteProbe(source, { root, env, request, plan }) {
  const script = `import assert from 'node:assert/strict';
    import fs, { writeFileSync, existsSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { requestHotPatch, readHotPatch, hotPatchPath, openHotPatchWatch } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/hot-patch.mjs')).href)};
    import { watchPath, readForceWatch } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/daemon-force-adopt.mjs')).href)};
    const {root, env, request, plan, good} = JSON.parse(process.env.HOT_PATCH_FIXTURE);
    request.emit = async () => true;
    const arm = () => openHotPatchWatch({root, env, plan, lastGood: {head: good}, smokePassed: true});
    ${source}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env, HOT_PATCH_FIXTURE: JSON.stringify({ root, env, request, plan, good }) },
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.equal(child.status, 0, child.stderr);
}

for (const evidence of ['watch', 'unreadable-watch', 'record']) {
  test(`checklist-4: ${evidence} changed immediately after ledger write is detected by re-read`, fixture(f => {
    nativeWriteProbe(`const evidence = ${JSON.stringify(evidence)}, rename = fs.renameSync; let injected = false;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (to !== hotPatchPath(root, env) || injected) return;
        injected = true;
        if (evidence !== 'record') writeFileSync(watchPath(root, env), evidence === 'watch' ? JSON.stringify({ sha: good, version: 1 }) : '{bad');
        else writeFileSync(to, JSON.stringify({ ...readHotPatch(root, env), daemon: 'concurrent' }));
      };
      syncBuiltinESMExports();
      const out = await requestHotPatch(request);
      assert.equal(injected, true, 'real ledger write was intercepted'); assert.equal(out.ok, false);
      assert.equal(readHotPatch(root, env)?.daemon ?? null, evidence === 'record' ? 'concurrent' : null);
      assert.equal(existsSync(hotPatchPath(root, env) + '.pending'), false);`, f);
  }));
}

test('checklist-4: stale watch version cannot overwrite a concurrent change', fixture(async ({ root, env, request, arm }) => {
  await requestHotPatch(request); assert.equal(arm().ok, true);
  const old = readForceWatch(root, env);
  assert.equal(transitionWatch(root, env, watch => ({ next: { ...watch, rollbackPending: 'concurrent' } })).ok, true);
  assert.equal(transitionWatch(root, env, () => ({ next: old }), { expectVersion: old.version }).ok, false);
  assert.equal(readForceWatch(root, env).rollbackPending, 'concurrent');
}));


test('checklist-5: clone HEAD moved during the health probe never rolls back the successor', fixture(async ({ root, env, request, arm, git }) => {
  await requestHotPatch(request); assert.equal(arm().ok, true);
  const out = await runForceWatchTick({ root, env, currentHead: () => git(['rev-parse', 'HEAD']),
    probe: async () => { git(['commit', '--allow-empty', '-qm', 'successor']); return { healthy: false }; },
    rollback: async () => { assert.fail('successor must not be rolled back'); } });
  assert.equal(out.action, 'superseded'); assert.equal(readForceWatch(root, env).sha, sha);
}));


test('checklist-4: watch changed immediately after its write refuses adoption', fixture(f => {
  nativeWriteProbe(`await requestHotPatch(request);
    const rename = fs.renameSync; let injected = false;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (to === watchPath(root, env)) { injected = true; writeFileSync(to, JSON.stringify({ sha: good, version: 99 })); }
    };
    syncBuiltinESMExports();
    assert.equal(arm().ok, false); assert.equal(injected, true);
    assert.equal(readForceWatch(root, env).version, 99);`, f);
}));


test('checklist-5: a watch for a different build cannot authorize this patch', fixture(async ({ root, env, request, arm }) => {
  await requestHotPatch(request); assert.equal(arm().ok, true);
  const watch = readForceWatch(root, env);
  writeFileSync(watchPath(root, env), JSON.stringify({ ...watch, sha: good }));
  assert.equal(arm().ok, false); assert.equal(readForceWatch(root, env).sha, good);
}));


for (const path of [
  'scripts/hot-patch.mjs', 'scripts/lib/hot-patch.mjs', 'scripts/lib/hot-patch-settings.json',
  'scripts/lib/hot-patch-settings.mjs',
  ...['smoke', 'adopt', 'prepare', 'rebuild', 'rebuild-job', 'state', 'lease', 'recovery'].map(n => `scripts/lib/daemon-rebuild/${n}.mjs`),
  ...['daemon-force-adopt', 'daemon-overlays', 'overlay-adoption', 'daemon-load-overlay', 'daemon-self-sync', 'daemon-rebuild-early-watch'].map(n => `scripts/lib/${n}.mjs`),
]) {
  test(`audit-2: adoption and rollback floor cannot be waived: ${path}`, () => {
    assert.equal(classifyHotPatch({ files: [path], kind: 'incident',
      settings: { ...hotPatchDefaults, neverPatchPaths: [] } }).ok, false);
  });
}

for (const change of ['missing', 'wrong-daemon', 'wrong-sha', 'head']) {
  test(`audit-1: registration refuses ${change} evidence before passing no-PR bypass`, fixture(async f => {
    const c = cliGitFixture(f);
    c.put('scripts/lib/daemon-tool.mjs', 'fix\n'); const patch = c.commit();
    const run = c.deps.run; let pins = 0;
    c.deps.run = (cmd, args, options) => {
      // Second pin occurs after this invocation has written its ledger, before registration.
      if (cmd === 'git' && args.includes(`${patch}^{commit}`) && ++pins === 2) {
        const record = readHotPatch(f.root, f.env);
        assert.equal(record.sha, patch);
        if (change === 'missing') rmSync(hotPatchPath(f.root, f.env));
        else if (change === 'head') f.git(['commit', '--allow-empty', '-qm', 'successor']);
        else writeFileSync(hotPatchPath(f.root, f.env), JSON.stringify({ ...record,
          ...(change === 'wrong-daemon' ? { daemon: 'other' } : { sha: good }) }));
      }
      return run(cmd, args, options);
    };
    assert.equal(await main(c.argv(patch), c.deps), 1);
    assert.equal(c.registrations(), 0);
    assert.deepEqual(readOverlays(f.root, { env: f.env }), []);
  }));
}

test('audit-1: ledger removed during registration withdraws the no-PR overlay', fixture(async f => {
  const c = cliGitFixture(f);
  c.put('scripts/lib/daemon-tool.mjs', 'fix\n'); const patch = c.commit(), run = c.deps.run;
  c.deps.run = (cmd, args, options) => {
    const out = run(cmd, args, options);
    if (cmd === process.execPath) rmSync(hotPatchPath(f.root, f.env));
    return out;
  };
  assert.equal(await main(c.argv(patch), c.deps), 1);
  assert.equal(c.registrations(), 1);
  assert.deepEqual(readOverlays(f.root, { env: f.env }), []);
}));

for (const membership of [{ ok: true, inQueue: false }, { ok: false }, null]) {
  test(`audit-3: caller queued claim cannot waive rollback on nonmembership or unreadable queue: ${JSON.stringify(membership)}`, fixture(async ({ root, env, request }) => {
    await requestHotPatch(request);
    recordHotPatchPr({ root, env, sha, pr: 42, run: verifiedPr, inMergeQueue: true, now: at });
    verifyMarker(env, sha, 'green');
    await recordVerifyResult({ root, env, sha });
    let reads = 0;
    const readQueue = async ({ num }) => { assert.equal(num, 42); reads++; return membership; };
    assert.equal(await runOwedTick({ root, env, now: at + 24 * 3600000, readQueue }), 'rollback');
    assert.equal(reads, 1); assert.deepEqual(readOverlays(root, { env }), []);
  }));
}

test('audit-3: historical, expired and future queue timestamps cannot grant fallback exemption', () => {
  const record = { inMergeQueue: true, owed: { pr: 42, verify: 'green',
    prBy: new Date(at).toISOString(), mergeBy: new Date(at).toISOString() } };
  for (const timestamp of [undefined, 'bad', new Date(at - 120 * 60000).toISOString(), new Date(at + 1).toISOString()]) {
    assert.equal(evaluateOwed({ record: { ...record, inMergeQueueAt: timestamp }, now: at }), 'rollback');
  }
  assert.equal(evaluateOwed({ record: { ...record, inMergeQueueAt: new Date(at - 60000).toISOString() },
    now: at, settings: { ...hotPatchDefaults, queueExemptionMinutes: 1 } }), 'rollback');
});

test('audit-3: every owed tick rechecks real queue membership, including after a successful check', fixture(async ({ root, env, request }) => {
  await requestHotPatch(request);
  recordHotPatchPr({ root, env, sha, pr: 42, run: verifiedPr, inMergeQueue: true, now: at });
  assert.equal(readHotPatch(root, env).inMergeQueueAt, new Date(at).toISOString());
  verifyMarker(env, sha, 'green');
  await recordVerifyResult({ root, env, sha });
  let reads = 0;
  const readQueue = async () => ({ ok: true, inQueue: ++reads === 1 });
  const args = { root, env, now: at + 24 * 3600000, readQueue };
  assert.equal(await runOwedTick(args), 'ok');
  assert.equal(await runOwedTick(args), 'rollback'); assert.equal(reads, 2);
}));


test('audit-3: default queue reader refuses unknown origin instead of trusting --queued', fixture(async ({ root, env, request }) => {
  await requestHotPatch(request);
  recordHotPatchPr({ root, env, sha, pr: 42, run: verifiedPr, inMergeQueue: true, now: at });
  verifyMarker(env, sha, 'green');
  await recordVerifyResult({ root, env, sha });
  assert.equal(await runOwedTick({ root, env, now: at + 24 * 3600000 }), 'rollback');
}));


test('audit-1: prewritten ledger cannot authorize adoption while registration is pending', fixture(async ({ root, env, request, arm }) => {
  const out = await requestHotPatch({ ...request, registerOverlay: assertRegistration => {
    assertRegistration();
    addOverlay(root, { ref: request.branch, pinned: true }, { env });
    assert.equal(arm().ok, false);
    assert.equal(readForceWatch(root, env), null);
  } });
  assert.equal(out.ok, true); assert.equal(arm().ok, true);
}));


test('owed CI: unknown x7 fails closed through durable rollback, with six ticks of grace', fixture(async ({ root, env, request, arm }) => {
  await requestHotPatch(request); arm();
  env.WE_HOT_PATCH = JSON.stringify({ verifyRepo: 'owner/repo' });
  const runGh = vi.fn(() => { throw new Error('offline'); });
  for (let i = 1; i <= 7; i++) {
    await runOwedTick({ root, env, now: at + 20 * 60000, runGh });
    assert.equal(readHotPatch(root, env).ciUnknownTicks, i);
    assert.equal(Boolean(readForceWatch(root, env).rollbackPending), i > 6);
  }
  assert.equal(runGh.mock.calls.length, 7);
  assert(runGh.mock.calls.every(([args]) => args.includes(`repos/owner/repo/commits/${sha}/check-runs`)));
  assert.equal(readHotPatch(root, env).rollbackPending, 'ci-unknown-limit');
  assert.equal(readOverlays(root, { env }).length, 0);
  const rollback = vi.fn(async () => ({ ok: true }));
  assert.equal((await runForceWatchTick({ root, env, currentHead: sha, now: () => at + 20 * 60000,
    probe: async () => ({ healthy: true }), rollback })).action, 'rollback');
  assert.equal(rollback.mock.calls[0][0].head, good);
}));

test('owed CI: unknown x3 then green resets the counter and permits healthy retirement', fixture(async ({ root, env, request, arm }) => {
  await requestHotPatch(request); arm();
  env.WE_HOT_PATCH = JSON.stringify({ verifyRepo: 'owner/repo' });
  const runGh = vi.fn(() => '[]');
  for (let i = 0; i < 3; i++) await runOwedTick({ root, env, now: at, runGh });
  assert.equal(readHotPatch(root, env).ciUnknownTicks, 3);
  verifyMarker(env, sha, 'green');
  await runOwedTick({ root, env, now: at });
  assert.equal(readHotPatch(root, env).ciUnknownTicks, 0);
  assert.equal(readHotPatch(root, env).owed.verify, 'green');
  let watch = readForceWatch(root, env);
  assert.equal(watch.rollbackPending, undefined);
  for (let i = 0; i < 10; i++) {
    const v = evaluateForceWatch({ watch, healthy: true, now: at + 20 * 60000 });
    watch = v.watch;
    assert.equal(v.action, i === 9 ? 'done' : 'continue');
  }
}));

test('owed CI: pending resets unknown count and an old watch without CI evidence cannot retire', fixture(async ({ root, env, request, arm }) => {
  await requestHotPatch(request); arm();
  env.WE_HOT_PATCH = JSON.stringify({ verifyRepo: 'owner/repo' });
  await runOwedTick({ root, env, now: at, runGh: () => '[]' });
  await runOwedTick({ root, env, now: at, runGh: () => JSON.stringify([{ id: 1, name: 'test', head_sha: sha,
    app: { id: 15368, slug: 'github-actions' }, status: 'in_progress', conclusion: null }]) });
  assert.equal(readHotPatch(root, env).ciUnknownTicks, 0);
  const { ciState: _old, ...watch } = readForceWatch(root, env);
  assert.equal(evaluateForceWatch({ watch: { ...watch, ticksLeft: 0 }, healthy: true, now: at + 20 * 60000 }).action, 'continue');
}));
