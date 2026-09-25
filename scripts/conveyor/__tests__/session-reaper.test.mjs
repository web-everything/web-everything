/**
 * @file scripts/conveyor/__tests__/session-reaper.test.mjs
 * @description Unit proof of the conveyor SESSION REAPER's PURE core (WE #3435, plus the ground-truth axis
 *   found live 2026-09-03 on `conveyor-3451`). Drives {@link classifySessionReap} / {@link sessionTarget} /
 *   {@link classifySessionReapWithGroundTruth} / {@link sessionReapPlan} directly with fixtures shaped exactly
 *   as `claude agents --json` reports them (NO fs / exec / clock) — pins the Done-when #2 proof (a mixed
 *   working/blocked/done/failed/stopped listing only reaps `done`/`failed`, never a live or blocked one)
 *   plus the `kind !== 'background'` guard against ever touching an interactive session, AND the new proof
 *   that a `working`/`blocked` session is reaped once — and ONLY once — its own target is confirmed done.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySessionReap,
  classifySessionReapWithGroundTruth,
  sessionTarget,
  sessionReapPlan,
  groundTruthForItem,
  groundTruthForPr,
  makeGroundTruthResolver,
  makeCompletionResolver,
  DEFAULT_IDLE_REAP_THRESHOLD_MS,
  TERMINAL_REAP_STATES,
  ALREADY_STOPPED_STATES,
  stopSessionWithRetry,
  STOP_RETRY_ATTEMPTS,
  STOP_RETRY_BACKOFF_MS,
  runSessionReaperPass,
  makeHungResolver,
  planBackstopCompletion,
  UNREPORTED_EXIT_OUTCOME,
} from '../session-reaper.mjs';

const bg = (over = {}) => ({ id: 'abc12345', cwd: '/repo', kind: 'background', startedAt: 1, sessionId: 'abc12345-0000-0000-0000-000000000000', name: 'conveyor-1', ...over });
const interactive = (over = {}) => ({ pid: 111, cwd: '/repo', kind: 'interactive', startedAt: 1, sessionId: 'def67890-0000-0000-0000-000000000000', name: 'my terminal', ...over });

describe('classifySessionReap — the per-row verdict', () => {
  it('a `done` background session is reaped', () => {
    expect(classifySessionReap(bg({ state: 'done' }))).toEqual({ reap: true, reason: 'done' });
  });
  it('a `failed` background session is reaped', () => {
    expect(classifySessionReap(bg({ state: 'failed' }))).toEqual({ reap: true, reason: 'failed' });
  });
  it('a `working` background session is never reaped — still live', () => {
    expect(classifySessionReap(bg({ state: 'working' }))).toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('a `blocked` background session is never reaped — may simply not have started yet (#3435 found-live #2)', () => {
    expect(classifySessionReap(bg({ state: 'blocked' }))).toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('an already-`stopped` background session needs no action', () => {
    expect(classifySessionReap(bg({ state: 'stopped' }))).toEqual({ reap: false, reason: 'already-stopped' });
  });
  it('a session with no `state` at all is never reaped', () => {
    const { state, ...noState } = bg({ state: 'done' });
    expect(classifySessionReap(noState)).toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('an INTERACTIVE session is never reaped, even carrying a terminal-looking state (structural guard)', () => {
    expect(classifySessionReap(interactive({ state: 'done' }))).toEqual({ reap: false, reason: 'not-background' });
    expect(classifySessionReap(interactive())).toEqual({ reap: false, reason: 'not-background' });
  });
  it('degenerate input never throws', () => {
    expect(classifySessionReap(null)).toEqual({ reap: false, reason: 'not-terminal' });
    expect(classifySessionReap(undefined)).toEqual({ reap: false, reason: 'not-terminal' });
    expect(classifySessionReap('not-an-object')).toEqual({ reap: false, reason: 'not-terminal' });
  });
});

describe('TERMINAL_REAP_STATES / ALREADY_STOPPED_STATES — the state sets themselves', () => {
  it('names exactly the states measured live against a real `claude agents --json --all` listing', () => {
    expect([...TERMINAL_REAP_STATES].sort()).toEqual(['done', 'failed']);
    expect([...ALREADY_STOPPED_STATES].sort()).toEqual(['stopped']);
  });
});

describe('sessionReapPlan — Done-when #2: a mixed listing only reaps the terminal background ones', () => {
  it('splits a fabricated working/blocked/done/failed/stopped/interactive listing correctly', () => {
    const listing = [
      bg({ sessionId: 'live-1', state: 'working', name: 'conveyor-10' }),
      bg({ sessionId: 'blocked-1', state: 'blocked', name: 'review-20' }),
      bg({ sessionId: 'done-1', state: 'done', name: 'conveyor-30' }),
      bg({ sessionId: 'done-2', state: 'done', name: 'review-40' }),
      bg({ sessionId: 'failed-1', state: 'failed', name: 'fix-50' }),
      bg({ sessionId: 'stopped-1', state: 'stopped', name: 'conveyor-60' }),
      interactive({ sessionId: 'interactive-1', name: 'operator terminal' }),
    ];
    const { reap, keep } = sessionReapPlan(listing);

    expect(reap.map((r) => r.session.sessionId).sort()).toEqual(['done-1', 'done-2', 'failed-1']);
    expect(reap.every((r) => ['done', 'failed'].includes(r.reason))).toBe(true);

    const keptIds = keep.map((r) => r.session.sessionId).sort();
    expect(keptIds).toEqual(['blocked-1', 'interactive-1', 'live-1', 'stopped-1']);
    // Never a live one, never a blocked one, never the interactive one — the exact Done-when #2 proof.
    expect(keep.find((r) => r.session.sessionId === 'live-1').reason).toBe('not-terminal');
    expect(keep.find((r) => r.session.sessionId === 'blocked-1').reason).toBe('not-terminal');
    expect(keep.find((r) => r.session.sessionId === 'interactive-1').reason).toBe('not-background');
    expect(keep.find((r) => r.session.sessionId === 'stopped-1').reason).toBe('already-stopped');
  });

  it('a non-array input reaps nothing', () => {
    expect(sessionReapPlan(null)).toEqual({ reap: [], keep: [] });
    expect(sessionReapPlan(undefined)).toEqual({ reap: [], keep: [] });
  });

  it('an empty listing reaps nothing', () => {
    expect(sessionReapPlan([])).toEqual({ reap: [], keep: [] });
  });
});

describe('sessionTarget — the dispatcher-minted grammar a session name encodes', () => {
  it('item-kind names (conveyor / prepare / prepare-decision), with a retry-attempt letter collapsed to the base', () => {
    expect(sessionTarget('conveyor-3451')).toEqual({ kind: 'item', id: '3451' });
    expect(sessionTarget('conveyor-3411b')).toEqual({ kind: 'item', id: '3411' });
    expect(sessionTarget('prepare-3399')).toEqual({ kind: 'item', id: '3399' });
    expect(sessionTarget('prepare-decision-3457')).toEqual({ kind: 'item', id: '3457' });
  });
  it('PR-kind names (review / fix / ci-heal / inspect) — a PR number, never an item number', () => {
    expect(sessionTarget('review-1871')).toEqual({ kind: 'pr', id: '1871', repo: 'we' });
    expect(sessionTarget('fix-1852')).toEqual({ kind: 'pr', id: '1852', repo: 'we' });
    expect(sessionTarget('ci-heal-1852c')).toEqual({ kind: 'pr', id: '1852', repo: 'we' });
    // epic #3383's diagnosis-only stuck-PR inspection dispatch — covered for free by the shared grammar.
    expect(sessionTarget('inspect-2505')).toEqual({ kind: 'pr', id: '2505', repo: 'we' });
    expect(sessionTarget('inspect-pa-176')).toEqual({ kind: 'pr', id: '176', repo: 'plateau-app' });
  });
  it('an unrecognized name (a stray operator label, no grammar) yields null — never a guess', () => {
    expect(sessionTarget('test-dontask')).toBeNull();
    expect(sessionTarget('pr review resume')).toBeNull();
    expect(sessionTarget('my terminal')).toBeNull();
    expect(sessionTarget(null)).toBeNull();
    expect(sessionTarget(undefined)).toBeNull();
  });
});

describe('classifySessionReapWithGroundTruth — the new axis found live on `conveyor-3451`', () => {
  it('omitting the resolver is byte-identical to classifySessionReap (strictly additive)', () => {
    for (const state of ['done', 'failed', 'working', 'blocked', 'stopped', undefined]) {
      const session = bg({ state });
      expect(classifySessionReapWithGroundTruth(session)).toEqual(classifySessionReap(session));
      expect(classifySessionReapWithGroundTruth(session, null)).toEqual(classifySessionReap(session));
    }
  });
  it('a `working`/`blocked` session is reaped once its target reads resolved — the conveyor-3451 shape', () => {
    const resolved = () => ({ resolved: true, evidence: 'backlog#3451:resolved' });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'conveyor-3451' }), resolved)).toEqual({
      reap: true,
      reason: 'ground-truth-item:backlog#3451:resolved',
    });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'prepare-decision-3457' }), resolved)).toEqual({
      reap: true,
      reason: 'ground-truth-item:backlog#3451:resolved',
    });
  });
  it('a `working` PR-kind session is reaped once its PR reads merged', () => {
    const merged = () => ({ resolved: true, evidence: 'pr#1862:merged' });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-1862' }), merged)).toEqual({
      reap: true,
      reason: 'ground-truth-pr:pr#1862:merged',
    });
  });
  it('never reaps when the resolver says not resolved — the genuinely-still-open shape', () => {
    const stillOpen = () => ({ resolved: false });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'conveyor-2786' }), stillOpen)).toEqual({
      reap: false,
      reason: 'not-terminal',
    });
  });
  it('never reaps when the resolver answer is unknown (null) — an unreadable signal is never a green light', () => {
    const unknown = () => null;
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'conveyor-3399' }), unknown)).toEqual({
      reap: false,
      reason: 'not-terminal',
    });
  });
  it('never calls the resolver for a name matching no known grammar — never a guess', () => {
    let called = false;
    const spy = () => {
      called = true;
      return { resolved: true };
    };
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'test-dontask' }), spy)).toEqual({
      reap: false,
      reason: 'not-terminal',
    });
    expect(called).toBe(false);
  });
  it('never upgrades an already-terminal or already-stopped or interactive verdict, even if the resolver would say resolved', () => {
    const alwaysResolved = () => ({ resolved: true });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'done', name: 'conveyor-1' }), alwaysResolved)).toEqual({ reap: true, reason: 'done' });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'stopped', name: 'conveyor-1' }), alwaysResolved)).toEqual({ reap: false, reason: 'already-stopped' });
    expect(classifySessionReapWithGroundTruth(interactive({ state: 'blocked', name: 'conveyor-1' }), alwaysResolved)).toEqual({ reap: false, reason: 'not-background' });
  });
});

describe('sessionReapPlan with groundTruthFor — end to end over a mixed listing', () => {
  it('reaps done/failed via the base axis AND working/blocked via ground truth, keeps everything else', () => {
    const listing = [
      bg({ sessionId: 'done-1', state: 'done', name: 'conveyor-1' }),
      bg({ sessionId: 'blocked-resolved', state: 'blocked', name: 'conveyor-3451' }),
      bg({ sessionId: 'working-resolved', state: 'working', name: 'prepare-3399' }),
      bg({ sessionId: 'working-open', state: 'working', name: 'conveyor-2786' }),
      bg({ sessionId: 'working-unnamed', state: 'working', name: 'test-dontask' }),
    ];
    const resolvedIds = new Set(['3451', '3399']);
    const groundTruthFor = (target) => (target.kind === 'item' && resolvedIds.has(target.id) ? { resolved: true, evidence: `backlog#${target.id}` } : { resolved: false });

    const { reap, keep } = sessionReapPlan(listing, { groundTruthFor });
    expect(reap.map((r) => r.session.sessionId).sort()).toEqual(['blocked-resolved', 'done-1', 'working-resolved']);
    expect(keep.map((r) => r.session.sessionId).sort()).toEqual(['working-open', 'working-unnamed']);
  });

  it('with no groundTruthFor at all, behaves exactly as the original state-only plan', () => {
    const listing = [
      bg({ sessionId: 'blocked-resolved', state: 'blocked', name: 'conveyor-3451' }),
      bg({ sessionId: 'done-1', state: 'done', name: 'conveyor-1' }),
    ];
    const { reap, keep } = sessionReapPlan(listing);
    expect(reap.map((r) => r.session.sessionId)).toEqual(['done-1']);
    expect(keep.map((r) => r.session.sessionId)).toEqual(['blocked-resolved']);
  });
});

describe('groundTruthForItem — the local, unbounded backlog-status IO helper', () => {
  const fakeIo = (files) => ({
    readdirSyncFn: () => Object.keys(files),
    readFileSyncFn: (path) => {
      const name = path.split('/').pop();
      if (!(name in files)) throw new Error(`ENOENT: ${path}`);
      return files[name];
    },
  });

  it('resolved:true only when status is exactly `resolved`, matching by id prefix', () => {
    const io = fakeIo({ '3451-build-the-thing.md': '---\nstatus: resolved\n---\n# T\n' });
    expect(groundTruthForItem('3451', { backlogDir: '/backlog', ...io })).toEqual({ resolved: true, evidence: 'backlog#3451:resolved' });
  });
  it('resolved:false for any other status', () => {
    const io = fakeIo({ '2786-close-the-gap.md': '---\nstatus: active\n---\n# T\n' });
    expect(groundTruthForItem('2786', { backlogDir: '/backlog', ...io })).toEqual({ resolved: false });
  });
  it('resolved:false, never true, when no card matches the id at all — absence is never done', () => {
    const io = fakeIo({ '9999-unrelated.md': '---\nstatus: resolved\n---\n' });
    expect(groundTruthForItem('3451', { backlogDir: '/backlog', ...io })).toEqual({ resolved: false });
  });
  it('a numeric-prefix collision (id "3" vs file "345-...") never false-matches — the hyphen boundary holds', () => {
    const io = fakeIo({ '345-something-else.md': '---\nstatus: resolved\n---\n' });
    expect(groundTruthForItem('3', { backlogDir: '/backlog', ...io })).toEqual({ resolved: false });
  });
  it('returns null (unknown) when the backlog directory itself is unreadable', () => {
    const io = { readdirSyncFn: () => { throw new Error('ENOENT'); }, readFileSyncFn: () => '' };
    expect(groundTruthForItem('3451', { backlogDir: '/nope', ...io })).toBeNull();
  });
});

describe('groundTruthForPr — the bounded, network gh pr view IO helper', () => {
  it('resolved:true when gh reports a mergedAt timestamp', () => {
    const exec = () => JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-03T11:57:41Z' });
    expect(groundTruthForPr('1862', { exec })).toEqual({ resolved: true, evidence: 'pr#1862:merged' });
  });
  it('resolved:true when state reads MERGED even without a mergedAt field', () => {
    const exec = () => JSON.stringify({ state: 'MERGED' });
    expect(groundTruthForPr('1862', { exec })).toEqual({ resolved: true, evidence: 'pr#1862:merged' });
  });
  it('resolved:false for an open PR — the review-1871 shape', () => {
    const exec = () => JSON.stringify({ state: 'OPEN', mergedAt: null });
    expect(groundTruthForPr('1871', { exec })).toEqual({ resolved: false });
  });
  it('returns null (unknown) when gh itself fails — never reaps on an unreadable signal', () => {
    const exec = () => { throw new Error('gh: command not found'); };
    expect(groundTruthForPr('1862', { exec })).toBeNull();
  });
});

describe('makeGroundTruthResolver — routing, caching, and the gh pr view call cap', () => {
  it('routes item-kind to the local backlog read and pr-kind to gh, each exactly once per distinct target (caching)', () => {
    let itemReads = 0;
    let prCalls = 0;
    const resolver = makeGroundTruthResolver({
      backlogDir: '/backlog',
      readdirSyncFn: () => { itemReads++; return ['3451-x.md']; },
      readFileSyncFn: () => '---\nstatus: resolved\n---\n',
      exec: () => { prCalls++; return JSON.stringify({ state: 'MERGED' }); },
    });
    expect(resolver({ kind: 'item', id: '3451' })).toEqual({ resolved: true, evidence: 'backlog#3451:resolved' });
    expect(resolver({ kind: 'item', id: '3451' })).toEqual({ resolved: true, evidence: 'backlog#3451:resolved' });
    expect(resolver({ kind: 'pr', id: '1862' })).toEqual({ resolved: true, evidence: 'pr#1862:merged' });
    expect(resolver({ kind: 'pr', id: '1862' })).toEqual({ resolved: true, evidence: 'pr#1862:merged' });
    expect(itemReads).toBe(1); // cached — the second identical lookup cost nothing
    expect(prCalls).toBe(1); // cached — same
  });

  it('bounds gh pr view calls at maxPrViewCalls — a candidate past the cap reads null (unknown), not an unbounded burst', () => {
    let prCalls = 0;
    const resolver = makeGroundTruthResolver({
      maxPrViewCalls: 1,
      exec: () => { prCalls++; return JSON.stringify({ state: 'MERGED' }); },
    });
    expect(resolver({ kind: 'pr', id: '1' })).toEqual({ resolved: true, evidence: 'pr#1:merged' });
    expect(resolver({ kind: 'pr', id: '2' })).toBeNull(); // past the cap — never called
    expect(prCalls).toBe(1);
  });

  it('local item-kind lookups are never subject to the gh call cap', () => {
    const resolver = makeGroundTruthResolver({
      maxPrViewCalls: 0,
      backlogDir: '/backlog',
      readdirSyncFn: () => ['1-x.md', '2-y.md'],
      readFileSyncFn: () => '---\nstatus: resolved\n---\n',
    });
    expect(resolver({ kind: 'item', id: '1' })).toEqual({ resolved: true, evidence: 'backlog#1:resolved' });
    expect(resolver({ kind: 'item', id: '2' })).toEqual({ resolved: true, evidence: 'backlog#2:resolved' });
  });
});

// ── stopSessionWithRetry — WE #3479, found live 2026-09-04: the ONE session-reaper.mjs mechanical-pass failure
//    `runner.log` recorded over a 190+-tick live overnight run traced to a per-candidate `claude stop` failure
//    tripping the WHOLE pass's exit code, undiagnosable only because `runQuiet`'s own truncation (see
//    `skills-src/conveyor/runner.mjs`'s `summarizeMechanicalPassError`) discarded the real error text. A live
//    concurrency stress test (25 concurrent `claude stop` + 10 concurrent `claude agents --json --all` calls,
//    repeated) never reproduced a hard failure, so the retry targets a real-but-rare transient class, not a
//    reproduced deterministic bug — this proves the RETRY mechanics in isolation with a fake `exec`. ───────────

describe('stopSessionWithRetry — recovers a transient `claude stop` failure instead of failing the whole pass', () => {
  function flakyExec(failTimes, { message = 'some transient CLI-internal lock' } = {}) {
    let calls = 0;
    const fn = (..._args) => {
      calls++;
      if (calls <= failTimes) {
        const e = new Error(`Command failed: claude stop`);
        e.stderr = message;
        throw e;
      }
      return 'stopped abcd1234\n';
    };
    Object.defineProperty(fn, 'calls', { get: () => calls });
    return fn;
  }

  it('succeeds on the first attempt when `claude stop` succeeds immediately — no retry, no sleep', () => {
    const exec = flakyExec(0);
    let slept = 0;
    const res = stopSessionWithRetry({ handle: 'abcd1234', exec, sleep: () => { slept++; } });
    expect(res).toEqual({ stopped: true, alreadyGone: false, output: 'stopped abcd1234\n' });
    expect(exec.calls).toBe(1);
    expect(slept).toBe(0);
  });

  it('recovers a transient failure that clears within the retry budget (fails once, succeeds on retry 2)', () => {
    const exec = flakyExec(1);
    const sleeps = [];
    const res = stopSessionWithRetry({ handle: 'abcd1234', exec, sleep: (ms) => sleeps.push(ms) });
    expect(res.stopped).toBe(true);
    expect(exec.calls).toBe(2);
    expect(sleeps).toEqual([STOP_RETRY_BACKOFF_MS[0]]); // one backoff wait, before the 2nd attempt
  });

  it(`still throws once ALL ${STOP_RETRY_ATTEMPTS} attempts fail — a genuine failure, not swallowed`, () => {
    const exec = flakyExec(STOP_RETRY_ATTEMPTS);
    const sleeps = [];
    expect(() => stopSessionWithRetry({ handle: 'abcd1234', exec, sleep: (ms) => sleeps.push(ms) })).toThrow(/claude stop/);
    expect(exec.calls).toBe(STOP_RETRY_ATTEMPTS);
    expect(sleeps).toEqual(STOP_RETRY_BACKOFF_MS); // backed off before every retry, never after the last attempt
  });

  it('never retries an `alreadyGone` answer — that is not a failure, resolved on the first call', () => {
    let calls = 0;
    const exec = () => {
      calls++;
      const e = new Error('boom');
      e.stderr = "No job matching 'abcd1234'. Run 'claude agents' to list running sessions.";
      throw e;
    };
    let slept = 0;
    const res = stopSessionWithRetry({ handle: 'abcd1234', exec, sleep: () => { slept++; } });
    expect(res).toEqual({ stopped: true, alreadyGone: true, output: expect.stringContaining('No job matching') });
    expect(calls).toBe(1);
    expect(slept).toBe(0);
  });
});

describe('repo-aware ground truth', () => {
  it('keeps separate cached answers and sends explicit gh repos', () => {
    expect(sessionTarget('review-fui-49')).toEqual({ kind: 'pr', id: '49', repo: 'frontierui' });
    const calls = [];
    const groundTruthFor = makeGroundTruthResolver({ exec: (file, args) => {
      calls.push([file, args]);
      return JSON.stringify({ state: args.includes('chalbert/frontierui') ? 'OPEN' : 'MERGED' });
    } });
    const listing = ['review-49', 'review-fui-49', 'fix-fui-49'].map((name) => bg({ name, sessionId: name, state: 'working' }));
    const { reap, keep } = sessionReapPlan(listing, { groundTruthFor });
    expect(reap.map((r) => r.session.name)).toEqual(['review-49']);
    expect(keep.map((r) => r.session.name)).toEqual(['review-fui-49', 'fix-fui-49']);
    expect(calls).toEqual(['chalbert/web-everything', 'chalbert/frontierui'].map((repo) => ['gh', ['pr', 'view', '49', '--repo', repo, '--json', 'state,mergedAt']]));
  });
  it('keeps sessions on unknown repo or gh failure', () => {
    const listing = [bg({ name: 'review-fui-49', state: 'working' })];
    const exec = () => { throw new Error('gh failed'); };
    expect(groundTruthForPr(49, { repo: 'unknown', exec: () => { throw new Error('must not call'); } })).toBeNull();
    for (const groundTruthFor of [makeGroundTruthResolver({ exec }), () => groundTruthForPr(49, { repo: 'unknown', exec })]) {
      const plan = sessionReapPlan(listing, { groundTruthFor });
      expect(plan.reap).toEqual([]);
      expect(plan.keep).toHaveLength(1);
    }
  });
});

it('shares the lookup cap across repos', () => {
  let calls = 0;
  const groundTruthFor = makeGroundTruthResolver({ maxPrViewCalls: 1, exec: () => {
    calls++; return '{"state":"MERGED"}';
  } });
  const sessions = ['review-49', 'review-fui-49'].map((name) => bg({ name, state: 'working' }));
  const plan = sessionReapPlan(sessions, { groundTruthFor });
  expect(calls).toBe(1);
  expect(plan.reap.map((r) => r.session.name)).toEqual(['review-49']);
  expect(plan.keep.map((r) => r.session.name)).toEqual(['review-fui-49']);
});

// ── epic #3383 daemon split: cwd scoping, the never-reap-working stricter mode, the completion-record axis,
//    and the idle-timeout backstop. All four are ADDITIVE (see each function's own doc) — every test above
//    this point exercises the pre-#3383 default and still passes unchanged. ──────────────────────────────────

describe('classifySessionReap — allowedCwd, a second structural guard (epic #3383)', () => {
  it('omitting allowedCwd is byte-identical to before — no behavior change for an existing caller', () => {
    expect(classifySessionReap(bg({ state: 'done' }))).toEqual({ reap: true, reason: 'done' });
    expect(classifySessionReap(bg({ state: 'done' }), {})).toEqual({ reap: true, reason: 'done' });
  });
  it('a session whose cwd does not match allowedCwd is never reaped, even a `done` one', () => {
    expect(classifySessionReap(bg({ state: 'done', cwd: '/some/other/checkout' }), { allowedCwd: '/repo' }))
      .toEqual({ reap: false, reason: 'wrong-cwd' });
  });
  it('a session whose cwd matches allowedCwd is reaped normally', () => {
    expect(classifySessionReap(bg({ state: 'done', cwd: '/repo' }), { allowedCwd: '/repo' }))
      .toEqual({ reap: true, reason: 'done' });
  });
  it('the cwd guard is checked before the state axis — a wrong-cwd working session is `wrong-cwd`, not `not-terminal`', () => {
    expect(classifySessionReap(bg({ state: 'working', cwd: '/elsewhere' }), { allowedCwd: '/repo' }))
      .toEqual({ reap: false, reason: 'wrong-cwd' });
  });
  it('an empty-string allowedCwd is treated as "no guard" (never refuses every session with a falsy cwd)', () => {
    expect(classifySessionReap(bg({ state: 'done' }), { allowedCwd: '' })).toEqual({ reap: true, reason: 'done' });
  });
});

describe('classifySessionReapWithGroundTruth — neverReapWorking (epic #3383 stricter mode)', () => {
  const alwaysResolved = () => ({ resolved: true, evidence: 'x' });
  const alwaysDone = () => ({ done: true });

  it('defaults to false — a `working` session is still upgradable by ground truth (unchanged pre-existing behavior)', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-1862' }), alwaysResolved))
      .toEqual({ reap: true, reason: 'ground-truth-pr:x' });
  });
  it('true — a `working` session is NEVER upgraded, even when ground truth says resolved', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-1862' }), alwaysResolved, { neverReapWorking: true }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('true — a `working` session is NEVER upgraded, even by a completion record reporting done', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-1862' }), null, { neverReapWorking: true, completionFor: alwaysDone }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('true — a `blocked` session (never `working`) is still upgradable', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-1862' }), alwaysResolved, { neverReapWorking: true }))
      .toEqual({ reap: true, reason: 'ground-truth-pr:x' });
  });
  it('true — an already-terminal `done` session is unaffected (the flag only touches the ground-truth axis)', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'done', name: 'review-1862' }), alwaysResolved, { neverReapWorking: true }))
      .toEqual({ reap: true, reason: 'done' });
  });
});

describe('classifySessionReapWithGroundTruth — hung-transcript detection, axis 0 (epic #3383 continuation)', () => {
  const alwaysHung = () => ({ hung: true, reason: 'stale-no-activity' });
  const neverHung = () => ({ hung: false, reason: 'fresh' });

  it('a `working` session confirmed hung is reaped — THE LIVE CASE (review-2582, state working, dead)', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-2582' }), null, { hungFor: alwaysHung }))
      .toEqual({ reap: true, reason: 'hung-transcript:stale-no-activity' });
  });

  it('OVERRIDES `neverReapWorking:true` — the one axis allowed to, since it independently disproves `working` itself', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-2582' }), null, { neverReapWorking: true, hungFor: alwaysHung }))
      .toEqual({ reap: true, reason: 'hung-transcript:stale-no-activity' });
  });

  it('a `blocked` session confirmed hung is reaped too, tried BEFORE the ground-truth/completion/idle axes', () => {
    let groundTruthCalled = false;
    const groundTruthFor = () => { groundTruthCalled = true; return { resolved: false }; };
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-2599' }), groundTruthFor, { hungFor: alwaysHung }))
      .toEqual({ reap: true, reason: 'hung-transcript:stale-no-activity' });
    expect(groundTruthCalled).toBe(false);
  });

  it('a resolver answering not-hung falls through to every later axis unaffected', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-2582' }), null, { neverReapWorking: true, hungFor: neverHung }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('a resolver that throws is treated as unknown, never a guess, and never crashes the pass', () => {
    const throws = () => { throw new Error('unreadable transcript'); };
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-2582' }), null, { hungFor: throws }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('omitting hungFor entirely is byte-identical to before — additive only', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'review-2582' }), null, { neverReapWorking: true }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('an already-terminal `done` session is unaffected — axis 0 only ever runs after the base `not-terminal` check', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'done', name: 'review-2582' }), null, { hungFor: alwaysHung }))
      .toEqual({ reap: true, reason: 'done' });
  });
});

describe('makeHungResolver — the IO-shell resolver over hung-session.mjs (epic #3383 continuation)', () => {
  it('delegates to readHungInfo with the injected clock and threshold, never throwing on a bad row', () => {
    const resolver = makeHungResolver({ thresholdMs: 30 * 60_000, now: () => 1_000_000 });
    // No cwd/sessionId on this fixture (`bg()` DOES carry both — strip them to hit the "no signal" path) —
    // proves the resolver never throws even when the shared detector cannot locate a transcript at all.
    const { cwd, sessionId, ...noTranscript } = bg({ state: 'working' });
    expect(resolver(noTranscript)).toEqual({ hung: false, reason: 'no-signal', ageMs: null });
  });
});

describe('classifySessionReapWithGroundTruth — the completion-record axis (epic #3383, #3436)', () => {
  it('a `blocked` session whose completion record reports done is reaped, tried BEFORE backlog/PR ground truth', () => {
    let groundTruthCalled = false;
    const groundTruthFor = () => { groundTruthCalled = true; return { resolved: false }; };
    const completionFor = () => ({ done: true });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-1862' }), groundTruthFor, { completionFor }))
      .toEqual({ reap: true, reason: 'completion-record-done' });
    expect(groundTruthCalled).toBe(false); // axis 1 fired first — axis 2 never needed to run
  });
  it('a completion record reporting NOT done falls through to the backlog/PR axis, never reaps on its own', () => {
    const completionFor = () => ({ done: false });
    const groundTruthFor = () => ({ resolved: true, evidence: 'pr#1862:merged' });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-1862' }), groundTruthFor, { completionFor }))
      .toEqual({ reap: true, reason: 'ground-truth-pr:pr#1862:merged' });
  });
  it('a `null` (unknown) completion-record answer falls through cleanly — never a guess', () => {
    const completionFor = () => null;
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-1862' }), () => ({ resolved: false }), { completionFor }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('omitting completionFor entirely is byte-identical to before — additive only', () => {
    const groundTruthFor = () => ({ resolved: false });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-1862' }), groundTruthFor))
      .toEqual(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-1862' }), groundTruthFor, {}));
  });

  // xf44mm3 (#4075/#3383) — BUG (a): this axis used to reap a `blocked-on-infra` completion record immediately,
  // ignoring `reconcile-core.mjs#INFRA_RETRY_COOLOFF_MS` (15 min). That let the reaper `claude stop` a session
  // ~2 minutes after it reported `blocked-on-infra`, which then made the NEXT reconcile tick read the PR as
  // unbound and re-dispatch early — instead of after the intended cool-off.
  describe('the blocked-on-infra cool-off (xf44mm3, #4075/#3383)', () => {
    it('does NOT reap a `blocked-on-infra` record still within the 15-minute cool-off', () => {
      const now = Date.parse('2026-09-24T18:50:00.000Z'); // 5 minutes after updatedAt — well under the cool-off
      const completionFor = () => ({ done: true, outcome: 'blocked-on-infra', updatedAt: '2026-09-24T18:45:00.000Z' });
      expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-2588' }), () => ({ resolved: false }), { completionFor, now }))
        .toEqual({ reap: false, reason: 'not-terminal' });
    });
    it('DOES reap a `blocked-on-infra` record once the 15-minute cool-off has elapsed', () => {
      const now = Date.parse('2026-09-24T19:01:00.000Z'); // 16 minutes after updatedAt
      const completionFor = () => ({ done: true, outcome: 'blocked-on-infra', updatedAt: '2026-09-24T18:45:00.000Z' });
      expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-2588' }), () => ({ resolved: false }), { completionFor, now }))
        .toEqual({ reap: true, reason: 'completion-record-done' });
    });
    it('a NON-infra done outcome is reaped immediately, cool-off never applies to it', () => {
      const now = Date.parse('2026-09-24T18:45:01.000Z'); // 1 second after updatedAt
      const completionFor = () => ({ done: true, outcome: 'accepted', updatedAt: '2026-09-24T18:45:00.000Z' });
      expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-2588' }), () => ({ resolved: false }), { completionFor, now }))
        .toEqual({ reap: true, reason: 'completion-record-done' });
    });
    it('an unparseable `updatedAt` on a blocked-on-infra record never reaps — safer than guessing elapsed', () => {
      const now = Date.parse('2026-09-24T20:00:00.000Z');
      const completionFor = () => ({ done: true, outcome: 'blocked-on-infra', updatedAt: 'not-a-date' });
      expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'review-2588' }), () => ({ resolved: false }), { completionFor, now }))
        .toEqual({ reap: false, reason: 'not-terminal' });
    });
  });
});

describe('classifySessionReapWithGroundTruth — the idle-timeout backstop, axis 3 (epic #3383)', () => {
  it('disabled by default (idleThresholdMs: 0) — a stale, unconfirmed `blocked` session is kept', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'test-dontask', startedAt: 0 }), null, { now: DEFAULT_IDLE_REAP_THRESHOLD_MS * 10 }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('reaps a `blocked` session once it has aged past the threshold with no other axis able to confirm it', () => {
    const now = 10_000_000;
    const startedAt = now - DEFAULT_IDLE_REAP_THRESHOLD_MS - 1;
    const verdict = classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'test-dontask', startedAt }), null, { idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS, now });
    expect(verdict.reap).toBe(true);
    expect(verdict.reason).toBe(`idle-threshold:${DEFAULT_IDLE_REAP_THRESHOLD_MS + 1}ms`);
  });
  it('never fires before the threshold is reached', () => {
    const now = 10_000_000;
    const startedAt = now - DEFAULT_IDLE_REAP_THRESHOLD_MS + 1;
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'test-dontask', startedAt }), null, { idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS, now }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('NEVER fires for `working` — the idle clock is not a way around neverReapWorking or the working axis', () => {
    const now = 10_000_000;
    const startedAt = now - DEFAULT_IDLE_REAP_THRESHOLD_MS - 1;
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'test-dontask', startedAt }), null, { idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS, now }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('never overrides an explicit `resolved: false` from the backlog/PR axis — positive "still open" evidence wins over age', () => {
    const now = 10_000_000;
    const startedAt = now - DEFAULT_IDLE_REAP_THRESHOLD_MS - 1;
    const stillOpen = () => ({ resolved: false });
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'conveyor-2786', startedAt }), stillOpen, { idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS, now }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });
  it('a missing/non-numeric startedAt never crashes and never fires', () => {
    const { startedAt, ...noStart } = bg({ state: 'blocked', name: 'test-dontask' });
    expect(classifySessionReapWithGroundTruth(noStart, null, { idleThresholdMs: 1 }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });
});

describe('runSessionReaperPass — the reusable IO-shell pass a daemon calls directly (epic #3383)', () => {
  it('with every effect injected (no real fs/exec), stops the reaped session and reports the same shape the CLI prints', () => {
    const result = runSessionReaperPass({
      listAgents: () => [
        { id: 'done1', sessionId: 'done-1-full-uuid', cwd: '/daemon-clone', kind: 'background', state: 'done', name: 'review-1862' },
        { id: 'live1', sessionId: 'live-1-full-uuid', cwd: '/daemon-clone', kind: 'background', state: 'working', name: 'fix-99' },
      ],
      groundTruthFor: () => ({ resolved: false }),
      completionFor: () => null,
      allowedCwd: '/daemon-clone',
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      backstopCompletion: false, // this test's own title promises "no real fs/exec" — the backstop write is covered separately below
      log: () => {},
    });
    expect(result.scanned).toBe(2);
    expect(result.stopped).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.collected).toEqual([{ id: 'done1', sessionId: 'done-1-full-uuid', name: 'review-1862', reason: 'done', alreadyGone: false }]);
  });

  it('an unreadable listing returns `unreadable: true` and touches nothing else — never throws', () => {
    const result = runSessionReaperPass({ listAgents: () => { throw new Error('claude: command not found'); }, log: () => {} });
    expect(result).toEqual({
      scanned: 0, stopped: 0, alreadyGone: 0, failures: 0, anomalies: 0, backstopWritten: 0,
      wouldWriteBackstop: undefined, wouldStop: undefined, collected: [], kept: 0, unreadable: true,
    });
  });

  it('a `dry-run` pass never calls `stop` at all', () => {
    let stopCalls = 0;
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'done1', sessionId: 'done-1-full-uuid', kind: 'background', state: 'done', name: 'conveyor-1' }],
      groundTruthFor: null,
      completionFor: null,
      dryRun: true,
      stop: () => { stopCalls++; return { stopped: true, alreadyGone: false, output: '' }; },
      backstopCompletion: false,
      log: () => {},
    });
    expect(stopCalls).toBe(0);
    expect(result.wouldStop).toEqual([{ id: 'done1', sessionId: 'done-1-full-uuid', name: 'conveyor-1', reason: 'done' }]);
  });

  it('threads neverReapWorking + completionFor + allowedCwd through to the plan exactly like sessionReapPlan does directly', () => {
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'w1', sessionId: 'w1-full', cwd: '/daemon-clone', kind: 'background', state: 'working', name: 'review-1862' }],
      groundTruthFor: () => ({ resolved: true, evidence: 'pr#1862:merged' }),
      completionFor: () => ({ done: true }),
      allowedCwd: '/daemon-clone',
      neverReapWorking: true,
      dryRun: true,
      backstopCompletion: false,
      log: () => {},
    });
    expect(result.wouldStop).toEqual([]);
    expect(result.kept).toBe(1);
  });

  it('threads hungFor through, and it overrides neverReapWorking exactly like classifySessionReapWithGroundTruth does directly', () => {
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'w2', sessionId: 'w2-full', cwd: '/daemon-clone', kind: 'background', state: 'working', name: 'review-2582' }],
      groundTruthFor: () => ({ resolved: false }),
      completionFor: () => null,
      neverReapWorking: true,
      hungFor: () => ({ hung: true, reason: 'stale-no-activity' }),
      dryRun: true,
      backstopCompletion: false,
      log: () => {},
    });
    expect(result.wouldStop).toEqual([{ id: 'w2', sessionId: 'w2-full', name: 'review-2582', reason: 'hung-transcript:stale-no-activity' }]);
    expect(result.kept).toBe(0);
  });
});

describe('planBackstopCompletion — the root-cause fix, not just detection (xbv32pg follow-up, epic #3383)', () => {
  it('mints a fresh done/unreported-exit record for a review-<pr> session with NO existing record', () => {
    const rec = planBackstopCompletion({ name: 'review-2599' }, null, () => '2026-09-24T21:00:00.000Z');
    expect(rec).toMatchObject({
      session: 'review-2599', kind: 'review', pr: '2599', status: 'done', outcome: UNREPORTED_EXIT_OUTCOME,
      startedAt: '2026-09-24T21:00:00.000Z', updatedAt: '2026-09-24T21:00:00.000Z',
    });
  });

  it('upgrades an existing `started` record to done/unreported-exit, preserving its startedAt', () => {
    const existing = { v: 1, session: 'fix-2607', kind: 'fix', pr: '2607', item: null, status: 'started', outcome: null, verdict: null, label: null, runId: null, startedAt: '2026-09-24T18:40:00.000Z', updatedAt: '2026-09-24T18:40:00.000Z' };
    const rec = planBackstopCompletion({ name: 'fix-2607' }, existing, () => '2026-09-24T21:00:00.000Z');
    expect(rec).toMatchObject({ session: 'fix-2607', status: 'done', outcome: UNREPORTED_EXIT_OUTCOME, startedAt: '2026-09-24T18:40:00.000Z', updatedAt: '2026-09-24T21:00:00.000Z' });
  });

  it('NEVER overwrites a genuinely done record, whatever its outcome — a backstop only ever fills a gap', () => {
    const existing = { v: 1, session: 'review-2607', kind: 'review', pr: '2607', item: null, status: 'done', outcome: 'blocked-on-infra', verdict: null, label: null, runId: null, startedAt: '2026-09-24T18:40:00.000Z', updatedAt: '2026-09-24T18:45:00.000Z' };
    expect(planBackstopCompletion({ name: 'review-2607' }, existing)).toBeNull();
  });

  it('never mints one for an item-kind session (conveyor-*/prepare-*) — no completion-record mechanism exists for those', () => {
    expect(planBackstopCompletion({ name: 'conveyor-3451' }, null)).toBeNull();
    expect(planBackstopCompletion({ name: 'prepare-3436' }, null)).toBeNull();
  });

  it('never mints one for ci-heal-<pr> — a real PR-kind name, but no completion-record kind exists for it', () => {
    expect(planBackstopCompletion({ name: 'ci-heal-2607' }, null)).toBeNull();
  });

  it('never mints one for a name matching no known grammar — never a guess', () => {
    expect(planBackstopCompletion({ name: 'my terminal' }, null)).toBeNull();
    expect(planBackstopCompletion({ name: undefined }, null)).toBeNull();
  });
});

