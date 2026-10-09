/**
 * agy-launcher-probation — the launch half: the env switch, the provider, the router branch, and the whole heal
 * arc of `probation-heal-run.mjs` over a fake `io` (no git, no gh, no model).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  PROBATION_BUILD_RUN_SCRIPT, PROBATION_HEAL_RUN_SCRIPT, probationLaunchDecision, probationLaunchFromEnv,
  probationWorkerDetachedProvider,
} from '../dispatch-providers/probation-worker.mjs';
import { createDispatchObservers, routeDispatchProvider } from '../dispatch-lane-io.mjs';
import { DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { pendingProbationLaunches } from '../../lib/model-probation.mjs';
import { beginHealAttempt, bindHealAttempt, failHealAttempt, readHealAttempt, finishHealAttempt, observeHealAttempt, pollHealAttempts, publishHealAttempt, parseArgs, realIo, runProbationHeal } from '../probation-heal-run.mjs';

const agyClaude = { id: 'antigravity-claude', provider: 'antigravity', model: 'claude-sonnet-4-6', executor: 'antigravity', launcher: 'scripts/gemini-direct-task.mjs', checker: null, taskType: 'ci-heal' };
const agyGemini = { ...agyClaude, id: 'antigravity-gemini', model: 'gemini-3.8-flash-high', checker: 'codex' };
const docFixWorker = { id: 'codex', provider: 'codex', model: 'gpt-6-astra', executor: 'codex', launcher: 'scripts/codex-direct-task.mjs', checker: null, taskType: 'doc-fix' };

describe('probationLaunchFromEnv', () => {
  it('unset → on in production, off under the test runner; an explicit value wins; a typo throws', () => {
    expect(probationLaunchFromEnv({})).toBe('on');
    expect(probationLaunchFromEnv({ VITEST: 'true' })).toBe('off');
    expect(probationLaunchFromEnv({ VITEST: 'true', WE_PROBATION_LAUNCH: 'on' })).toBe('on');
    expect(probationLaunchFromEnv({ WE_PROBATION_LAUNCH: ' OFF ' })).toBe('off');
    expect(() => probationLaunchFromEnv({ WE_PROBATION_LAUNCH: 'yes' })).toThrow(/must be `on` or `off`/);
  });
});

describe('probationLaunchDecision', () => {
  const req = { launchKind: 'ci-heal', repo: 'we', probationWorker: agyClaude };
  it('launches a WE ci-heal with a worker when on', () => expect(probationLaunchDecision(req, 'on').launch).toBe(true));
  it('never without a worker, for another kind, another repo, or when off', () => {
    expect(probationLaunchDecision({ ...req, probationWorker: null }, 'on').launch).toBe(false);
    // A `ci-heal`-taskType worker offered under a `build` request is recorded, never launched (#4291) — `build`
    // launches a `doc-fix` worker only.
    expect(probationLaunchDecision({ ...req, launchKind: 'build' }, 'on').launch).toBe(false);
    expect(probationLaunchDecision({ ...req, repo: 'frontierui' }, 'on').launch).toBe(false);
    expect(probationLaunchDecision(req, 'off').launch).toBe(false);
  });

  // #4291 — the doc-fix build launcher: `build` + a `doc-fix` worker launches; `build` + any other taskType
  // (or `ci-heal` + a `doc-fix` worker) does not.
  const buildReq = { launchKind: 'build', repo: 'we', probationWorker: docFixWorker };
  it('launches a WE doc-fix build with a doc-fix worker when on', () => expect(probationLaunchDecision(buildReq, 'on').launch).toBe(true));
  it('never for the wrong taskType, another repo, or when off', () => {
    expect(probationLaunchDecision({ ...buildReq, probationWorker: agyClaude }, 'on').launch).toBe(false);
    expect(probationLaunchDecision({ launchKind: 'ci-heal', repo: 'we', probationWorker: docFixWorker }, 'on').launch).toBe(false);
    expect(probationLaunchDecision({ ...buildReq, repo: 'frontierui' }, 'on').launch).toBe(false);
    expect(probationLaunchDecision(buildReq, 'off').launch).toBe(false);
  });
  it('an unregistered kind is recorded but never launched', () => {
    expect(probationLaunchDecision({ launchKind: 'fix', repo: 'we', probationWorker: docFixWorker }, 'on').launch).toBe(false);
  });
});

describe('probationWorkerDetachedProvider', () => {
  it('spawns the run script with the worker, returns pid:<n>, and reports the executor', () => {
    const spawned = [];
    const reportExecutor = vi.fn();
    const handle = probationWorkerDetachedProvider(
      { launchKind: 'ci-heal', headRefOid: 'a'.repeat(40), pr: 2811, sessionSlug: 'ci-heal-2811', reason: 'behind', num: '4075', lane: 9, scope: ['we:a.mjs'], probationWorker: agyClaude, reportExecutor, cwd: '/scratch' },
      { spawnDetached: (argv, o) => { spawned.push({ argv, o }); return { pid: 777 }; }, logPathFor: () => '/dev/null' },
    );
    expect(handle).toBe('pid:777');
    expect(reportExecutor).toHaveBeenCalledWith('antigravity');
    const { argv, o } = spawned[0];
    expect(argv[0]).toBe(PROBATION_HEAL_RUN_SCRIPT);
    expect(argv).toEqual(expect.arrayContaining(['--pr=2811', '--session=ci-heal-2811', '--reason=behind', '--num=4075', '--lane=9', '--scope=we:a.mjs']));
    expect(JSON.parse(argv.find((a) => a.startsWith('--worker=')).slice(9))).toEqual(agyClaude);
    expect(o.cwd).toBe('/scratch');
  });
  it('refuses before any process with no PR, no slug or no worker', () => {
    const spawnDetached = vi.fn();
    for (const bad of [{ sessionSlug: 's', probationWorker: agyClaude }, { pr: 1, probationWorker: agyClaude }, { pr: 1, sessionSlug: 's' }]) {
      expect(() => probationWorkerDetachedProvider(bad, { spawnDetached })).toThrow();
    }
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  // #4291 — the `build` kind is ITEM-keyed (`--num=`), never PR-keyed, and starts the doc-fix build run script.
  it('a `build` launch spawns the doc-fix run script, keyed to the item, with an optional attempt tag', () => {
    const spawned = [];
    const reportExecutor = vi.fn();
    const handle = probationWorkerDetachedProvider(
      { launchKind: 'build', num: '4291', sessionSlug: 'probation-4291', attemptTag: 'b', lane: 22, scope: ['we:a.mjs'], probationWorker: docFixWorker, reportExecutor, cwd: '/scratch' },
      { spawnDetached: (argv, o) => { spawned.push({ argv, o }); return { pid: 555 }; }, logPathFor: () => '/dev/null' },
    );
    expect(handle).toBe('pid:555');
    expect(reportExecutor).toHaveBeenCalledWith('codex');
    const { argv, o } = spawned[0];
    expect(argv[0]).toBe(PROBATION_BUILD_RUN_SCRIPT);
    expect(argv).toEqual(expect.arrayContaining(['--num=4291', '--session=probation-4291', '--attempt=b', '--lane=22', '--scope=we:a.mjs']));
    expect(argv.some((a) => a.startsWith('--pr=') || a.startsWith('--reason='))).toBe(false);
    expect(JSON.parse(argv.find((a) => a.startsWith('--worker=')).slice(9))).toEqual(docFixWorker);
    expect(o.cwd).toBe('/scratch');
  });
  it('a `build` launch refuses before any process with no item number', () => {
    const spawnDetached = vi.fn();
    expect(() => probationWorkerDetachedProvider(
      { launchKind: 'build', sessionSlug: 'probation-4291', probationWorker: docFixWorker },
      { spawnDetached },
    )).toThrow(/no item number/);
    expect(spawnDetached).not.toHaveBeenCalled();
  });
  // #4291 plan review round 2 — closes the coverage gap the standards-conformance/claim-accuracy lenses named:
  // a THIRD registered kind must refuse explicitly, never silently fall through to the PR-keyed `ci-heal` argv
  // shape (the provider itself, not only `probationLaunchDecision`, must reject an unknown kind).
  it('an unrecognised kind refuses before any process — never silently falls through to the ci-heal (PR-keyed) argv shape', () => {
    const spawnDetached = vi.fn();
    expect(() => probationWorkerDetachedProvider(
      { launchKind: 'fix', sessionSlug: 'probation-4291', probationWorker: docFixWorker },
      { spawnDetached },
    )).toThrow(/no argv shape for it/);
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});

describe('routeDispatchProvider — the probation branch', () => {
  const req = { launchKind: 'ci-heal', repo: 'we', probationWorker: agyClaude, pr: 1, sessionSlug: 's' };
  it('on + a worker → the probation provider, not claude', () => {
    const agent = vi.fn(() => 'claude-handle');
    const probation = vi.fn(() => 'pid:1');
    expect(routeDispatchProvider(req, { agent, probation, probationLaunch: 'on', scriptExists: () => true })).toBe('pid:1');
    expect(agent).not.toHaveBeenCalled();
  });
  it('off (the direct-call default) → claude, exactly as before', () => {
    const agent = vi.fn(() => 'claude-handle');
    const probation = vi.fn();
    expect(routeDispatchProvider(req, { agent, probation })).toBe('claude-handle');
    expect(probation).not.toHaveBeenCalled();
  });
  it('a missing run script is refused before any process', () => {
    expect(() => routeDispatchProvider(req, { agent: vi.fn(), probation: vi.fn(), probationLaunch: 'on', scriptExists: () => false })).toThrow(/not in this checkout/);
  });
});

/** A fake io: a rebased lane whose gate result, worker diff and checker answer the test chooses.
 *  x55dojc — `resetHookSurface`/`snapshotHookSurface` default to a clean, never-tampered lane; pass
 *  `hookResetClean: false` (refused before any worker) or `hookTampered: true` (changed while the worker ran)
 *  to exercise those refusal paths without a real fs/git dependency. */