describe('runSessionReaperPass — the backstop-completion write (xbv32pg follow-up, epic #3383)', () => {
  it('writes a done/unreported-exit record for a session reaped via the hung axis with no existing record', () => {
    const written = [];
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'w2', sessionId: 'w2-full', cwd: '/daemon-clone', kind: 'background', state: 'working', name: 'review-2582' }],
      groundTruthFor: () => ({ resolved: false }),
      completionFor: () => null,
      neverReapWorking: true,
      hungFor: () => ({ hung: true, reason: 'stale-no-activity' }),
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => null,
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(result.backstopWritten).toBe(1);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ session: 'review-2582', kind: 'review', pr: '2582', status: 'done', outcome: UNREPORTED_EXIT_OUTCOME });
  });

  it('never writes over an existing done record', () => {
    const written = [];
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'd1', sessionId: 'd1-full', kind: 'background', state: 'done', name: 'review-1862' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => ({ status: 'done', outcome: 'accepted' }),
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(result.backstopWritten).toBe(0);
    expect(written).toHaveLength(0);
  });

  it('`backstopCompletion: false` is a full rollback escape hatch — never calls writeCompletionRecord at all', () => {
    let readCalls = 0;
    const written = [];
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'd1', sessionId: 'd1-full', kind: 'background', state: 'done', name: 'review-1862' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      backstopCompletion: false,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => { readCalls++; return null; },
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(readCalls).toBe(0);
    expect(written).toHaveLength(0);
    expect(result.backstopWritten).toBe(0);
  });

  it('a dry-run pass reports what it WOULD write but never calls writeCompletionRecord', () => {
    const written = [];
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'd1', sessionId: 'd1-full', kind: 'background', state: 'done', name: 'review-1862' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      dryRun: true,
      readCompletionRecord: () => null,
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(written).toHaveLength(0);
    expect(result.wouldWriteBackstop).toEqual([{ name: 'review-1862', outcome: UNREPORTED_EXIT_OUTCOME }]);
  });

  it('a readCompletionRecord that throws (corrupt record / invalid slug) skips the backstop this tick — never guesses, never crashes the pass', () => {
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'd1', sessionId: 'd1-full', kind: 'background', state: 'done', name: 'review-1862' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => { throw new Error('corrupt record'); },
      writeCompletionRecord: () => { throw new Error('should never be called'); },
      log: () => {},
    });
    expect(result.backstopWritten).toBe(0);
    expect(result.stopped).toBe(1); // the stop itself still proceeds — the backstop write is a side concern
  });
});

describe('makeCompletionResolver — the IO helper over completion-store.mjs (#3436)', () => {
  it('returns null for a name completionPath refuses (e.g. an interactive session\'s free-text name) — never throws', () => {
    const resolver = makeCompletionResolver({ dir: '/does/not/matter' });
    expect(resolver('my terminal')).toBeNull();
    expect(resolver('')).toBeNull();
    expect(resolver(null)).toBeNull();
  });
  it('returns null when no record exists on disk for an otherwise-valid slug', () => {
    const resolver = makeCompletionResolver({ dir: '/tmp/we-session-reaper-completion-resolver-test-nonexistent' });
    expect(resolver('review-999999')).toBeNull();
  });

  // xf44mm3 (#4075/#3383) — BUG (a)'s other half: the resolver used to drop `outcome`/`updatedAt` entirely
  // (`{ done }` only), which is exactly what made the blocked-on-infra cool-off unenforceable from this axis —
  // see the `classifySessionReapWithGroundTruth` describe block above for the decision-side proof.
  it('surfaces outcome + updatedAt from a real record on disk, not just done', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { writeCompletion, newCompletionRecord, applyCompletionUpdate } = await import('../../operations/completion-store.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'we-session-reaper-completion-resolver-'));
    try {
      const now = () => '2026-09-24T18:45:00.000Z';
      const base = newCompletionRecord({ session: 'review-2588', kind: 'review', pr: '2588', now });
      const record = applyCompletionUpdate(base, { status: 'done', outcome: 'blocked-on-infra' }, now);
      writeCompletion(record, dir);
      const resolver = makeCompletionResolver({ dir });
      expect(resolver('review-2588')).toEqual({ done: true, outcome: 'blocked-on-infra', updatedAt: '2026-09-24T18:45:00.000Z' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