function fakeIo({
  gate = [false, true], rebaseOk = true, moved = true, numstat = '2\t1\tscripts/a.mjs', checker = 'APPROVE',
  pushOk = true, state = 'OPEN', hookResetClean = true, hookTampered = false, tamperRestoreClean = true,
} = {}) {
  const calls = [];
  const rows = [];
  const gates = [...gate];
  let head = 'examined';
  const cleanSnapshot = { configHash: 'clean', files: {} };
  const tamperedSnapshot = { configHash: 'clean', files: { 'pre-commit': 'planted' } };
  const io = {
    log: () => {},
    completion: (c) => calls.push(['completion', c.status, c.outcome]),
    prHead: () => ({ state, headRefOid: 'examined', headRefName: 'lane/x' }),
    acquireLane: () => '/lanes/9',
    resetHookSurface: (d, baseline) => { calls.push(baseline ? ['reset-hooks', d, baseline] : ['reset-hooks', d]); return { clean: baseline ? tamperRestoreClean : hookResetClean, leftover: hookResetClean ? [] : ['pre-commit'], snapshot: cleanSnapshot }; },
    snapshotHookSurface: (d) => { calls.push(['snapshot-hooks', d]); return hookTampered ? tamperedSnapshot : cleanSnapshot; },
    rebaseOntoMain: () => { if (rebaseOk && moved) head = 'rebased'; return rebaseOk; },
    headSha: () => head,
    runGate: () => ({ pass: gates.length ? gates.shift() : true, output: 'gate out' }),
    failingChecks: () => 'test\tfail',
    failedLogTail: () => '',
    writeTaskFile: (_d, name, text) => { calls.push(['task', name, text.length > 0]); return `/lanes/9/.git/${name}`; },
    runWorker: (argv) => { calls.push(['worker', argv[0], argv.find((a) => a.startsWith('--model='))]); return { ok: true, out: '' }; },
    runChecker: (argv) => { calls.push(['checker', argv[1]]); return checker; },
    untracked: () => ['node_modules'],
    diffNumstat: (_d, _base, preexisting) => { calls.push(['numstat', preexisting]); return numstat; },
    diffText: () => 'diff --git a/scripts/a.mjs',
    discardChanges: () => calls.push(['discard']),
    commit: (_d, paths, msg) => calls.push(['commit', paths, msg.split('\n')[0]]),
    push: (_d, ref, lease) => { calls.push(['push', ref, lease]); return pushOk; },
    markHealed: (m) => calls.push(['mark', m.reason]),
    escalate: (e) => calls.push(['escalate', e.reason]),
    appendScorecard: (r) => { calls.push(['scorecard', r.launchOutcome, r.executor, r.outcome, r.verifiedBy]); rows.push(r); },
  };
  return { io, calls, rows };
}
const args = (worker = agyClaude, reason = 'red-ci') => parseArgs(['--pr=2811', '--session=ci-heal-2811', `--reason=${reason}`, `--worker=${JSON.stringify(worker)}`, '--lane=9']);

describe('runProbationHeal — the arc', () => {
  it('red gate → the worker repairs → gate green → commit, push against the examined head, mark, healed, one launch row', async () => {
    const { io, calls } = fakeIo();
    const r = await runProbationHeal(args(), io);
    expect(r).toMatchObject({ outcome: 'healed', executor: 'antigravity' });
    expect(calls.find((c) => c[0] === 'worker')).toEqual(['worker', expect.stringMatching(/scripts\/gemini-direct-task\.mjs$/), '--model=claude-sonnet-4-6']);
    expect(calls.find((c) => c[0] === 'commit')).toEqual(['commit', ['scripts/a.mjs'], expect.stringContaining('ci-heal — red-ci: repair scripts/a.mjs')]);
    expect(calls.find((c) => c[0] === 'push')).toEqual(['push', 'lane/x', 'examined']);
    expect(calls.filter((c) => c[0] === 'scorecard')).toEqual([['scorecard', 'healed', 'antigravity', null, null]]);
    expect(calls.at(0)).toEqual(['completion', 'started', null]);
    // the untracked files that were there BEFORE the worker ran are handed to the diff, so they never join the heal.
    expect(calls.find((c) => c[0] === 'numstat')).toEqual(['numstat', ['node_modules']]);
  });

  it('a pre-existing untracked path the LAUNCHER intent-added never joins the heal commit or its size (live-caught)', async () => {
    // gemini-direct-task.mjs intent-adds EVERY untracked file for its own diff capture, so the numstat can list a
    // path (here a `node_modules` symlink) that was in the lane before the worker ran. It must not be committed.
    const { io, calls } = fakeIo({ numstat: '1\t0\tnode_modules\n2\t1\tscripts/a.mjs' });
    const r = await runProbationHeal(args(), io);
    expect(r.outcome).toBe('healed');
    expect(calls.find((c) => c[0] === 'commit')[1]).toEqual(['scripts/a.mjs']);
    expect(calls.find((c) => c[0] === 'scorecard')).toBeTruthy();
  });

  it('a clean rebase that turns the gate green is pushed with NO model run and NO launch row', async () => {
    const { io, calls } = fakeIo({ gate: [true] });
    const r = await runProbationHeal(args(agyClaude, 'behind'), io);
    expect(r).toMatchObject({ outcome: 'no-change', executor: 'mechanical' });
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
    expect(calls.some((c) => c[0] === 'push')).toBe(true);
    expect(calls.some((c) => c[0] === 'scorecard')).toBe(false);
  });

  it('a rebase conflict escalates without spending a model', async () => {
    const { io, calls } = fakeIo({ rebaseOk: false });
    expect((await runProbationHeal(args(), io)).outcome).toBe('escalated-conflict');
    expect(calls.some((c) => c[0] === 'escalate')).toBe(true);
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
  });

  it('a heal bigger than the ci-heal envelope is discarded, never pushed', async () => {
    const { io, calls } = fakeIo({ numstat: '100\t60\tscripts/a.mjs' });
    const r = await runProbationHeal(args(), io);
    expect(r.outcome).toBe('gate-red');
    expect(r.detail).toMatch(/changed 160 lines/);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('a gate still red after the repair is not pushed', async () => {
    const { io, calls } = fakeIo({ gate: [false, false] });
    expect((await runProbationHeal(args(), io)).outcome).toBe('gate-red');
    expect(calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('agy-Gemini: pushed only on the Codex checker\'s APPROVE', async () => {
    const approved = fakeIo();
    expect((await runProbationHeal(args(agyGemini), approved.io)).outcome).toBe('healed');
    expect(approved.calls.find((c) => c[0] === 'checker')).toEqual(['checker', '--review']);
    const rejected = fakeIo({ checker: 'REJECT\nit deletes a test' });
    const r = await runProbationHeal(args(agyGemini), rejected.io);
    expect(r.outcome).toBe('gate-red');
    expect(r.detail).toMatch(/did not approve: reject/);
    expect(rejected.calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('a push refused by the lease (the head moved) is blocked-on-infra, not healed', async () => {
    const { io } = fakeIo({ pushOk: false });
    expect((await runProbationHeal(args(), io)).outcome).toBe('blocked-on-infra');
  });

  it('a closed PR is not-applicable', async () => {
    const { io, calls } = fakeIo({ state: 'MERGED' });
    expect((await runProbationHeal(args(), io)).outcome).toBe('not-applicable');
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
  });

  // x55dojc — hardening against a worker planting a git hook.
  it('refuses before any rebase/worker when the lane\'s git-hook baseline cannot be cleaned', async () => {
    const { io, calls } = fakeIo({ hookResetClean: false });
    const r = await runProbationHeal(args(), io);
    expect(r).toMatchObject({ outcome: 'escalated-needs-human', executor: 'none' });
    expect(r.detail).toMatch(/clean git-hook baseline/);
    expect(calls.some((c) => c[0] === 'worker')).toBe(false);
    expect(calls.filter((c) => c[0] === 'reset-hooks')).toEqual([['reset-hooks', '/lanes/9']]);
    expect(calls.find((c) => c[0] === 'escalate')[1]).toMatch(/git-hook surface/);
  });

  it('a worker that changes the lane\'s git-hook surface is refused, discarded, and never committed/pushed', async () => {
    const { io, calls } = fakeIo({ hookTampered: true });
    const r = await runProbationHeal(args(), io);
    expect(r).toMatchObject({ outcome: 'escalated-needs-human', executor: 'antigravity' });
    expect(r.detail).toMatch(/\.git\/hooks\/ changed/);
    expect(calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(calls.some((c) => c[0] === 'push')).toBe(false);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.filter((c) => c[0] === 'reset-hooks').length).toBeGreaterThanOrEqual(2); // baseline + post-tamper cleanup
    // #4291 advisory finding (security) — the cleanup restores the PRE-worker config, before `discard` runs git.
    const cleanupAt = calls.findIndex((c) => c[0] === 'reset-hooks' && c[2]);
    expect(calls[cleanupAt][2]).toEqual({ configHash: 'clean', files: {} });
    expect(cleanupAt).toBeLessThan(calls.findIndex((c) => c[0] === 'discard'));
    const failed = fakeIo({ hookTampered: true, tamperRestoreClean: false });
    const r2 = await runProbationHeal(args(), failed.io);
    expect(r2.detail).toMatch(/NOT discarded; quarantine it/);
    expect(failed.calls.some((c) => c[0] === 'discard' || c[0] === 'commit' || c[0] === 'push')).toBe(false);
    expect(calls.find((c) => c[0] === 'escalate')[1]).toMatch(/git-hook surface changed during the worker/);
    expect(calls.find((c) => c[0] === 'scorecard')).toEqual(['scorecard', 'escalated-needs-human', 'antigravity', null, null]);
  });
});


describe('test-fix launches (#4551)', () => {
  const worker = { ...agyGemini, taskType: 'test-fix' };
  it.each(['build', 'ci-heal'])('launches %s with test-fix preserved in argv', (launchKind) => {
    const request = { headRefOid: 'a'.repeat(40), launchKind, repo: 'we', probationWorker: worker, num: '4551', pr: 2811, sessionSlug: 'test-fix' };
    expect(probationLaunchDecision(request, 'on').launch).toBe(true);
    const spawnDetached = vi.fn(() => ({ pid: 777 }));
    probationWorkerDetachedProvider(request, { spawnDetached, logPathFor: () => '/dev/null' });
    expect(spawnDetached.mock.calls[0][0]).toContain('--taskType=test-fix');
  });
  it('checks a test-only heal with Codex and refuses a mixed heal before committing', async () => {
    const approved = fakeIo({ numstat: '2\t1\tscripts/a.test.mjs' });
    const input = parseArgs(['--pr=2811', '--session=test-fix', `--worker=${JSON.stringify(worker)}`]);
    expect((await runProbationHeal(input, approved.io)).outcome).toBe('healed');
    expect(approved.calls.some((c) => c[0] === 'checker')).toBe(true);
    const mixed = fakeIo({ numstat: '2\t1\tscripts/a.test.mjs\n1\t0\tsrc/a.mjs' });
    expect((await runProbationHeal(input, mixed.io)).outcome).toBe('gate-red');
    expect(mixed.calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(mixed.calls.some((c) => ['commit', 'push', 'checker'].includes(c[0]))).toBe(false);
  });
});

describe('dead ends are never judgeable trials (#4338)', () => {
  const deadEnds = [
    ['gate-red: envelope overflow', { numstat: '100\t60\tscripts/a.mjs' }, args()],
    ['gate-red: gate still red', { gate: [false, false] }, args()],
    ['gate-red: checker reject', { checker: 'REJECT\nno' }, args(agyGemini)],
    ['escalated-needs-human: hook tamper', { hookTampered: true }, args()],
  ];
  it.each(deadEnds)('%s appends a row that is never picked up for judging', async (_n, opts, a) => {
    const { io, rows } = fakeIo(opts);
    const r = await runProbationHeal(a, io);
    expect(r.outcome).toMatch(/^(gate-red|escalated-needs-human)$/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: null, verifiedBy: null });
    expect(rows[0].launchOutcome).not.toBe('healed');
    expect(pendingProbationLaunches(rows)).toEqual([]);
  });
  it('the mechanical / no-op path appends no row at all', async () => {
    const { io, rows } = fakeIo({ gate: [true] });
    await runProbationHeal(args(agyClaude, 'behind'), io);
    expect(rows).toEqual([]);
  });
});

describe('post-diff path gate (#4338)', () => {
  it.each([
    ['a statute-tier doc', '1\t0\tdocs/agent/platform-decisions.md', []],
    ['dispatch machinery', '1\t0\tscripts/lib/provider-routing.mjs', []],
    ['a path outside a non-empty scope', '1\t0\tscripts/b.mjs', ['we:scripts/a.mjs']],
  ])('%s in a small diff is discarded pre-push', async (_n, numstat, scope) => {
    const { io, calls } = fakeIo({ numstat });
    const r = await runProbationHeal({ ...args(), scope }, io);
    expect(r.outcome).toBe('gate-red');
    expect(r.detail).toMatch(/^not pushed: /);
    expect(calls.some((c) => c[0] === 'discard')).toBe(true);
    expect(calls.some((c) => c[0] === 'commit' || c[0] === 'push')).toBe(false);
  });
  it('an in-scope diff under a non-empty scope still heals', async () => {
    const { io, calls } = fakeIo();
    const r = await runProbationHeal({ ...args(), scope: ['we:scripts/a.mjs'] }, io);
    expect(r.outcome).toBe('healed');
    expect(calls.some((c) => c[0] === 'push')).toBe(true);
  });
});

describe('realIo().discardChanges (#4338)', () => {
  it('removes the worker\'s intent-added new file, reverts a tracked edit, and keeps a pre-existing untracked file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discard-'));
    try {
      const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
      git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
      writeFileSync(join(dir, 'tracked.txt'), 'original\n');
      git('add', '.'); git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(dir, 'keep.txt'), 'mine\n');
      const io = realIo({ session: 't' });
      const preexisting = io.untracked(dir);
      expect(preexisting).toEqual(['keep.txt']);
      writeFileSync(join(dir, 'tracked.txt'), 'edited\n');
      writeFileSync(join(dir, 'new.txt'), 'worker\n');
      io.diffNumstat(dir, base, preexisting); // intent-adds new.txt, as the arc does
      expect(git('ls-files')).toContain('new.txt');
      io.discardChanges(dir, base, preexisting);
      expect(existsSync(join(dir, 'new.txt'))).toBe(false);
      expect(readFileSync(join(dir, 'tracked.txt'), 'utf8')).toBe('original\n');
      expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('PR #3154 lane acquisition classification', () => {
  it.each(['present', 'unknown', 'absent'])('origin %s is independently checked after acquire fails', async (state) => {
    const { io, calls } = fakeIo({});
    io.acquireLane = () => ({ path: null, reason: 'no lane: shared scan lock contention' });
    io.probeOriginRef = vi.fn(() => ({ state, reason: state === 'unknown' ? 'DNS failed' : 'verified by origin' }));
    const result = await runProbationHeal(args(), io);
    expect(io.probeOriginRef).toHaveBeenCalledWith('lane/x');
    expect(result.outcome).toBe(state === 'absent' ? 'escalated-needs-human' : 'blocked-on-infra');
    expect(result.detail).toContain('lock contention');
    expect(calls.filter(c => c[0] === 'escalate')).toHaveLength(state === 'absent' ? 1 : 0);
    expect(calls.some(c => ['worker', 'push', 'reset-hooks'].includes(c[0]))).toBe(false);
  });

  it('real acquire adapter preserves subprocess diagnostics and probes exact origin ref with bounded IO', () => {
    const run = vi.fn(() => ({ ok: false, status: 1, out: 'no free lane: all held/dirty' }));
    const io = realIo({ session: 'probe', run });
    expect(io.acquireLane({ ref: 'lane/4409', session: 'probe' })).toEqual({ path: null, reason: 'no free lane: all held/dirty' });
    for (const [response, state] of [
      [{ ok: false, status: 2, out: '' }, 'absent'],
      [{ ok: false, status: 128, out: 'DNS failure' }, 'unknown'],
      [{ ok: false, out: 'ETIMEDOUT' }, 'unknown'],
      [{ ok: true, out: 'abc\trefs/heads/lane/4409\n' }, 'present'],
      [{ ok: true, out: 'abc\trefs/heads/lane/other\n' }, 'unknown'],
    ]) {
      run.mockReturnValue(response);
      expect(io.probeOriginRef('lane/4409').state).toBe(state);
      expect(run.mock.calls.at(-1)[1]).toEqual(expect.arrayContaining(['ls-remote', '--exit-code', '--refs', 'origin', 'refs/heads/lane/4409']));
      expect(run.mock.calls.at(-1)[2].timeout).toBe(30_000);
    }
  });
});


describe('xp0lsdi dead CI-heal regression', () => {
  it('hands a confirmed dead owned CI heal to durable settlement instead of leaving it unresolved', async () => {
    const settle = vi.fn(() => ({ status: 'resolved', result: { outcome: 'executor-failed', attemptId: 'attempt-3373' } }));
    const observer = createDispatchObservers({ isPidAlive: () => false, now: () => new Date('2026-10-02T12:00:00Z'), observeHeal: settle });
    const result = await observer[DISPATCH_EFFECT]({ payload: { launchKind: 'ci-heal', pr: 3373 }, dispatch: { attemptId: 'attempt-3373' }, handle: 'pid:43273', startedAt: '2026-10-01T22:00:00Z' });
    expect(result.status).toBe('resolved');
    expect(settle).toHaveBeenCalledOnce();
  });
});


import { once } from 'node:events';
import { countCiHealComments, buildCiHealComment, redactSecrets } from '../../conveyor/ci-heal-mark.mjs';
import { recordOwedWrite, readOwedWrites, clearOwedWrite } from '../../conveyor/ci-heal-owed.mjs';
import { acquireFixDispatchClaim, releaseFixDispatchClaim, listFixDispatchClaims } from '../../conveyor/fix-dispatch-claim.mjs';
import { routeAvailableCiHeal } from '../ci-heal-pr-dispatch.mjs';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';

// Captured GitHub fields from #3373 on 2026-10-02. Historical process/exit evidence was unavailable;
// PID ownership and the crash below are deliberately injected, never claimed to be the old process.
const captured3373 = {
  number: 3373, state: 'OPEN', headRefOid: 'b98e62d179c5326e64af41809e8b3c1f5ab6d432',
  headRefName: 'lane/4453-file-the-prevention-guard-s-owed-by-chalbert-web-everything',
  labels: [], mergeStateStatus: 'CLEAN', comments: [],
  statusCheckRollup: [{ name: 'soak-replay-gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ...['test', 'smoke', 'daemon-soak'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }))],
};
const proofDirs = [];
afterEach(() => { for (const dir of proofDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function attemptHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'heal-attempt-proof-')); proofDirs.push(dir);
  const owed = join(dir, 'owed'), lockRoot = join(dir, 'claims');
  const comments = [], published = [], completions = [];
  const start = (extra = {}) => beginHealAttempt({ pr: 3373, sessionSlug: 'ci-heal-3373', headRefOid: captured3373.headRefOid,
    probationWorker: agyClaude, ...extra }, { dir, now: () => '2026-10-02T00:00:00Z' });
  const publication = {
    readComments: () => comments,
    post: ({ body }) => { comments.push({ body, author: { login: 'web-everything' } }); published.push(body); },
    owe: rec => recordOwedWrite(rec, { dir: owed }), clear: rec => clearOwedWrite(rec, { dir: owed }),
  };
  const settle = (id, terminal) => finishHealAttempt(id, terminal, { dir,
    publish: row => publishHealAttempt(row, publication),
    complete: row => completions.push(row.terminal),
  });
  // One hour after `start()`: past the startup grace, inside HEAL_ATTEMPT_MAX_AGE_MS (the age-ceiling tests pass their own `now`).
  // The harness clock: rows are stamped 2026-10-02, so a poll on the real clock would prune them once they age past SETTLED_ROW_RETENTION_MS.
  const now = () => new Date('2026-10-02T01:00:00Z');
  const observe = (id, extra = {}) => observeHealAttempt(id, { dir, now, isPidAlive: () => false, settle, ...extra });
  return { dir, owed, lockRoot, comments, published, completions, start, publication, settle, observe, now };
}

describe('xp0lsdi durable crash recovery and restart soak', () => {
  it('replays #3373 observer → publication → reconciliation → held-backend exclusion for two launched identities', async () => {
    const h = attemptHarness();
    expect(countCiHealComments(h.comments)).toBe(0);
    for (const pid of [43273, 94262]) {
      const row = h.start(); bindHealAttempt(row.attemptId, `pid:${pid}`, { dir: h.dir });
      const entry = { handle: `pid:${pid}`, dispatch: { attemptId: row.attemptId }, payload: { launchKind: 'ci-heal', pr: 3373, repo: 'we' } };
      for (let tick = 0; tick < 40; tick++) {
        const observer = createDispatchObservers({ observeHeal: (id, opts) => h.observe(id, opts), isPidAlive: () => false,
          now: () => new Date('2026-10-02T12:00:00Z') });
        const result = await observer[DISPATCH_EFFECT](entry);
        expect(result).toMatchObject({ status: 'resolved', result: { outcome: 'executor-failed', quotaState: 'unknown' } });
        expect(result.error).toMatch(/unknown/);
      }
    }
    expect(h.published).toHaveLength(2);
    expect(h.completions).toHaveLength(2);
    expect(countCiHealComments(h.comments)).toBe(2);
    expect(readOwedWrites({ dir: h.owed })).toEqual([]);
    const pr = { ...captured3373, comments: h.comments };
    // The default classifier excludes this check, but captured branch protection explicitly requires it.
    expect(planReconcile({ prs: [pr], agents: [], now: Date.parse('2026-10-02T12:00:00Z') }).dispatch.filter((d) => d.kind !== 'restore-review-label')).toEqual([]);
    // Captured from the live main required_status_checks endpoint on 2026-10-02.
    const plan = planReconcile({ requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'], prs: [pr], agents: [], now: Date.parse('2026-10-02T12:00:00Z') });
    expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'ci-heal', prNumber: 3373, attempts: 2 }));
    const route = routeAvailableCiHeal({ scope: ['we:src/example.ts'] }, { readScores: () => [],
      readHolds: model => model.startsWith('claude-') ? { quotaState: 'exhausted', quotaResetsAt: '2026-10-04T17:31:18.942Z' } : null });
    expect(route.probationWorker.id).toBe('codex');
    expect(pr.statusCheckRollup[0].conclusion).toBe('FAILURE');
    const third = h.start(); bindHealAttempt(third.attemptId, 'pid:12345', { dir: h.dir }); h.observe(third.attemptId);
    const capped = planReconcile({ requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'], prs: [{ ...pr, comments: h.comments }], agents: [], now: Date.parse('2026-10-02T12:00:00Z') });
    expect(capped.dispatch).toEqual([]);
    expect(capped.refusals).toContainEqual(expect.objectContaining({ kind: 'cap-exhausted', attempts: 3 }));
  });

  it('launches a real CI-heal-shaped child, forces exit before publication, then recovers through normal polling', async () => {
    const h = attemptHarness(); let child, attempt;
    const handle = probationWorkerDetachedProvider({ launchKind: 'ci-heal', pr: 3373, sessionSlug: 'ci-heal-3373', probationWorker: agyClaude,
      headRefOid: captured3373.headRefOid }, {
      beginAttempt: request => { attempt = h.start(request); return attempt; },
      bindAttempt: (id, pid) => bindHealAttempt(id, pid, { dir: h.dir }), logPathFor: () => '/dev/null',
      spawnDetached: argv => {
        expect(readHealAttempt(attempt.attemptId, { dir: h.dir }).handle).toBeNull();
        expect(argv).toContain(`--heal-attempt=${attempt.attemptId}`);
        child = spawn(process.execPath, ['-e', 'process.exitCode = 23', '--', ...argv.slice(1)], { stdio: 'ignore' });
        return child;
      },
    });
    expect(await once(child, 'exit')).toEqual([23, null]);
    const rows = pollHealAttempts({ dir: h.dir, observe: (id, options) => observeHealAttempt(id, { ...options, settle: h.settle }) });
    expect(rows[0]).toMatchObject({ status: 'resolved', result: { outcome: 'executor-failed', exitCode: null } });
    expect(readHealAttempt(attempt.attemptId, { dir: h.dir }).handle).toBe(handle);
    expect(countCiHealComments(h.comments)).toBe(1);
  });

  it.each([true, null, 'unknown'])('preserves live or unreadable liveness (%s), and startup grace', live => {
    const h = attemptHarness(), row = h.start(); bindHealAttempt(row.attemptId, 'pid:77', { dir: h.dir });
    expect(h.observe(row.attemptId, { isPidAlive: () => live }).status).toBe(live === true ? 'running' : 'unresolved');
    expect(h.observe(row.attemptId, { now: () => new Date(row.startedAt) }).status).toBe('running');
    expect(h.published).toEqual([]);
    expect(h.observe(row.attemptId, { handle: 'pid:78' }).status).toBe('unresolved');
    expect(h.observe(row.attemptId, { isPidAlive: () => { throw new Error('permission denied'); } }).status).toBe('unresolved');
    expect(readHealAttempt(row.attemptId, { dir: h.dir }).terminal).toBeNull();
  });

  it('keeps an unsuccessful publication owed and the claim held, then counts once after an ambiguous post', () => {
    const h = attemptHarness(); acquireFixDispatchClaim({ repo: 'we', pr: 3373, kind: 'ci-heal', owner: 'attempt-owner', lockRoot: h.lockRoot });
    const row = h.start({ claimOwner: 'attempt-owner', claimRoot: h.lockRoot }); bindHealAttempt(row.attemptId, 'pid:77', { dir: h.dir });
    h.publication.post = ({ body }) => { h.comments.push({ body, author: { login: 'web-everything' } }); throw new Error('connection reset after write'); };
    expect(h.observe(row.attemptId)).toMatchObject({ status: 'unresolved', error: 'connection reset after write' });
    expect(readOwedWrites({ dir: h.owed })).toHaveLength(1);
    expect(listFixDispatchClaims(h.lockRoot)).toHaveLength(1);
    expect(h.observe(row.attemptId).status).toBe('resolved');
    expect(countCiHealComments(h.comments)).toBe(1);
    expect(listFixDispatchClaims(h.lockRoot)).toHaveLength(0);
    expect(readOwedWrites({ dir: h.owed })).toHaveLength(0);
  });

  it('retains terminal success, refuses ambiguous ownership, and cannot release another repair claim', () => {
    const h = attemptHarness();
    acquireFixDispatchClaim({ repo: 'we', pr: 3373, kind: 'ci-heal', owner: 'new-attempt', lockRoot: h.lockRoot });
    const row = h.start({ claimOwner: 'old-attempt', claimRoot: h.lockRoot }); bindHealAttempt(row.attemptId, 'pid:77', { dir: h.dir });
    h.settle(row.attemptId, { outcome: 'healed', pushed: true, detail: 'repair pushed' });
    expect(h.observe(row.attemptId).result.outcome).toBe('healed');
    expect(listFixDispatchClaims(h.lockRoot)[0].owner).toBe('new-attempt');
    expect(h.observe(row.attemptId, { pr: 1 }).status).toBe('unresolved');
    expect(h.observe(row.attemptId, { handle: 'pid:999' }).status).toBe('unresolved');
    expect(countCiHealComments(h.comments)).toBe(1);
  });

  it('refuses recovery when attempt ownership cannot be read', () => {
    const h = attemptHarness(), row = h.start();
    writeFileSync(join(h.dir, `${row.attemptId}.json`), '{broken');
    expect(h.observe(row.attemptId).status).toBe('unresolved');
    // the round-2 review narrowed the blast radius: the poll reports the corrupt row instead of aborting the repo pass
    expect(pollHealAttempts({ dir: h.dir, warn: () => {} })).toEqual([expect.objectContaining({ pr: null, status: 'unresolved' })]);
  });
});

describe('xp0lsdi wrapper terminal boundary', () => {
  it.each(['acquireLane', 'runWorker', 'diffNumstat'])('records thrown %s failure without losing terminal completion', async method => {
    const { io, calls } = fakeIo(); io.settleAttempt = vi.fn();
    io[method] = () => { throw Object.assign(new Error('wrapper exception'), { status: 23, signal: null }); };
    expect(await runProbationHeal(args(), io)).toMatchObject({ outcome: 'executor-failed', exitCode: 23, quotaState: 'unknown' });
    expect(calls).toContainEqual(['completion', 'done', 'executor-failed']);
    expect(io.settleAttempt).toHaveBeenCalledOnce();
  });
  it('records graceful quota failure with no diff and keeps unknown cause distinct', async () => {
    const { io } = fakeIo({ numstat: '' }); io.settleAttempt = vi.fn();
    io.runWorker = () => ({ ok: false, status: 1, out: 'Individual quota reached', modelEvidence: { quotaState: 'exhausted', quotaResetsAt: '2026-10-04T17:31:18.942Z' } });
    expect((await runProbationHeal(args(), io)).outcome).toBe('escalated-needs-human');
    expect(io.settleAttempt.mock.calls[0][1]).toMatchObject({ pushed: false, exitCode: 1, quotaState: 'exhausted' });
  });
  it('propagates accounting persistence failure instead of completing an uncounted retry', async () => {
    const { io } = fakeIo(); io.settleAttempt = () => { throw new Error('disk full'); }; io.completion = vi.fn();
    await expect(runProbationHeal(args(), io)).rejects.toThrow('disk full');
    expect(io.completion.mock.calls.some(([row]) => row.status === 'done')).toBe(false);
  });
});


import { selectProbationWorker } from '../../lib/provider-routing.mjs';
import { readAgyHold, saveAgyHold } from '../../lib/antigravity-run-evidence.mjs';

it('xp0lsdi: real backend holds expire independently, and selection preserves veto and simple-only rules', () => {
  const h = attemptHarness(), now = Date.parse('2026-10-02T12:00:00Z');
  saveAgyHold({ requestedModel: 'claude-sonnet-4-6', servedBackend: 'anthropic', quotaState: 'exhausted', quotaResetsAt: new Date(now + 1000).toISOString() }, { dir: h.dir });
  expect(readAgyHold('claude-sonnet-4-6', { dir: h.dir, now })).not.toBeNull();
  expect(readAgyHold('gemini-3.1-pro', { dir: h.dir, now })).toBeNull();
  expect(readAgyHold('claude-sonnet-4-6', { dir: h.dir, now: now + 1000 })).toBeNull();
  const quota = { readScores: () => [], now, readHolds: (model, options) => readAgyHold(model, { ...options, dir: h.dir }) };
  expect(routeAvailableCiHeal({ scope: ['we:src/a.ts'] }, quota).probationWorker.id).toBe('codex');
  expect(routeAvailableCiHeal({ scope: ['we:src/a.ts'] }, { ...quota, now: now + 1000 }).probationWorker.id).toBe('antigravity-claude');
  const common = { taskType: 'ci-heal', availability: { 'antigravity-claude': 'held' } };
  const codex = selectProbationWorker(common).worker;
  expect(selectProbationWorker({ ...common, vetoes: [{ provider: codex.provider, model: codex.model, taskType: 'ci-heal' }] }).worker).toBeNull();
  const gemini = selectProbationWorker({ ...common, simple: true, vetoes: [{ provider: codex.provider, model: codex.model, taskType: 'ci-heal' }] }).worker;
  expect(gemini).toMatchObject({ id: 'antigravity-gemini', checker: 'codex', supervision: 'full' });
});


it('xp0lsdi: an ownership refusal cannot be caught as permission to settle someone else’s attempt', async () => {
  const { io } = fakeIo(); io.settleAttempt = vi.fn(); io.bindAttempt = () => { throw new Error('ambiguous ownership'); };
  await expect(runProbationHeal({ ...args(), attemptId: 'foreign-attempt' }, io)).rejects.toThrow('ambiguous ownership');
  expect(io.settleAttempt).not.toHaveBeenCalled();
});

describe('PR #3577 review: attempt rows never become a permanent CI-heal barrier', () => {
  const request = () => ({ launchKind: 'ci-heal', headRefOid: captured3373.headRefOid, pr: 3373, sessionSlug: 'ci-heal-3373', probationWorker: agyClaude, cwd: '/scratch' });
  const unresolved = (h) => pollHealAttempts({ dir: h.dir, now: h.now, observe: h.observe }).filter(r => r.status !== 'resolved');

  it('a spawn that throws before any process exists settles the attempt as failed, so nothing stays pending', () => {
    const h = attemptHarness();
    const boom = Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
    expect(() => probationWorkerDetachedProvider(request(), {
      spawnDetached: () => { throw boom; }, logPathFor: () => '/dev/null',
      beginAttempt: (r, o) => beginHealAttempt(r, { ...o, dir: h.dir, now: () => '2026-10-02T00:00:00Z' }),
      failAttempt: (id, detail) => failHealAttempt(id, detail, { dir: h.dir, publish: row => publishHealAttempt(row, h.publication), complete: () => {} }),
    })).toThrow(boom);
    const [row] = pollHealAttempts({ dir: h.dir, now: h.now, observe: h.observe });
    expect(row.status).toBe('resolved');
    expect(readHealAttempt(row.attemptId, { dir: h.dir })).toMatchObject({ settled: true, terminal: { outcome: 'executor-failed', pushed: false } });
    expect(unresolved(h)).toEqual([]);
    expect(h.published).toHaveLength(1); // one cap-counted failure marker
    // a failed settlement must never mask the original launch error
    expect(() => probationWorkerDetachedProvider(request(), {
      spawnDetached: () => { throw boom; }, logPathFor: () => '/dev/null',
      beginAttempt: (r, o) => beginHealAttempt(r, { ...o, dir: h.dir, now: () => '2026-10-02T00:00:00Z' }),
      failAttempt: () => { throw new Error('settle failed'); },
    })).toThrow(boom);
  });

  it('a spawn that reports no pid stays fail-closed inside the grace window, then ages out to a settled failure', () => {
    const h = attemptHarness();
    expect(() => probationWorkerDetachedProvider(request(), {
      spawnDetached: () => ({}), logPathFor: () => '/dev/null',
      beginAttempt: (r, o) => beginHealAttempt(r, { ...o, dir: h.dir, now: () => '2026-10-02T00:00:00Z' }),
      failAttempt: () => { throw new Error('ambiguous launches must not be settled eagerly'); },
    })).toThrow(/no pid/);
    const early = () => pollHealAttempts({ dir: h.dir, now: h.now, observe: (id, o) => h.observe(id, { ...o, now: () => new Date('2026-10-02T00:00:30Z') }) });
    expect(early()[0].status).toBe('unresolved');
    const late = pollHealAttempts({ dir: h.dir, now: h.now, observe: h.observe });
    expect(late[0].status).toBe('resolved');
    expect(late[0].result.outcome).toBe('executor-failed');
    expect(unresolved(h)).toEqual([]);
  });

  it('a settled row written by another host is resolved; only the liveness probe depends on the host', () => {
    const h = attemptHarness();
    const { attemptId } = h.start();
    bindHealAttempt(attemptId, 'pid:43273', { dir: h.dir });
    h.settle(attemptId, { outcome: 'executor-failed', pushed: false, exitCode: 1, signal: null, quotaState: 'unknown', detail: 'x' });
    const path = join(h.dir, `${attemptId}.json`);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), host: 'old-name.local' }) + '\n');
    expect(h.observe(attemptId, { repo: 'we', pr: 3373, handle: 'pid:43273' }).status).toBe('resolved');
    // a live-looking row with no terminal on a foreign host is still refused — its pid means nothing here
    const second = h.start().attemptId;
    bindHealAttempt(second, 'pid:51', { dir: h.dir });
    const p2 = join(h.dir, `${second}.json`);
    writeFileSync(p2, JSON.stringify({ ...JSON.parse(readFileSync(p2, 'utf8')), host: 'old-name.local' }) + '\n');
    expect(h.observe(second, { repo: 'we', pr: 3373 }).status).toBe('unresolved');
  });
});

describe('PR #3577 round 2 review: CI-heal attempt bookkeeping stays bounded, isolated and non-leaking', () => {
  const failed = (detail, extra = {}) => ({ outcome: 'executor-failed', pushed: false, exitCode: 1, signal: null, quotaState: 'unknown', detail, ...extra });
  const rowPath = (h, id) => join(h.dir, `${id}.json`);

  it('does no lock or settle work for rows that are already settled', () => {
    const h = attemptHarness();
    for (let i = 0; i < 100; i++) h.settle(h.start().attemptId, failed('x'));
    const settle = vi.fn(() => { throw new Error('a settled row must not be settled again'); });
    const rows = pollHealAttempts({ dir: h.dir, now: h.now, observe: (id, o) => h.observe(id, { ...o, settle }) });
    expect(rows).toHaveLength(100);
    expect(rows.every(r => r.status === 'resolved')).toBe(true);
    expect(settle).not.toHaveBeenCalled();
  });

  it('prunes long-settled rows but keeps recent settled and every unsettled row', () => {
    const h = attemptHarness();
    const old = h.start().attemptId, recent = h.start().attemptId, open = h.start().attemptId;
    h.settle(old, failed('x')); h.settle(recent, failed('x'));
    const age = (id, startedAt) => writeFileSync(rowPath(h, id), JSON.stringify({ ...JSON.parse(readFileSync(rowPath(h, id), 'utf8')), startedAt }) + '\n');
    age(old, '2026-09-01T00:00:00Z'); age(recent, '2026-10-01T00:00:00Z'); age(open, '2026-09-01T00:00:00Z');
    pollHealAttempts({ dir: h.dir, now: () => new Date('2026-10-02T12:00:00Z'), observe: () => ({ status: 'running', result: null }) });
    expect(existsSync(rowPath(h, old))).toBe(false);
    expect(existsSync(rowPath(h, recent))).toBe(true);
    expect(existsSync(rowPath(h, open))).toBe(true);
  });

  it('one unreadable row neither aborts the poll nor holds an unrelated PR', () => {
    const h = attemptHarness();
    const good = h.start().attemptId, broken = h.start({ headRefOid: captured3373.headRefOid }).attemptId, garbage = h.start().attemptId;
    const strip = JSON.parse(readFileSync(rowPath(h, broken), 'utf8')); delete strip.headSha;
    writeFileSync(rowPath(h, broken), JSON.stringify({ ...strip, pr: 4000 }) + '\n');
    writeFileSync(rowPath(h, garbage), '{broken');
    const warn = vi.fn();
    const all = pollHealAttempts({ dir: h.dir, now: h.now, observe: h.observe, warn });
    expect(all.find(r => r.attemptId === good).status).toBe('resolved');
    expect(all.find(r => r.attemptId === broken)).toMatchObject({ pr: 4000, status: 'unresolved' });
    expect(warn).toHaveBeenCalledTimes(2);
    // the PR-scoped read used by dispatchCiHeal holds only the PR whose row is readable
    expect(pollHealAttempts({ dir: h.dir, now: h.now, observe: h.observe, pr: 3373, warn }).filter(r => r.status !== 'resolved')).toEqual([]);
    expect(pollHealAttempts({ dir: h.dir, now: h.now, observe: h.observe, pr: 4000, warn }).filter(r => r.status !== 'resolved')).toHaveLength(1);
  });

  it.each([
    ['a foreign-host row', row => ({ ...row, host: 'old-name.local', handle: 'pid:51' }), () => false],
    ['a recycled pid that looks alive', row => ({ ...row, handle: 'pid:51' }), () => true],
  ])('settles %s older than the age ceiling as a failed attempt instead of holding the PR forever', (_name, mutate, isPidAlive) => {
    const h = attemptHarness();
    const { attemptId } = h.start();
    writeFileSync(rowPath(h, attemptId), JSON.stringify(mutate(JSON.parse(readFileSync(rowPath(h, attemptId), 'utf8')))) + '\n');
    const young = h.observe(attemptId, { isPidAlive, now: () => new Date('2026-10-02T00:30:00Z') });
    expect(young.status).not.toBe('resolved');
    const aged = h.observe(attemptId, { isPidAlive, now: () => new Date('2026-10-02T12:00:00Z') });
    expect(aged.status).toBe('resolved');
    expect(aged.result).toMatchObject({ outcome: 'executor-failed', pushed: false });
    expect(aged.result.detail).toMatch(/exceeded/);
  });

  it('redacts a long unbroken alphanumeric run in linear time (no quadratic regex backtracking)', () => {
    const started = Date.now();
    redactSecrets('a'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops holding a PR for an unreadable row once it is older than the age ceiling', () => {
    const h = attemptHarness(), { attemptId } = h.start();
    const strip = JSON.parse(readFileSync(rowPath(h, attemptId), 'utf8')); delete strip.headSha;
    writeFileSync(rowPath(h, attemptId), JSON.stringify(strip) + '\n');
    const warn = () => {};
    const fresh = pollHealAttempts({ dir: h.dir, pr: 3373, warn });
    expect(fresh).toHaveLength(1);
    const aged = pollHealAttempts({ dir: h.dir, pr: 3373, warn, now: () => new Date(Date.now() + 4 * 60 * 60_000) });
    expect(aged).toEqual([]);
  });

  it('never publishes raw worker or log text: unlisted secret shapes cannot reach the public comment', () => {
    const h = attemptHarness();
    const leaks = ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX', 'Cookie: sessionid=abcdef0123456789', 'internal-db-7.corp.example'];
    h.settle(h.start().attemptId, failed(leaks.join('\n'), { exitCode: 7, signal: 'SIGTERM', quotaState: 'exhausted', quotaResetsAt: '2026-10-04T17:31:18.942Z' }));
    const [body] = h.published;
    for (const leak of leaks) expect(body).not.toContain(leak);
    expect(body).toMatch(/exit: 7; signal: SIGTERM; quota: exhausted; reset: 2026-10-04T17:31:18.942Z/);
  });

  it('never publishes a credential an upstream truncation cut the prefix off of (4000-char and 2000-byte boundaries)', async () => {
    const h = attemptHarness();
    const secret = 'ghp_' + 'Q'.repeat(36);
    // (a) the worker output / settle detail boundary
    const { io } = fakeIo(); let workerRow;
    io.settleAttempt = (id, terminal) => { workerRow = h.settle(h.start().attemptId, terminal); };
    io.runWorker = () => ({ ok: false, status: 1, out: `${secret} ${'k'.repeat(3980)}`, modelEvidence: {} });
    await runProbationHeal(args(), io);
    // the persisted worker diagnostics were redacted before the 4000-char cut, not cut into a bare fragment
    expect(workerRow.terminal.diagnostics).not.toMatch(/Q{4}/);
    expect(workerRow.terminal.diagnostics).toMatch(/k{100}/);
    // (b) the crashed-wrapper log tail boundary
    const logPath = join(h.dir, 'wrapper.log'); writeFileSync(logPath, secret + 'k'.repeat(1990));
    const { attemptId } = h.start({}); writeFileSync(rowPath(h, attemptId), JSON.stringify({ ...JSON.parse(readFileSync(rowPath(h, attemptId), 'utf8')), logPath }) + '\n');
    expect(h.observe(attemptId).status).toBe('resolved');
    expect(h.published.length).toBeGreaterThan(0);
    for (const body of h.published) expect(body).not.toMatch(/Q{4}/);
    // the local row keeps its diagnostics, with the credential redacted before the cut
    expect(readHealAttempt(attemptId, { dir: h.dir }).terminal.detail).not.toMatch(/Q{4}/);
  });
});

it('suppresses real state with WE_UNDER_TEST alone', () => {
  expect(probationLaunchFromEnv({ WE_UNDER_TEST: '1' })).toBe('off');
});
