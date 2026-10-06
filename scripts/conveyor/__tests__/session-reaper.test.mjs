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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  makeReapedLedger,
  resolveReapMaxStops,
  resolveReapMaxDurationMs,
  prioritizeReapCandidates,
  DEFAULT_REAP_MAX_STOPS_PER_PASS,
  DEFAULT_REAP_MAX_DURATION_MS,
  makeHungResolver,
  makeAuthExpiredResolver,
  makeIdleFinishedResolver,
  makePidDeadResolver,
  planBackstopCompletion,
  resolveLastActivityMs,
  UNREPORTED_EXIT_OUTCOME,
  BLOCKED_ON_INFRA_OUTCOME,
  STALLED_OUTCOME,
  CLAUDE_AUTH_OUTCOME_LABEL,
  transcriptShowsIntendedBlockedOnInfra,
  lastCommitAheadOfBaseMs,
  lastReviewCommentMs,
  lastItemFileChangeMs,
  makeNoOutcomeResolver,
  classifyRetention,
  retentionGroundTruthForItem,
  retentionGroundTruthForPr,
  makeRetentionGroundTruthResolver,
  makeIntrospectionDoneResolver,
  makeCostRolledUpResolver,
  resolveRetentionGraceMs,
  resolveRetentionCeilingMs,
  runRetentionSweepPass,
  RETENTION_GRACE_MS_DEFAULT,
  RETENTION_CEILING_MS_DEFAULT,
  writeChatSpawnLink,
  tryReadChatSpawnLink,
  markChatEnded,
  isChatEnded,
  classifyChatSpawnGuard,
  resolveChatSpawnGuardCeilingMs,
  CHAT_SPAWN_LINK_FUTURE_SKEW_MS,
  makeChatSpawnGuardResolver,
  runStampChatSpawnHook,
  runMarkChatEndedHook,
  classifyDispatchScratchEntry,
  runDispatchScratchSweepPass,
  resolveDispatchScratchGraceMs,
  resolveDispatchScratchCeilingMs,
  DISPATCH_SCRATCH_GRACE_MS_DEFAULT,
  DISPATCH_SCRATCH_CEILING_MS_DEFAULT,
} from '../session-reaper.mjs';
import { OUTCOME_UNREADABLE } from '../hung-session.mjs';
import { newCompletionRecord, applyCompletionUpdate, writeCompletion } from '../../operations/completion-store.mjs';
import { newDeliveryReport, writeDeliveryReport } from '../../operations/delivery-report-store.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

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

  // #4149 (epic #3383/#4075) — RATIFIED WIDENING: "Ghosts on closed or merged PRs are stopped." A ghost session
  // bound to a PR that was closed WITHOUT merging (abandoned/superseded/duplicate) used to have no path to ever
  // being confirmed done by this axis — never a fix to make, never a merge to detect — so it sat forever.
  it('resolved:true (and evidence:closed) for a CLOSED, unmerged PR — the new #4149 case', () => {
    const exec = () => JSON.stringify({ state: 'CLOSED', mergedAt: null });
    expect(groundTruthForPr('2003', { exec })).toEqual({ resolved: true, evidence: 'pr#2003:closed' });
  });
  it('a MERGED pr still reports evidence:merged, never the closed wording, when both could apply', () => {
    const exec = () => JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-03T11:57:41Z' });
    expect(groundTruthForPr('1862', { exec })).toEqual({ resolved: true, evidence: 'pr#1862:merged' });
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
      return JSON.stringify({ state: args.includes('frontier-ui/frontierui') ? 'OPEN' : 'MERGED' });
    } });
    const listing = ['review-49', 'review-fui-49', 'fix-fui-49'].map((name) => bg({ name, sessionId: name, state: 'working' }));
    const { reap, keep } = sessionReapPlan(listing, { groundTruthFor });
    expect(reap.map((r) => r.session.name)).toEqual(['review-49']);
    expect(keep.map((r) => r.session.name)).toEqual(['review-fui-49', 'fix-fui-49']);
    expect(calls).toEqual(['web-everything/web-everything', 'frontier-ui/frontierui'].map((repo) => ['gh', ['pr', 'view', '49', '--repo', repo, '--json', 'state,mergedAt']]));
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

describe('classifySessionReapWithGroundTruth — a `wrong-cwd` session is still reapable by axis -1/0 (#4149)', () => {
  // LIVE, 2026-09-25: `fix-2003`/`fix-2115`/`fix-2267` were dispatched with a `cwd` other than the review-
  // daemon's own `allowedCwd` (the primary checkout, a scratch-dispatcher clone) and sat `state: 'working'` for
  // TEN DAYS — `wrong-cwd` short-circuited every axis, including the ones built specifically to catch a stale
  // `working` row (no-outcome ceiling, hung-transcript). "Ghosts older than any window never swept."
  const alwaysStalled = () => ({ stall: true, reason: 'ceiling' });
  const alwaysHung = () => ({ hung: true, reason: 'stale-no-activity' });
  const neverStalled = () => ({ stall: false, reason: 'active' });
  const alwaysResolved = () => ({ resolved: true, evidence: 'x' });
  const alwaysDone = () => ({ done: true });

  it('axis -1 (no-outcome) reaps a wrong-cwd session — THE LIVE CASE', () => {
    const session = bg({ state: 'working', name: 'fix-2003', cwd: '/elsewhere' });
    expect(classifySessionReapWithGroundTruth(session, null, { allowedCwd: '/daemon-clone', noOutcomeFor: alwaysStalled }))
      .toEqual({ reap: true, reason: 'no-outcome:ceiling' });
  });

  it('axis 0 (hung-transcript) reaps a wrong-cwd session too', () => {
    const session = bg({ state: 'blocked', name: 'review-2669', cwd: '/elsewhere' });
    expect(classifySessionReapWithGroundTruth(session, null, { allowedCwd: '/daemon-clone', hungFor: alwaysHung }))
      .toEqual({ reap: true, reason: 'hung-transcript:stale-no-activity' });
  });

  it('neither axis -1 nor axis 0 fires → falls through to `wrong-cwd`, unchanged — the guard still holds for everything else', () => {
    const session = bg({ state: 'working', name: 'fix-2003', cwd: '/elsewhere' });
    expect(classifySessionReapWithGroundTruth(session, alwaysResolved, {
      allowedCwd: '/daemon-clone', noOutcomeFor: neverStalled, completionFor: alwaysDone,
    })).toEqual({ reap: false, reason: 'wrong-cwd' });
  });

  it('the completion-record axis (1) and ground-truth axis (2) do NOT bypass a wrong-cwd mismatch — only -1/0 do', () => {
    const session = bg({ state: 'blocked', name: 'review-1862', cwd: '/elsewhere' });
    expect(classifySessionReapWithGroundTruth(session, alwaysResolved, { allowedCwd: '/daemon-clone', completionFor: alwaysDone }))
      .toEqual({ reap: false, reason: 'wrong-cwd' });
  });

  it('the idle-timeout backstop (axis 3) does NOT bypass a wrong-cwd mismatch either', () => {
    const now = 10_000_000;
    const startedAt = now - DEFAULT_IDLE_REAP_THRESHOLD_MS - 1;
    const session = bg({ state: 'blocked', name: 'test-dontask', cwd: '/elsewhere', startedAt });
    expect(classifySessionReapWithGroundTruth(session, null, { allowedCwd: '/daemon-clone', idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS, now }))
      .toEqual({ reap: false, reason: 'wrong-cwd' });
  });

  it('a matching cwd is completely unaffected — byte-identical to before #4149', () => {
    const session = bg({ state: 'working', name: 'fix-2003', cwd: '/daemon-clone' });
    expect(classifySessionReapWithGroundTruth(session, null, { allowedCwd: '/daemon-clone', noOutcomeFor: alwaysStalled }))
      .toEqual({ reap: true, reason: 'no-outcome:ceiling' });
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

// Live incident, night of 2026-09-25/26 ET — the operator's Claude login expired; every daemon-dispatched
// session (`ci-heal-2711`/`ci-heal-2712`) ended immediately on the CLI's own auth failure and sat `blocked`
// for hours. Mirrors the hung-transcript axis describe block above, one for one.
describe('classifySessionReapWithGroundTruth — Claude auth-expired detection (live incident, night of 2026-09-25/26 ET)', () => {
  const alwaysAuthExpired = () => ({ authExpired: true, reason: 'claude-auth' });
  const neverAuthExpired = () => ({ authExpired: false, reason: 'no-signal' });

  it('a `working` session confirmed auth-expired is reaped', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2711' }), null, { authExpiredFor: alwaysAuthExpired }))
      .toEqual({ reap: true, reason: 'claude-auth-expired:claude-auth' });
  });

  it('a `blocked` session confirmed auth-expired is reaped too — THE LIVE CASE (ci-heal-2711/2712, sat blocked for hours)', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'ci-heal-2712' }), null, { authExpiredFor: alwaysAuthExpired }))
      .toEqual({ reap: true, reason: 'claude-auth-expired:claude-auth' });
  });

  it('OVERRIDES `neverReapWorking:true` — same tier as the hung-transcript/no-outcome axes, same reasoning', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2711' }), null, { neverReapWorking: true, authExpiredFor: alwaysAuthExpired }))
      .toEqual({ reap: true, reason: 'claude-auth-expired:claude-auth' });
  });

  it('overrides a `wrong-cwd` verdict too — a dispatched session\'s cwd is its own scratch dir, never the daemon\'s allowedCwd', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'ci-heal-2711', cwd: '/Users/x/workspace/.operations/dispatch/abc' }), null, { allowedCwd: '/daemon-clone', authExpiredFor: alwaysAuthExpired }))
      .toEqual({ reap: true, reason: 'claude-auth-expired:claude-auth' });
  });

  it('tried BEFORE ground-truth/completion — a resolver answering true short-circuits everything after it', () => {
    let groundTruthCalled = false;
    const groundTruthFor = () => { groundTruthCalled = true; return { resolved: false }; };
    expect(classifySessionReapWithGroundTruth(bg({ state: 'blocked', name: 'ci-heal-2711' }), groundTruthFor, { authExpiredFor: alwaysAuthExpired }))
      .toEqual({ reap: true, reason: 'claude-auth-expired:claude-auth' });
    expect(groundTruthCalled).toBe(false);
  });

  it('a resolver answering not-auth-expired falls through to every later axis unaffected', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2711' }), null, { neverReapWorking: true, authExpiredFor: neverAuthExpired }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('a resolver that throws is treated as unknown, never a guess, and never crashes the pass', () => {
    const throws = () => { throw new Error('unreadable transcript'); };
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2711' }), null, { authExpiredFor: throws }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('omitting authExpiredFor entirely is byte-identical to before — additive only', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2711' }), null, { neverReapWorking: true }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('an already-terminal `done` session is unaffected — this axis only ever runs after the base `not-terminal` check', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'done', name: 'ci-heal-2711' }), null, { authExpiredFor: alwaysAuthExpired }))
      .toEqual({ reap: true, reason: 'done' });
  });
});

describe('makeAuthExpiredResolver — the IO-shell resolver over hung-session.mjs (live incident, night of 2026-09-25/26 ET)', () => {
  it('delegates to readClaudeAuthExpiredInfo, never throwing on a bad row', () => {
    const resolver = makeAuthExpiredResolver();
    const { cwd, sessionId, ...noTranscript } = bg({ state: 'blocked' });
    expect(resolver(noTranscript)).toEqual({ authExpired: false, reason: 'no-signal' });
  });
});

// #4075/xg7m2wq — live incident, PR #2724, 2026-09-26: ci-heal-2724 finished ("rebased onto main and pushed; no
// code change was needed") but `fix-agent-ci-brief.md` never reported completion, so it kept counting as a live
// holder of its own PR. This axis is the general backstop, for EVERY kind, not gated on any completion-record
// schema — mirrors the auth-expired axis describe block above, one for one.
describe('classifySessionReapWithGroundTruth — idle-turn-ended backstop (#4075/xg7m2wq, live incident PR #2724, 2026-09-26)', () => {
  const alwaysIdleFinished = () => ({ finished: true, reason: 'turn-ended-idle' });
  const neverIdleFinished = () => ({ finished: false, reason: 'fresh' });

  it('a `working` session confirmed idle-finished is reaped — THE LIVE CASE (ci-heal-2724)', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2724' }), null, { idleFinishedFor: alwaysIdleFinished }))
      .toEqual({ reap: true, reason: 'idle-finished:turn-ended-idle' });
  });

  it('applies to a kind with NO completion-record/no-outcome schema at all — the general-backstop premise', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'investigate-3451' }), null, { idleFinishedFor: alwaysIdleFinished }))
      .toEqual({ reap: true, reason: 'idle-finished:turn-ended-idle' });
  });

  it('OVERRIDES `neverReapWorking:true` — same tier as the hung-transcript/auth-expired axes, same reasoning', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2724' }), null, { neverReapWorking: true, idleFinishedFor: alwaysIdleFinished }))
      .toEqual({ reap: true, reason: 'idle-finished:turn-ended-idle' });
  });

  it('tried BEFORE ground-truth/completion — a resolver answering true short-circuits everything after it', () => {
    let groundTruthCalled = false;
    const groundTruthFor = () => { groundTruthCalled = true; return { resolved: false }; };
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2724' }), groundTruthFor, { idleFinishedFor: alwaysIdleFinished }))
      .toEqual({ reap: true, reason: 'idle-finished:turn-ended-idle' });
    expect(groundTruthCalled).toBe(false);
  });

  it('a resolver answering not-finished falls through to every later axis unaffected', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2724' }), null, { neverReapWorking: true, idleFinishedFor: neverIdleFinished }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('a resolver that throws is treated as unknown, never a guess, and never crashes the pass', () => {
    const throws = () => { throw new Error('unreadable transcript'); };
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2724' }), null, { idleFinishedFor: throws }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('omitting idleFinishedFor entirely is byte-identical to before — additive only', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'working', name: 'ci-heal-2724' }), null, { neverReapWorking: true }))
      .toEqual({ reap: false, reason: 'not-terminal' });
  });

  it('an already-terminal `done` session is unaffected — this axis only ever runs after the base `not-terminal` check', () => {
    expect(classifySessionReapWithGroundTruth(bg({ state: 'done', name: 'ci-heal-2724' }), null, { idleFinishedFor: alwaysIdleFinished }))
      .toEqual({ reap: true, reason: 'done' });
  });
});

describe('makeIdleFinishedResolver — the IO-shell resolver over hung-session.mjs (#4075/xg7m2wq)', () => {
  it('delegates to readIdleFinishedInfo, never throwing on a bad row', () => {
    const resolver = makeIdleFinishedResolver();
    const { cwd, sessionId, ...noTranscript } = bg({ state: 'working' });
    expect(resolver(noTranscript)).toEqual({ finished: false, reason: 'no-signal', ageMs: null });
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

describe('runSessionReaperPass — per-tick reap budget (#3383 follow-up, live-caught 2026-09-26: the review-daemon restart at 18:02 ET spent 15+ minutes stopping ~1,500 sessions one tick, with no review dispatched and no status tag updated the whole time)', () => {
  const sessions = (n) => Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, sessionId: `s${i}-full`, kind: 'background', state: 'done', name: `review-${1000 + i}`,
  }));

  it('an unbounded (no-budget) pass stops every candidate — the pre-budget baseline', () => {
    const result = runSessionReaperPass({
      listAgents: () => sessions(10),
      groundTruthFor: () => ({ resolved: false }),
      completionFor: () => null,
      backstopCompletion: false,
      maxStops: Infinity,
      maxDurationMs: Infinity,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      log: () => {},
    });
    expect(result.stopped).toBe(10);
    expect(result.deferred).toBe(0);
  });

  it('a count budget stops only `maxStops` sessions this pass and reports the rest as `deferred`, never as `kept`', () => {
    const result = runSessionReaperPass({
      listAgents: () => sessions(10),
      groundTruthFor: () => ({ resolved: false }),
      completionFor: () => null,
      backstopCompletion: false,
      maxStops: 3,
      maxDurationMs: Infinity,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      log: () => {},
    });
    expect(result.stopped).toBe(3);
    expect(result.deferred).toBe(7);
    expect(result.kept).toBe(0); // deferred candidates are still reap-worthy, not reclassified as "keep"
    expect(result.reapBudget).toEqual({ maxStops: 3, maxDurationMs: Infinity, exhausted: true });
  });

  it('a duration budget ends the pass once elapsed time crosses it, using the injected clock — never wall-clock flakiness in a test', () => {
    let calls = 0;
    const clockNow = () => { calls += 1; return calls <= 2 ? 0 : 100_000; }; // budget check runs before EACH candidate
    const result = runSessionReaperPass({
      listAgents: () => sessions(10),
      groundTruthFor: () => ({ resolved: false }),
      completionFor: () => null,
      backstopCompletion: false,
      maxStops: Infinity,
      maxDurationMs: 1000,
      clockNow,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      log: () => {},
    });
    expect(result.stopped).toBe(1);
    expect(result.deferred).toBe(9);
  });

  it('a dry-run pass is exempt from the budget — it still LISTS every candidate (diagnostic only, no real stop, no daemon-tick timing at stake)', () => {
    const result = runSessionReaperPass({
      listAgents: () => sessions(10),
      groundTruthFor: () => ({ resolved: false }),
      completionFor: () => null,
      backstopCompletion: false,
      dryRun: true,
      maxStops: 2,
      maxDurationMs: 10,
      stop: () => { throw new Error('must never be called in dry-run'); },
      log: () => {},
    });
    expect(result.wouldStop).toHaveLength(10);
    expect(result.deferred).toBe(0);
  });

  it('`resolveReapMaxStops`/`resolveReapMaxDurationMs` read WE_SESSION_REAP_MAX_STOPS/WE_SESSION_REAP_MAX_DURATION_MS, falling back to the default on anything non-positive (never silently unbounded)', () => {
    expect(resolveReapMaxStops({ WE_SESSION_REAP_MAX_STOPS: '7' })).toBe(7);
    expect(resolveReapMaxStops({ WE_SESSION_REAP_MAX_STOPS: '0' })).toBe(DEFAULT_REAP_MAX_STOPS_PER_PASS);
    expect(resolveReapMaxStops({ WE_SESSION_REAP_MAX_STOPS: 'nope' })).toBe(DEFAULT_REAP_MAX_STOPS_PER_PASS);
    expect(resolveReapMaxStops({})).toBe(DEFAULT_REAP_MAX_STOPS_PER_PASS);
    expect(resolveReapMaxDurationMs({ WE_SESSION_REAP_MAX_DURATION_MS: '9000' })).toBe(9000);
    expect(resolveReapMaxDurationMs({ WE_SESSION_REAP_MAX_DURATION_MS: '-5' })).toBe(DEFAULT_REAP_MAX_DURATION_MS);
  });

  it('prioritizeReapCandidates sorts matching-name candidates first, preserving relative order within each partition', () => {
    const reap = [
      { session: { name: 'review-1' }, reason: 'done' },
      { session: { name: 'fix-2771' }, reason: 'done' },
      { session: { name: 'review-3' }, reason: 'done' },
      { session: { name: 'ci-heal-2771' }, reason: 'done' },
    ];
    const priorityNames = new Set(['fix-2771', 'ci-heal-2771']);
    expect(prioritizeReapCandidates(reap, priorityNames).map((r) => r.session.name))
      .toEqual(['fix-2771', 'ci-heal-2771', 'review-1', 'review-3']);
    // no priority set (or an empty one) — the list comes back unchanged, not reordered
    expect(prioritizeReapCandidates(reap, null)).toBe(reap);
    expect(prioritizeReapCandidates(reap, new Set())).toBe(reap);
  });

  it('a budget-bounded pass spends its stops on priority-named candidates first — a PR owed work this tick is freed before an unrelated backlog of 1,500', () => {
    const listAgents = () => [
      ...sessions(5), // review-1000..1004, unrelated backlog
      { id: 'blocker', sessionId: 'blocker-full', kind: 'background', state: 'done', name: 'fix-2771' },
    ];
    const result = runSessionReaperPass({
      listAgents,
      groundTruthFor: () => ({ resolved: false }),
      completionFor: () => null,
      backstopCompletion: false,
      maxStops: 1, // budget for only ONE stop this tick — the unrelated backlog must not win the slot
      maxDurationMs: Infinity,
      priorityNames: new Set(['fix-2771']),
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      log: () => {},
    });
    expect(result.stopped).toBe(1);
    expect(result.collected).toEqual([{ id: 'blocker', sessionId: 'blocker-full', name: 'fix-2771', reason: 'done', alreadyGone: false }]);
    expect(result.deferred).toBe(5);
  });

  it('a dry-run plan (`wouldStop`) reports the SAME priority order a real budgeted pass would spend its stops in — never the plan\'s own pre-priority order', () => {
    const listAgents = () => [
      ...sessions(3), // review-1000..1002, unrelated backlog
      { id: 'blocker', sessionId: 'blocker-full', kind: 'background', state: 'done', name: 'fix-2771' },
    ];
    const result = runSessionReaperPass({
      listAgents, groundTruthFor: () => ({ resolved: false }), completionFor: () => null,
      backstopCompletion: false, dryRun: true, priorityNames: new Set(['fix-2771']), log: () => {},
    });
    expect(result.wouldStop.map((w) => w.name)).toEqual(['fix-2771', 'review-1000', 'review-1001', 'review-1002']);
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

  it('mints a fresh done/unreported-exit record for a ci-heal-<pr> session too (#4075/xg7m2wq, live incident PR #2724, 2026-09-26)', () => {
    const rec = planBackstopCompletion({ name: 'ci-heal-2724' }, null, () => '2026-09-26T14:10:00.000Z');
    expect(rec).toMatchObject({
      session: 'ci-heal-2724', kind: 'ci-heal', pr: '2724', status: 'done', outcome: UNREPORTED_EXIT_OUTCOME,
      startedAt: '2026-09-26T14:10:00.000Z', updatedAt: '2026-09-26T14:10:00.000Z',
    });
  });

  it('never mints one for a name matching no known grammar — never a guess', () => {
    expect(planBackstopCompletion({ name: 'my terminal' }, null)).toBeNull();
    expect(planBackstopCompletion({ name: undefined }, null)).toBeNull();
  });

  // Live incident fix (PR #2647/#2625, 2026-09-25): a crashed session's own transcript can show it intended
  // `blocked-on-infra` even though it never durably self-reported that. The 4th `blockedOnInfra` param lets the
  // caller (runSessionReaperPass, below) upgrade the backstop outcome to match — see the constant's own doc.
  it('mints outcome BLOCKED_ON_INFRA_OUTCOME (not the generic one) when the caller says the transcript showed it', () => {
    const rec = planBackstopCompletion({ name: 'review-2647' }, null, () => '2026-09-25T15:00:00.000Z', true);
    expect(rec).toMatchObject({ session: 'review-2647', status: 'done', outcome: BLOCKED_ON_INFRA_OUTCOME });
  });

  it('defaults to the generic outcome when `blockedOnInfra` is omitted or false — byte-identical to before', () => {
    const now = () => '2026-09-25T15:00:00.000Z';
    expect(planBackstopCompletion({ name: 'review-2647' }, null, now)).toMatchObject({ outcome: UNREPORTED_EXIT_OUTCOME });
    expect(planBackstopCompletion({ name: 'review-2647' }, null, now, false)).toMatchObject({ outcome: UNREPORTED_EXIT_OUTCOME });
  });

  // #4090 (epic #3383/#4075, statute clause 2) — a no-outcome stop is a definite verdict, not a guess.
  it('mints STALLED_OUTCOME when the 5th `stalled` param is true — outranks `blockedOnInfra`', () => {
    const now = () => '2026-09-25T15:00:00.000Z';
    expect(planBackstopCompletion({ name: 'fix-2647' }, null, now, false, true)).toMatchObject({ outcome: STALLED_OUTCOME });
    expect(planBackstopCompletion({ name: 'fix-2647' }, null, now, true, true)).toMatchObject({ outcome: STALLED_OUTCOME });
  });

  // Live incident fix, night of 2026-09-25/26 ET — the 6th `authExpired` param.
  it('mints BLOCKED_ON_INFRA_OUTCOME + the claude-auth label when the 6th `authExpired` param is true', () => {
    const rec = planBackstopCompletion({ name: 'fix-2647' }, null, () => '2026-09-26T11:00:00.000Z', false, false, true);
    expect(rec).toMatchObject({ session: 'fix-2647', status: 'done', outcome: BLOCKED_ON_INFRA_OUTCOME, label: CLAUDE_AUTH_OUTCOME_LABEL });
  });

  it('`authExpired` outranks a bare `blockedOnInfra` when both are somehow true — same outcome, but the specific label wins', () => {
    const rec = planBackstopCompletion({ name: 'fix-2647' }, null, () => '2026-09-26T11:00:00.000Z', true, false, true);
    expect(rec).toMatchObject({ outcome: BLOCKED_ON_INFRA_OUTCOME, label: CLAUDE_AUTH_OUTCOME_LABEL });
  });

  it('`stalled` still outranks `authExpired` — a no-outcome verdict is this reaper\'s own stronger conclusion', () => {
    const rec = planBackstopCompletion({ name: 'fix-2647' }, null, () => '2026-09-26T11:00:00.000Z', false, true, true);
    expect(rec).toMatchObject({ outcome: STALLED_OUTCOME });
    expect(rec.label).not.toBe(CLAUDE_AUTH_OUTCOME_LABEL);
  });

  it('mints BLOCKED_ON_INFRA_OUTCOME + the claude-auth label for a ci-heal-<pr> session too, now it has a schema', () => {
    const rec = planBackstopCompletion({ name: 'ci-heal-2711' }, null, () => '2026-09-26T11:00:00.000Z', false, false, true);
    expect(rec).toMatchObject({ session: 'ci-heal-2711', kind: 'ci-heal', status: 'done', outcome: BLOCKED_ON_INFRA_OUTCOME, label: CLAUDE_AUTH_OUTCOME_LABEL });
  });

  it('omitting `authExpired` (or false) is byte-identical to before — no `label` field touched', () => {
    const now = () => '2026-09-26T11:00:00.000Z';
    expect(planBackstopCompletion({ name: 'fix-2647' }, null, now)).toMatchObject({ outcome: UNREPORTED_EXIT_OUTCOME, label: null });
    expect(planBackstopCompletion({ name: 'fix-2647' }, null, now, false, false, false)).toMatchObject({ outcome: UNREPORTED_EXIT_OUTCOME, label: null });
  });

  it('stamps the reaped session\'s own sessionId onto a freshly-minted backstop', () => {
    const rec = planBackstopCompletion({ name: 'review-2599', sessionId: 'A' }, null, () => '2026-09-24T21:00:00.000Z');
    expect(rec).toMatchObject({ sessionId: 'A' });
  });

  it('a freshly-minted backstop with no `sessionId` on the session row stamps `sessionId: null` — byte-identical to before this card for a caller with no identity to give', () => {
    const rec = planBackstopCompletion({ name: 'review-2599' }, null, () => '2026-09-24T21:00:00.000Z');
    expect(rec).toMatchObject({ sessionId: null });
  });
});

// #4306 (epic #3383/#4075, BLOCKER fix-2821) — GUARD 1: "the reaper never writes a backstop that is not its
// session's to write." Reproduces the live incident's own root cause directly against `planBackstopCompletion`:
// the reaper's backstop for the FINISHED old fixer A must not land on the LIVE new fixer B's own `started`
// record, under any of the three independent skip conditions (a)/(b)/(c).
describe('planBackstopCompletion Guard 1 (#4306) — (a)/(b)/(c) skip conditions, BLOCKER fix-2821', () => {
  const bStarted = {
    v: 1, session: 'fix-2821', kind: 'fix', pr: '2821', item: null, status: 'started', outcome: null,
    verdict: null, label: null, runId: null, sessionId: 'B', startedAt: '2026-09-27T20:53:27.000Z', updatedAt: '2026-09-27T20:53:27.000Z',
  };

  it('(a) refuses when the existing record\'s sessionId is FOREIGN to the reaped session — the exact clobber the incident hit', () => {
    // The reaper is reaping the OLD, finished fixer A; the on-disk record under the shared name is B's.
    const rec = planBackstopCompletion({ name: 'fix-2821', sessionId: 'A' }, bStarted, () => '2026-09-27T20:54:34.000Z');
    expect(rec).toBeNull();
  });

  it('(a) still backstops when the existing record carries the SAME sessionId as the reaped session — never over-refuses', () => {
    const aStarted = { ...bStarted, sessionId: 'A', startedAt: '2026-09-27T20:04:30.000Z', updatedAt: '2026-09-27T20:04:30.000Z' };
    const rec = planBackstopCompletion({ name: 'fix-2821', sessionId: 'A' }, aStarted, () => '2026-09-27T20:54:34.000Z');
    expect(rec).toMatchObject({ status: 'done', sessionId: 'A' });
  });

  it('(b) refuses whenever `newerSameNameListed` is true — independent of whether a record exists at all', () => {
    expect(planBackstopCompletion(
      { name: 'fix-2821', sessionId: 'A' }, null, () => '2026-09-27T20:54:34.000Z', false, false, false,
      { newerSameNameListed: true },
    )).toBeNull();
    const aStarted = { ...bStarted, sessionId: 'A' };
    expect(planBackstopCompletion(
      { name: 'fix-2821', sessionId: 'A' }, aStarted, () => '2026-09-27T20:54:34.000Z', false, false, false,
      { newerSameNameListed: true },
    )).toBeNull();
  });

  it('(c) refuses when the existing `started` record\'s own startedAt is AFTER the reaped session\'s last transcript activity — it cannot be this session\'s own report', () => {
    // a73a8bec's last confirmed activity was ~20:44Z, well BEFORE 71f95af4's 20:53:27 record.
    const lastActivityMs = Date.parse('2026-09-27T20:44:34.000Z');
    const rec = planBackstopCompletion(
      { name: 'fix-2821', sessionId: 'A' }, bStarted, () => '2026-09-27T20:54:34.000Z', false, false, false,
      { lastActivityMs },
    );
    expect(rec).toBeNull();
  });

  // Independent Codex review finding 1 (`we:backlog/4306-*.md`): a PLAIN "record started after the session
  // started" comparison is wrong — a session's own genuine `started` report always lands a few seconds after
  // its OWN listing `startedAt`, so that naive test would wrongly skip its own legitimate backstop too.
  // `lastActivityMs` (transcript activity, not listing start) does not have this false positive.
  it('(c) does NOT skip a session\'s own legitimate backstop just because its record started a few seconds after its OWN listing startedAt', () => {
    const ownRecord = {
      ...bStarted, sessionId: 'A', startedAt: '2026-09-27T20:04:30.000Z', updatedAt: '2026-09-27T20:04:30.000Z',
    }; // written 3s after a listing startedAt of 20:04:27
    const lastActivityMs = Date.parse('2026-09-27T20:40:00.000Z'); // it worked for a while before going quiet
    const rec = planBackstopCompletion(
      { name: 'fix-2821', sessionId: 'A' }, ownRecord, () => '2026-09-27T20:54:34.000Z', false, false, false,
      { lastActivityMs },
    );
    expect(rec).toMatchObject({ status: 'done', sessionId: 'A' });
  });

  it('an unresolvable `lastActivityMs` (null) never fires (c) on its own — unknown is never a guess', () => {
    const rec = planBackstopCompletion(
      { name: 'fix-2821', sessionId: 'A' }, { ...bStarted, sessionId: 'A' }, () => '2026-09-27T20:54:34.000Z',
      false, false, false, { lastActivityMs: null },
    );
    expect(rec).toMatchObject({ status: 'done', sessionId: 'A' });
  });

  // #4331 — ISOLATED Guard 1(c) fixtures. The (c) tests above use `bStarted` (sessionId 'B', foreign to 'A'),
  // so Guard 1(a) can refuse first and mask a deleted (c). These records are NOT foreign (legacy null id, or
  // the reaped session's own id), so only (c) can refuse.
  for (const [label, recSessionId] of [['legacy record (sessionId null)', null], ['matching-sessionId record', 'A']]) {
    it(`Guard 1(c) isolated: ${label} with later startedAt refuses`, () => {
      const rec = planBackstopCompletion(
        { name: 'fix-2821', sessionId: 'A' }, { ...bStarted, sessionId: recSessionId },
        () => '2026-09-27T20:54:34.000Z', false, false, false,
        { lastActivityMs: Date.parse('2026-09-27T20:44:34.000Z') }, // before bStarted.startedAt (20:53:27)
      );
      expect(rec).toBeNull();
    });
  }
});

// #4306 (independent panel review, standards-conformance lens) — a DIRECT unit test of the IO helper
// Guard-1(c) actually reads, not just the pure `planBackstopCompletion` decision fed a pre-computed number.
describe('resolveLastActivityMs — Guard 1(c)\'s own IO (#4306)', () => {
  const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const textEntry = (ts, text = 'x') => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });

  it('returns null when the session carries no cwd/sessionId — never a guess', () => {
    expect(resolveLastActivityMs(null)).toBeNull();
    expect(resolveLastActivityMs({ cwd: '/c' })).toBeNull();
    expect(resolveLastActivityMs({ sessionId: 's1' })).toBeNull();
  });

  it('returns null when no transcript can be resolved', () => {
    const result = resolveLastActivityMs({ cwd: '/c', sessionId: 's1' }, {
      resolveTranscript: () => { throw new Error('not found'); },
    });
    expect(result).toBeNull();
  });

  it('returns null when the transcript tail cannot be read', () => {
    const result = resolveLastActivityMs({ cwd: '/c', sessionId: 's1' }, {
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => { throw new Error('unreadable'); },
    });
    expect(result).toBeNull();
  });

  it('returns the NEWEST parseable `ts` among the tail lines, not the first or the last-in-file', () => {
    const lines = jsonl([
      textEntry('2026-09-27T20:00:00.000Z'),
      textEntry('2026-09-27T20:44:34.000Z'), // the newest
      textEntry('2026-09-27T20:10:00.000Z'),
    ]).split('\n').filter(Boolean);
    const result = resolveLastActivityMs({ cwd: '/c', sessionId: 's1' }, {
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines }),
      summarizeEntryFn: (raw) => { const o = JSON.parse(raw); return { kind: o.type, ts: o.timestamp, blocks: [] }; },
    });
    expect(result).toBe(Date.parse('2026-09-27T20:44:34.000Z'));
  });

  it('falls back to the transcript file\'s own mtime when no line carries a parseable `ts`', () => {
    const result = resolveLastActivityMs({ cwd: '/c', sessionId: 's1' }, {
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines: ['not json'] }),
      summarizeEntryFn: () => { throw new Error('unparseable'); },
      statFn: () => ({ mtimeMs: 123456 }),
    });
    expect(result).toBe(123456);
  });

  it('returns null when the mtime fallback itself is unreadable', () => {
    const result = resolveLastActivityMs({ cwd: '/c', sessionId: 's1' }, {
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines: ['not json'] }),
      summarizeEntryFn: () => { throw new Error('unparseable'); },
      statFn: () => { throw new Error('ENOENT'); },
    });
    expect(result).toBeNull();
  });

  it('one unparseable line never aborts the scan — the other lines still resolve a timestamp', () => {
    const result = resolveLastActivityMs({ cwd: '/c', sessionId: 's1' }, {
      resolveTranscript: () => '/fake/path.jsonl',
      tailLinesFn: () => ({ lines: ['not json', JSON.stringify({ type: 'assistant', timestamp: '2026-09-27T20:44:34.000Z' })] }),
      summarizeEntryFn: (raw) => { if (raw === 'not json') throw new Error('bad'); const o = JSON.parse(raw); return { kind: o.type, ts: o.timestamp, blocks: [] }; },
    });
    expect(result).toBe(Date.parse('2026-09-27T20:44:34.000Z'));
  });

  it('an unparseable line still tolerated regardless of position — this consumer never reads entries, so a dropped newest line changes nothing it cares about (#4312 converge review)', () => {
    // Unlike readHungInfo/readIdleFinishedInfo (hung-session.test.mjs), resolveLastActivityMs never derives a
    // pending-tool-call verdict from `entries`, so it has no reason to refuse a partial read. It stays exactly
    // as tolerant as it was before #4312's extraction, whichever position the bad line sits at.
    const result = resolveLastActivityMs({ cwd: '/c', sessionId: 's1' }, {
      resolveTranscript: () => '/fake/path.jsonl',
      // The GOOD line is FIRST (older); the BAD line is LAST (the tail's own newest).
      tailLinesFn: () => ({ lines: [JSON.stringify({ type: 'assistant', timestamp: '2026-09-27T20:44:34.000Z' }), 'not json'] }),
      summarizeEntryFn: (raw) => { if (raw === 'not json') throw new Error('bad'); const o = JSON.parse(raw); return { kind: o.type, ts: o.timestamp, blocks: [] }; },
      statFn: () => { throw new Error('must not be reached — an older real timestamp already exists'); },
    });
    expect(result).toBe(Date.parse('2026-09-27T20:44:34.000Z'));
  });
});

describe('transcriptShowsIntendedBlockedOnInfra — reading the crashed session\'s own last words (PR #2647/#2625, 2026-09-25)', () => {
  const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const textEntry = (text) => ({ type: 'assistant', timestamp: '2026-09-25T15:00:00Z', message: { content: [{ type: 'text', text }] } });
  const toolUseEntry = (command) => ({ type: 'assistant', timestamp: '2026-09-25T15:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } });

  it('true when the newest assistant text states it is blocked on infra', () => {
    const found = transcriptShowsIntendedBlockedOnInfra(
      { cwd: '/c', sessionId: 's1' },
      {
        resolveTranscript: () => '/fake/path.jsonl',
        tailLinesFn: () => ({ lines: [jsonl([textEntry('I am blocked-on-infra, cannot proceed')])].map((s) => s.trim()) }),
        summarizeEntryFn: (raw) => { const o = JSON.parse(raw); return { kind: o.type, blocks: [{ kind: 'text', text: o.message.content[0].text }] }; },
      },
    );
    expect(found).toBe(true);
  });

  it('true when the newest tool_use attempted the completion-cli report call, even though it never resolved', () => {
    const found = transcriptShowsIntendedBlockedOnInfra(
      { cwd: '/c', sessionId: 's1' },
      {
        resolveTranscript: () => '/fake/path.jsonl',
        tailLinesFn: () => ({ lines: ['line1'] }),
        summarizeEntryFn: () => ({ kind: 'assistant', blocks: [{ kind: 'tool_use', input: 'node scripts/operations/completion-cli.mjs report --status=done --outcome=blocked-on-infra' }] }),
      },
    );
    expect(found).toBe(true);
  });

  it('tolerates a space instead of a hyphen ("blocked on infra") and is case-insensitive', () => {
    const found = transcriptShowsIntendedBlockedOnInfra(
      { cwd: '/c', sessionId: 's1' },
      {
        resolveTranscript: () => '/fake/path.jsonl',
        tailLinesFn: () => ({ lines: ['line1'] }),
        summarizeEntryFn: () => ({ kind: 'assistant', blocks: [{ kind: 'text', text: 'Looks like I am BLOCKED ON INFRA here.' }] }),
      },
    );
    expect(found).toBe(true);
  });

  it('false when nothing in the tail mentions it', () => {
    const found = transcriptShowsIntendedBlockedOnInfra(
      { cwd: '/c', sessionId: 's1' },
      {
        resolveTranscript: () => '/fake/path.jsonl',
        tailLinesFn: () => ({ lines: ['line1'] }),
        summarizeEntryFn: () => ({ kind: 'assistant', blocks: [{ kind: 'text', text: 'Running the tests now.' }] }),
      },
    );
    expect(found).toBe(false);
  });

  it('a `user`-role entry mentioning the phrase (the injected review-agent BRIEF quotes it as an instruction) is NEVER a match — only the agent\'s own assistant-authored words count', () => {
    const found = transcriptShowsIntendedBlockedOnInfra(
      { cwd: '/c', sessionId: 's1' },
      {
        resolveTranscript: () => '/fake/path.jsonl',
        tailLinesFn: () => ({ lines: ['line1'] }),
        summarizeEntryFn: () => ({ kind: 'user', blocks: [{ kind: 'text', text: 'report done with --outcome=blocked-on-infra if you cannot proceed' }] }),
      },
    );
    expect(found).toBe(false);
  });

  it('false, never a guess, when the session is missing cwd/sessionId or the transcript is unreadable', () => {
    expect(transcriptShowsIntendedBlockedOnInfra(null)).toBe(false);
    expect(transcriptShowsIntendedBlockedOnInfra({ cwd: '/c' })).toBe(false); // no sessionId
    expect(transcriptShowsIntendedBlockedOnInfra(
      { cwd: '/c', sessionId: 's1' },
      { resolveTranscript: () => { throw new Error('ENOENT'); } },
    )).toBe(false);
    expect(transcriptShowsIntendedBlockedOnInfra(
      { cwd: '/c', sessionId: 's1' },
      { resolveTranscript: () => '/fake/path.jsonl', tailLinesFn: () => { throw new Error('unreadable'); } },
    )).toBe(false);
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

  // #4306 (independent panel review, standards-conformance lens) — a PASS-LEVEL proof that Guard 1(b)'s own
  // WIRING (computing `newerSameNameListed` from the real `sessions` listing via `normalizeHandle`/
  // `startedAtMs`) refuses the backstop, not just the pure `planBackstopCompletion` fed a pre-computed flag.
  it('Guard 1(b): two REAL rows sharing one name in the listing (older reaped, newer live) refuse the backstop — the wiring itself, not a pre-computed flag', () => {
    const written = [];
    const now = Date.now();
    const older = {
      id: 'old1', sessionId: 'A', cwd: '/scratch/old', kind: 'background', state: 'done', name: 'fix-9', startedAt: now - 40 * 60_000,
    };
    const newer = {
      id: 'new1', sessionId: 'B', cwd: '/scratch/new', kind: 'background', state: 'working', name: 'fix-9', startedAt: now - 5 * 60_000,
    };
    const existingRecord = {
      v: 1, session: 'fix-9', kind: 'fix', pr: '9', item: null, status: 'started', outcome: null, verdict: null,
      label: null, runId: null, sessionId: 'B', startedAt: '2026-09-27T20:53:27.000Z', updatedAt: '2026-09-27T20:53:27.000Z',
    };
    const result = runSessionReaperPass({
      listAgents: () => [older, newer],
      groundTruthFor: () => null,
      completionFor: () => null,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => existingRecord,
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(result.stopped).toBe(1); // the OLD, terminal row is still reaped …
    expect(written).toHaveLength(0); // … but Guard 1(b)'s own listing scan refuses the backstop over it
  });

  // #4306 (independent panel review, red-team standards-conformance) — a PASS-LEVEL proof that Guard 1(c)'s
  // own WIRING (the real `resolveLastActivityMs(session)` call inside `runSessionReaperPass`, reading a REAL
  // transcript file) refuses the backstop, not just `planBackstopCompletion` fed a pre-computed
  // `lastActivityMs` number. `CLAUDE_PROJECTS_DIR` must be re-stubbed AND the module re-imported fresh
  // (`vi.resetModules()`) because `agent-health.mjs#PROJECTS_DIR` is a module-level constant computed once at
  // first import — the same technique `hung-session.test.mjs`'s own `readHungInfo` IO-shell tests already use.
  it('Guard 1(c): the REAL wiring reads a REAL transcript file and refuses the backstop — not a pre-computed lastActivityMs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-reaper-guard1c-wiring-'));
    const projects = join(root, 'projects');
    const cwd = '/scratch/fix-2821-lane';
    const sessionId = 'sess-A-guard1c';
    const slug = cwd.replaceAll('/', '-');
    mkdirSync(join(projects, slug), { recursive: true });
    const transcriptFile = join(projects, slug, `${sessionId}.jsonl`);
    // The session's own last confirmed activity was 20 minutes ago — well before the on-disk record's own
    // `startedAt` (now), so Guard 1(c) must conclude that record cannot be this session's own report.
    const staleTs = new Date(Date.now() - 20 * 60_000).toISOString();
    writeFileSync(transcriptFile, `${JSON.stringify({ type: 'assistant', timestamp: staleTs, message: { content: [{ type: 'text', text: 'done, re-armed' }] } })}\n`);

    const previousProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
    vi.stubEnv('CLAUDE_PROJECTS_DIR', projects);
    vi.resetModules();
    try {
      const { runSessionReaperPass: freshRunSessionReaperPass } = await import('../session-reaper.mjs');
      const written = [];
      const existingRecord = {
        v: 1, session: 'fix-2821', kind: 'fix', pr: '2821', item: null, status: 'started', outcome: null,
        verdict: null, label: null, runId: null, sessionId: 'A',
        startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      const result = freshRunSessionReaperPass({
        listAgents: () => [{
          id: 'a1', sessionId, cwd, kind: 'background', state: 'done', name: 'fix-2821',
        }],
        groundTruthFor: () => null,
        completionFor: () => null,
        stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
        readCompletionRecord: () => existingRecord,
        writeCompletionRecord: (rec) => { written.push(rec); },
        log: () => {},
      });
      expect(result.stopped).toBe(1);
      expect(written).toHaveLength(0); // Guard 1(c) refused via the REAL transcript read, not a pre-computed flag
    } finally {
      vi.unstubAllEnvs();
      if (previousProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
      else process.env.CLAUDE_PROJECTS_DIR = previousProjectsDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #4331 — pass-level Guard 1(c) with (a) and (b) provably inert: the row's sessionId equals the transcript
  // filename and the record's (or the record's is null/legacy), and there is exactly ONE listing row. Only
  // (c), reached through the real `resolveLastActivityMs(session)` wiring, can refuse.
  for (const [label, recSessionId] of [['legacy record', null], ['matching-sessionId record', 'sess-A-isolated']]) {
    it(`Guard 1(c) isolated: pass-level wiring refuses with a REAL transcript (${label})`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'session-reaper-guard1c-isolated-'));
      const projects = join(root, 'projects');
      const cwd = '/scratch/fix-2821-isolated-lane';
      const sessionId = 'sess-A-isolated';
      const slug = cwd.replaceAll('/', '-');
      mkdirSync(join(projects, slug), { recursive: true });
      const staleTs = new Date(Date.now() - 20 * 60_000).toISOString();
      writeFileSync(join(projects, slug, `${sessionId}.jsonl`), `${JSON.stringify({ type: 'assistant', timestamp: staleTs, message: { content: [{ type: 'text', text: 'done' }] } })}\n`);

      const previousProjectsDir = process.env.CLAUDE_PROJECTS_DIR;
      vi.stubEnv('CLAUDE_PROJECTS_DIR', projects);
      vi.resetModules();
      try {
        const { runSessionReaperPass: freshRunSessionReaperPass } = await import('../session-reaper.mjs');
        const written = [];
        const existingRecord = {
          v: 1, session: 'fix-2821', kind: 'fix', pr: '2821', item: null, status: 'started', outcome: null,
          verdict: null, label: null, runId: null, sessionId: recSessionId,
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        const result = freshRunSessionReaperPass({
          listAgents: () => [{ id: 'a1', sessionId, cwd, kind: 'background', state: 'done', name: 'fix-2821' }],
          groundTruthFor: () => null,
          completionFor: () => null,
          stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
          readCompletionRecord: () => existingRecord,
          writeCompletionRecord: (rec) => { written.push(rec); },
          log: () => {},
        });
        expect(result.stopped).toBe(1);
        expect(written).toHaveLength(0);
      } finally {
        vi.unstubAllEnvs();
        if (previousProjectsDir === undefined) delete process.env.CLAUDE_PROJECTS_DIR;
        else process.env.CLAUDE_PROJECTS_DIR = previousProjectsDir;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  // #4331 Guard 1 — duplicate-code check (text-level). #4312 extracted the tail-read/newest-`ts`/mtime loop
  // into `hung-session.mjs#readTranscriptTailActivity`; fail if the reaper re-grows its own copy.
  it('Guard 1: no local transcript-timestamp loop in session-reaper.mjs', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/conveyor/session-reaper.mjs'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
    expect(code).not.toMatch(/entry\?\.ts\b/);
    expect(code).not.toMatch(/\.ts\s*\?\?/);
    const start = code.indexOf('export function resolveLastActivityMs');
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf('\n}\n', start);
    const body = code.slice(start, end);
    expect(body).toContain('readTranscriptTailActivity(');
    expect(body).not.toMatch(/summarizeEntryFn\(/);
    expect(body).not.toMatch(/\bstat(Fn|Sync)\(/);
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

  // #4306 (independent panel review, correctness lens) — every OTHER test in this describe block injects
  // `readCompletionRecord`/`writeCompletionRecord`; this one exercises the REAL production defaults
  // (`tryReadCompletion`/`writeCompletion`, never overridden) end to end, proving the conditional-write wiring
  // (`{expectPrior}`) the reaper's own call site passes actually reaches the real store and lands a real file —
  // not just a test double that happens to forward the third argument faithfully.
  it('the REAL default writeCompletionRecord/readCompletionRecord (never injected) write a real backstop file end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-session-reaper-real-backstop-'));
    const previous = process.env.OPERATION_COMPLETIONS_DIR;
    process.env.OPERATION_COMPLETIONS_DIR = dir;
    try {
      const result = runSessionReaperPass({
        listAgents: () => [{
          id: 'd1', sessionId: 'A', kind: 'background', state: 'done', name: 'review-1862',
        }],
        groundTruthFor: () => null,
        completionFor: () => null,
        stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
        log: () => {},
      });
      expect(result.backstopWritten).toBe(1);
      const onDisk = JSON.parse(readFileSync(join(dir, 'review-1862.json'), 'utf8'));
      expect(onDisk).toMatchObject({
        session: 'review-1862', status: 'done', outcome: UNREPORTED_EXIT_OUTCOME, sessionId: 'A',
      });
    } finally {
      if (previous === undefined) delete process.env.OPERATION_COMPLETIONS_DIR;
      else process.env.OPERATION_COMPLETIONS_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Live incident fix (PR #2647/#2625, 2026-09-25) — the outcome the backstop write carries actually reflects
  // what `blockedOnInfraFor` said, end to end through the real dry-run/live paths (not just the pure function).
  it('writes BLOCKED_ON_INFRA_OUTCOME when the injected transcript resolver says the session intended it', () => {
    const written = [];
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'r1', sessionId: 'r1-full', cwd: '/wev-review-daemon', kind: 'background', state: 'done', name: 'review-2647' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      blockedOnInfraFor: (session) => session.name === 'review-2647',
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => null,
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(result.backstopWritten).toBe(1);
    expect(written[0]).toMatchObject({ session: 'review-2647', status: 'done', outcome: BLOCKED_ON_INFRA_OUTCOME });
  });

  it('dry-run reports the ACTUAL outcome (blocked-on-infra), not the generic one, when the resolver says so', () => {
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'r1', sessionId: 'r1-full', cwd: '/wev-review-daemon', kind: 'background', state: 'done', name: 'review-2647' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      blockedOnInfraFor: () => true,
      dryRun: true,
      readCompletionRecord: () => null,
      writeCompletionRecord: () => { throw new Error('dry-run must never write'); },
      log: () => {},
    });
    expect(result.wouldWriteBackstop).toEqual([{ name: 'review-2647', outcome: BLOCKED_ON_INFRA_OUTCOME }]);
  });

  it('a `blockedOnInfraFor` that throws is treated as false — never crashes the pass, never guesses', () => {
    const written = [];
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'r1', sessionId: 'r1-full', kind: 'background', state: 'done', name: 'review-2647' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      blockedOnInfraFor: () => { throw new Error('unreadable'); },
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => null,
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(written[0]).toMatchObject({ outcome: UNREPORTED_EXIT_OUTCOME });
  });

  it('`blockedOnInfraFor: null` is a rollback escape hatch — byte-identical to the pre-fix generic outcome', () => {
    const written = [];
    runSessionReaperPass({
      listAgents: () => [{ id: 'r1', sessionId: 'r1-full', kind: 'background', state: 'done', name: 'review-2647' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      blockedOnInfraFor: null,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => null,
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(written[0]).toMatchObject({ outcome: UNREPORTED_EXIT_OUTCOME });
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

  describe('#4149 (epic #3383/#4075) — `blocked-on-infra` STOPS the process immediately; the record, never the process, holds the cool-off', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-session-reaper-cooloff-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('reports done EVEN WHILE a `blocked-on-infra` outcome is still inside the cool-off — THE BUG THIS FIXES: before, `status: done` alone was gated on the cool-off here too, so the live process (and every `claude agents` reader treating it as a live holder) sat un-stopped for the full 15+ minutes; the cool-off itself is now enforced only by reconcile-core.mjs#markSelfReportedDone/assessLiveness, against this SAME record, never by keeping this resolver blind to a done status', () => {
      const startedAt = () => '2026-09-24T23:00:00.000Z';
      const updatedAt = '2026-09-24T23:05:00.000Z'; // 5 min after start — well inside the 15-min cool-off
      const rec = applyCompletionUpdate(
        newCompletionRecord({ session: 'review-2588', kind: 'review', pr: '2588', now: startedAt }),
        { status: 'done', outcome: 'blocked-on-infra' },
        () => updatedAt,
      );
      writeCompletion(rec, dir);
      const resolver = makeCompletionResolver({ dir });
      expect(resolver('review-2588')).toEqual({ done: true });
    });

    it('a non-infra outcome (a real verdict) reports done too — there is no cool-off distinction left in THIS resolver at all', () => {
      const startedAt = () => '2026-09-24T23:00:00.000Z';
      const updatedAt = '2026-09-24T23:05:00.000Z';
      const rec = applyCompletionUpdate(
        newCompletionRecord({ session: 'review-2588', kind: 'review', pr: '2588', now: startedAt }),
        { status: 'done', outcome: 'accepted' },
        () => updatedAt,
      );
      writeCompletion(rec, dir);
      const resolver = makeCompletionResolver({ dir });
      expect(resolver('review-2588')).toEqual({ done: true });
    });

    it('a NOT-done record still answers `{ done: false }` — this resolver never guesses, it just no longer gates on outcome/cool-off', () => {
      const rec = newCompletionRecord({ session: 'review-2588', kind: 'review', pr: '2588', now: () => '2026-09-24T23:00:00.000Z' });
      writeCompletion(rec, dir); // status stays 'started' — newCompletionRecord's own default
      const resolver = makeCompletionResolver({ dir });
      expect(resolver('review-2588')).toEqual({ done: false });
    });

    it('classifySessionReapWithGroundTruth NOW upgrades a `blocked`/`working` session to reap even inside the cool-off — the process is stopped immediately (#4149); reconcile-core.mjs is what keeps the PR from being redispatched until the SAME window elapses', () => {
      const startedAt = () => '2026-09-24T23:00:00.000Z';
      const updatedAt = '2026-09-24T23:05:00.000Z';
      const rec = applyCompletionUpdate(
        newCompletionRecord({ session: 'review-2588', kind: 'review', pr: '2588', now: startedAt }),
        { status: 'done', outcome: 'blocked-on-infra' },
        () => updatedAt,
      );
      writeCompletion(rec, dir);
      const completionFor = makeCompletionResolver({ dir });
      const session = { name: 'review-2588', kind: 'background', state: 'blocked', cwd: '/repo' };
      const verdict = classifySessionReapWithGroundTruth(session, () => null, { completionFor });
      expect(verdict).toEqual({ reap: true, reason: 'completion-record-done' });
    });
  });

  // #4306 (epic #3383/#4075, BLOCKER fix-2821) — GUARD 2: "a completion record only ever speaks for the
  // session that wrote it." A ROW (not a bare name) lets this resolver bind the record it reads to the session
  // asking about it.
  describe('#4306 Guard 2 — row binding: a foreign sessionId never speaks for this row, a matching/legacy one still does', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-session-reaper-ownership-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('a bare STRING name keeps the pre-#4306 behavior byte-identical — no binding applied', () => {
      const rec = applyCompletionUpdate(
        newCompletionRecord({ session: 'fix-2821', kind: 'fix', pr: '2821', sessionId: 'A', now: () => '2026-09-27T20:04:27.000Z' }),
        { status: 'done', outcome: 'unreported-exit' },
        () => '2026-09-27T20:54:34.000Z',
      );
      writeCompletion(rec, dir);
      const resolver = makeCompletionResolver({ dir });
      expect(resolver('fix-2821')).toEqual({ done: true }); // a plain string never binds — same as always
    });

    it('a ROW with a matching sessionId still reads done: true', () => {
      const rec = applyCompletionUpdate(
        newCompletionRecord({ session: 'fix-2821', kind: 'fix', pr: '2821', sessionId: 'A', now: () => '2026-09-27T20:04:27.000Z' }),
        { status: 'done', outcome: 'unreported-exit' },
        () => '2026-09-27T20:54:34.000Z',
      );
      writeCompletion(rec, dir);
      const resolver = makeCompletionResolver({ dir });
      expect(resolver({ name: 'fix-2821', sessionId: 'A' })).toEqual({ done: true });
    });

    it('a ROW with a DIFFERENT (foreign) sessionId never reads done: true, however the on-disk status reads — never downgraded to legacy', () => {
      const rec = applyCompletionUpdate(
        newCompletionRecord({ session: 'fix-2821', kind: 'fix', pr: '2821', sessionId: 'A', now: () => '2026-09-27T20:53:27.000Z' }),
        { status: 'done', outcome: 'unreported-exit' },
        () => '2026-09-27T20:54:34.000Z',
      );
      writeCompletion(rec, dir); // the reaper's own backstop for OLD generation A, clobbering the name
      const resolver = makeCompletionResolver({ dir });
      expect(resolver({ name: 'fix-2821', sessionId: 'B' })).toEqual({ done: false }); // B is still live — never told it's done
    });

    it('a legacy record (no sessionId at all) keeps today\'s plain status rule for a ROW too', () => {
      const rec = newCompletionRecord({ session: 'fix-2821', kind: 'fix', pr: '2821', now: () => '2026-09-27T20:04:27.000Z' });
      writeCompletion({ ...rec, status: 'done', outcome: 'accepted' }, dir);
      const resolver = makeCompletionResolver({ dir });
      expect(resolver({ name: 'fix-2821', sessionId: 'B' })).toEqual({ done: true });
    });

    // THE PASS-LEVEL PROOF (Test plan item 1's own last sentence): drive the REAL classifier end to end. A
    // foreign `done` record must not stop a working same-name session B; B's own `done` record must.
    it('classifySessionReapWithGroundTruth: a foreign done record does not reap a live same-name session B; B\'s own done record does', () => {
      const foreign = applyCompletionUpdate(
        newCompletionRecord({ session: 'fix-2821', kind: 'fix', pr: '2821', sessionId: 'A', now: () => '2026-09-27T20:04:27.000Z' }),
        { status: 'done', outcome: 'unreported-exit' },
        () => '2026-09-27T20:54:34.000Z',
      );
      writeCompletion(foreign, dir);
      const completionFor = makeCompletionResolver({ dir });
      const sessionB = {
        name: 'fix-2821', sessionId: 'B', kind: 'background', state: 'working', cwd: '/repo',
      };
      // B is `state: working` and its own name's on-disk record is foreign — never reaped on this axis.
      expect(classifySessionReapWithGroundTruth(sessionB, () => null, { completionFor }).reap).toBe(false);

      // Now B reports its OWN done — the SAME name, B's OWN sessionId.
      const ownRecord = applyCompletionUpdate(foreign, { status: 'done', outcome: 'accepted', sessionId: 'B' }, () => '2026-09-27T21:00:00.000Z');
      writeCompletion(ownRecord, dir);
      const blockedSessionB = { ...sessionB, state: 'blocked' };
      expect(classifySessionReapWithGroundTruth(blockedSessionB, () => null, { completionFor }))
        .toEqual({ reap: true, reason: 'completion-record-done' });
    });
  });
});

// #4089 (epic #3383/#4075, statute `#conveyor-session-lifecycle-policy` clause 1) — the retention sweep: a
// FINISHED session's own RECORDS (completion record, delivery report, `claude agents` entry) are deletable
// only once the work they served is confirmed over, past a grace period, or unconditionally past a ceiling.
describe('classifyRetention — the pure two-path verdict', () => {
  const now = 1_000_000_000;
  it('PATH A: deletes once confirmed done, past the grace period', () => {
    const v = classifyRetention(
      { workDone: true, terminalAt: now - 1000, introspectionDone: true, costRolledUp: true, recordAgeMs: 500 },
      { graceMs: 999, ceilingMs: null, now },
    );
    expect(v).toEqual({ deletable: true, reason: 'grace-after-done' });
  });
  it('PATH A: NOT yet deletable before the grace period elapses', () => {
    const v = classifyRetention(
      { workDone: true, terminalAt: now - 10, introspectionDone: true, costRolledUp: true, recordAgeMs: 10 },
      { graceMs: 999, ceilingMs: null, now },
    );
    expect(v).toEqual({ deletable: false, reason: 'not-yet' });
  });
  it('PATH A: never deletes while `workDone`/`introspectionDone`/`costRolledUp` is not ALL true, however old', () => {
    for (const partial of [
      { workDone: false, terminalAt: now - 10_000, introspectionDone: true, costRolledUp: true },
      { workDone: true, terminalAt: now - 10_000, introspectionDone: false, costRolledUp: true },
      { workDone: true, terminalAt: now - 10_000, introspectionDone: true, costRolledUp: false },
    ]) {
      expect(classifyRetention({ ...partial, recordAgeMs: 10_000 }, { graceMs: 1, ceilingMs: null, now }))
        .toEqual({ deletable: false, reason: 'not-yet' });
    }
  });
  it("`graceMs: null` (the 'never' setting) disables path A outright", () => {
    const v = classifyRetention(
      { workDone: true, terminalAt: now - 1_000_000, introspectionDone: true, costRolledUp: true, recordAgeMs: 1_000_000 },
      { graceMs: null, ceilingMs: null, now },
    );
    expect(v).toEqual({ deletable: false, reason: 'not-yet' });
  });
  it('PATH B: the ceiling deletes unconditionally, even with workDone:false (a card that never finishes)', () => {
    const v = classifyRetention(
      { workDone: false, terminalAt: null, introspectionDone: false, costRolledUp: false, recordAgeMs: 5000 },
      { graceMs: null, ceilingMs: 4999, now },
    );
    expect(v).toEqual({ deletable: true, reason: 'ceiling' });
  });
  it("`ceilingMs: null` (the 'never' setting) disables path B outright", () => {
    const v = classifyRetention(
      { workDone: false, terminalAt: null, introspectionDone: false, costRolledUp: false, recordAgeMs: Number.MAX_SAFE_INTEGER },
      { graceMs: null, ceilingMs: null, now },
    );
    expect(v).toEqual({ deletable: false, reason: 'not-yet' });
  });
  it('the ceiling is checked FIRST — it wins even when path A would also say yes', () => {
    const v = classifyRetention(
      { workDone: true, terminalAt: now - 100, introspectionDone: true, costRolledUp: true, recordAgeMs: 10 },
      { graceMs: 1, ceilingMs: 5, now },
    );
    expect(v).toEqual({ deletable: true, reason: 'ceiling' });
  });
});

describe('resolveRetentionGraceMs / resolveRetentionCeilingMs — the env-overridable settings', () => {
  it('default to 1 day grace / 30 day ceiling when unset', () => {
    expect(resolveRetentionGraceMs({})).toBe(RETENTION_GRACE_MS_DEFAULT);
    expect(resolveRetentionCeilingMs({})).toBe(RETENTION_CEILING_MS_DEFAULT);
    expect(RETENTION_GRACE_MS_DEFAULT).toBe(24 * 60 * 60 * 1000);
    expect(RETENTION_CEILING_MS_DEFAULT).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it('`WE_RETENTION_GRACE_HOURS` / `WE_RETENTION_CEILING_DAYS` override the defaults', () => {
    expect(resolveRetentionGraceMs({ WE_RETENTION_GRACE_HOURS: '2' })).toBe(2 * 60 * 60 * 1000);
    expect(resolveRetentionCeilingMs({ WE_RETENTION_CEILING_DAYS: '7' })).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it("the literal string 'never' disables the path (null), matching the statute's own \"no upper limit\" amendment", () => {
    expect(resolveRetentionGraceMs({ WE_RETENTION_GRACE_HOURS: 'never' })).toBeNull();
    expect(resolveRetentionCeilingMs({ WE_RETENTION_CEILING_DAYS: 'Never' })).toBeNull();
  });
});

describe('retentionGroundTruthForItem — item-kind ground truth (status + dateResolved)', () => {
  const fakeIo = (files) => ({
    readdirSyncFn: () => Object.keys(files),
    readFileSyncFn: (path) => {
      const name = path.split('/').pop();
      if (!(name in files)) throw new Error(`ENOENT: ${path}`);
      return files[name];
    },
  });
  it('workDone:true with a parsed terminalAt when status is resolved', () => {
    const io = fakeIo({ '4089-thing.md': '---\nstatus: resolved\ndateResolved: "2026-09-24"\n---\n# T\n' });
    expect(retentionGroundTruthForItem('4089', { backlogDir: '/backlog', ...io }))
      .toEqual({ workDone: true, terminalAt: Date.parse('2026-09-24') });
  });
  it('workDone:false for a `parked` item — this repo has no distinct `withdrawn` status, and parked may resume', () => {
    const io = fakeIo({ '4089-thing.md': '---\nstatus: parked\n---\n# T\n' });
    expect(retentionGroundTruthForItem('4089', { backlogDir: '/backlog', ...io })).toEqual({ workDone: false, terminalAt: null });
  });
  it('workDone:false, never true, when no card matches — absence is never done', () => {
    const io = fakeIo({ '9999-other.md': '---\nstatus: resolved\n---\n' });
    expect(retentionGroundTruthForItem('4089', { backlogDir: '/backlog', ...io })).toEqual({ workDone: false, terminalAt: null });
  });
  it('an unreadable backlog dir answers unknown, never a guess', () => {
    const io = { readdirSyncFn: () => { throw new Error('ENOENT'); }, readFileSyncFn: () => '' };
    expect(retentionGroundTruthForItem('4089', { backlogDir: '/backlog', ...io })).toEqual({ workDone: false, terminalAt: null });
  });
});

describe('retentionGroundTruthForPr — PR-kind ground truth (merged OR closed, wider than the stop axis)', () => {
  it('workDone:true for a MERGED pr, terminalAt from mergedAt', () => {
    const exec = () => JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-20T00:00:00Z' });
    expect(retentionGroundTruthForPr('100', { exec })).toEqual({ workDone: true, terminalAt: Date.parse('2026-09-20T00:00:00Z') });
  });
  it('workDone:true for a CLOSED (never merged) pr, terminalAt from closedAt', () => {
    const exec = () => JSON.stringify({ state: 'CLOSED', closedAt: '2026-09-21T00:00:00Z' });
    expect(retentionGroundTruthForPr('101', { exec })).toEqual({ workDone: true, terminalAt: Date.parse('2026-09-21T00:00:00Z') });
  });
  it('workDone:false for an OPEN pr', () => {
    const exec = () => JSON.stringify({ state: 'OPEN' });
    expect(retentionGroundTruthForPr('102', { exec })).toEqual({ workDone: false, terminalAt: null });
  });
  it('any `gh` failure answers null (unknown), never a guess', () => {
    const exec = () => { throw new Error('gh: not found'); };
    expect(retentionGroundTruthForPr('103', { exec })).toBeNull();
  });
});

describe('makeRetentionGroundTruthResolver — routes + caches, bounded PR calls', () => {
  it('routes item vs pr targets and caches repeat lookups', () => {
    let prCalls = 0;
    const exec = () => { prCalls++; return JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-20T00:00:00Z' }); };
    const resolver = makeRetentionGroundTruthResolver({
      exec,
      readdirSyncFn: () => ['4089-t.md'],
      readFileSyncFn: () => '---\nstatus: resolved\ndateResolved: "2026-09-24"\n---\n',
    });
    expect(resolver({ kind: 'item', id: '4089' })).toEqual({ workDone: true, terminalAt: Date.parse('2026-09-24') });
    expect(resolver({ kind: 'pr', id: '200', repo: 'we' })).toEqual({ workDone: true, terminalAt: Date.parse('2026-09-20T00:00:00Z') });
    expect(resolver({ kind: 'pr', id: '200', repo: 'we' })).toEqual({ workDone: true, terminalAt: Date.parse('2026-09-20T00:00:00Z') });
    expect(prCalls).toBe(1); // second lookup of the same target was cached
  });
  it('bounds `gh pr view` calls to maxPrViewCalls, leaving the rest unresolved (null) this pass', () => {
    let prCalls = 0;
    const exec = () => { prCalls++; return JSON.stringify({ state: 'MERGED', mergedAt: '2026-09-20T00:00:00Z' }); };
    const resolver = makeRetentionGroundTruthResolver({ exec, maxPrViewCalls: 1 });
    expect(resolver({ kind: 'pr', id: '201' })).not.toBeNull();
    expect(resolver({ kind: 'pr', id: '202' })).toBeNull();
    expect(prCalls).toBe(1);
  });
});

describe('makeIntrospectionDoneResolver — the #3477 deferral gate', () => {
  it('vacuously true when introspection is OFF (the default) — nothing was ever asked to run', () => {
    expect(makeIntrospectionDoneResolver({ env: {} })()).toBe(true);
    expect(makeIntrospectionDoneResolver({ env: { WE_INTROSPECTION_ENABLED: '0' } })()).toBe(true);
  });
  it('fail-closed when introspection is turned ON — #3477 has not shipped a real signal to read yet', () => {
    expect(makeIntrospectionDoneResolver({ env: { WE_INTROSPECTION_ENABLED: '1' } })()).toBe(false);
  });
});

describe('makeCostRolledUpResolver — the #4071 explicit statute deferral', () => {
  it('always true today — "This condition applies only once #4071 exists"', () => {
    expect(makeCostRolledUpResolver()()).toBe(true);
  });
});

describe('runRetentionSweepPass — the IO shell', () => {
  let completionsDir;
  let deliveryDir;
  let previousCompletions;
  let previousDelivery;
  beforeEach(() => {
    completionsDir = mkdtempSync(join(tmpdir(), 'we-retention-completions-'));
    deliveryDir = mkdtempSync(join(tmpdir(), 'we-retention-delivery-'));
    // BOTH env vars, every test — a test that sets only one leaks onto this checkout's REAL
    // `.operations/delivery-reports`/`.operations/completions` (gitignored, so `git reset` never clears it,
    // and this file's own `runRetentionSweepPass` calls `resolveCompletionsDir`/`resolveDeliveryReportsDir`
    // INTERNALLY — it takes no `dir` override at all, unlike every fs-shell test elsewhere in this repo that
    // passes `dir` explicitly). Found live: an earlier draft of these tests set only one var and a non-dry-run
    // case deleted real leftover delivery reports from this very checkout.
    previousCompletions = process.env.OPERATION_COMPLETIONS_DIR;
    previousDelivery = process.env.OPERATION_DELIVERY_REPORTS_DIR;
    process.env.OPERATION_COMPLETIONS_DIR = completionsDir;
    process.env.OPERATION_DELIVERY_REPORTS_DIR = deliveryDir;
  });
  afterEach(() => {
    rmSync(completionsDir, { recursive: true, force: true });
    rmSync(deliveryDir, { recursive: true, force: true });
    if (previousCompletions === undefined) delete process.env.OPERATION_COMPLETIONS_DIR; else process.env.OPERATION_COMPLETIONS_DIR = previousCompletions;
    if (previousDelivery === undefined) delete process.env.OPERATION_DELIVERY_REPORTS_DIR; else process.env.OPERATION_DELIVERY_REPORTS_DIR = previousDelivery;
  });

  const baseOpts = (extra = {}) => ({
    retentionGroundTruthFor: () => ({ workDone: true, terminalAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }),
    introspectionDoneFor: () => true,
    costRolledUpFor: () => true,
    graceMs: 24 * 60 * 60 * 1000,
    ceilingMs: null,
    now: Date.now(),
    listAgents: () => [],
    rm: () => ({ removed: true, alreadyGone: true, output: '' }),
    pruneRuns: () => ({ pruned: [] }),
    log: () => {},
    ...extra,
  });

  it('deletes a confirmed-done session\'s completion record and delivery report once past grace', () => {
    writeCompletion(newCompletionRecord({ session: 'conveyor-4089', kind: 'review', pr: '1' }), completionsDir);
    writeDeliveryReport(newDeliveryReport({ session: 'conveyor-4089', item: '4089' }), deliveryDir);
    const result = runRetentionSweepPass(baseOpts());
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(0);
    expect(tryReadCompletionSafe(completionsDir, 'conveyor-4089')).toBe(false);
  });

  it('keeps a session whose work is not yet confirmed done', () => {
    writeCompletion(newCompletionRecord({ session: 'conveyor-4090', kind: 'review', pr: '1' }), completionsDir);
    const result = runRetentionSweepPass(baseOpts({ retentionGroundTruthFor: () => ({ workDone: false, terminalAt: null }) }));
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
  });

  it('dry-run reports what would be deleted without touching disk', () => {
    writeCompletion(newCompletionRecord({ session: 'conveyor-4091', kind: 'review', pr: '1' }), completionsDir);
    const result = runRetentionSweepPass(baseOpts({ dryRun: true }));
    expect(result.deleted).toBe(0);
    expect(result.wouldDelete).toEqual([{ session: 'conveyor-4091', reason: 'grace-after-done' }]);
    expect(tryReadCompletionSafe(completionsDir, 'conveyor-4091')).toBe(true); // still on disk
  });

  it('an unknown session-slug grammar is skipped, never guessed', () => {
    writeCompletion(newCompletionRecord({ session: 'my-freeform-session-name', kind: 'review', pr: '1' }), completionsDir);
    const result = runRetentionSweepPass(baseOpts());
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
  });
});

// Tiny local helper — just "is the file still on disk", independent of the completion-store's own
// parse-or-refuse contract (not what these tests are checking).
function tryReadCompletionSafe(dir, session) {
  return existsSync(join(dir, `${session}.json`));
}

// #4188 (bornAs `x5qketq`, epic #4075) — the dispatch-scratch sweep: reap a finished dispatched session's
// scratch cwd folder (`.operations/dispatch/<uuid>`) and its CLI trust entry. Fixtures shaped as
// `claude agents --json --all` rows, matched by `sessionId` (the folder's own name), never `id` — same
// discipline the file header documents for the STOP axis.
describe('classifyDispatchScratchEntry — the pure per-folder verdict', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const opts = { graceMs: DAY, ceilingMs: 7 * DAY };

  it('keeps a young folder with no matching session at all (still within grace)', () => {
    expect(classifyDispatchScratchEntry({ ageMs: 5 * 60 * 1000, sessionRow: null, liveCwdInUse: false }, opts))
      .toEqual({ reap: false, reason: 'not-yet' });
  });

  it('reaps a folder whose session is gone from the listing entirely, once past grace ("reaped")', () => {
    expect(classifyDispatchScratchEntry({ ageMs: DAY + 1, sessionRow: null, liveCwdInUse: false }, opts))
      .toEqual({ reap: true, reason: 'unregistered' });
  });

  it('reaps a folder whose matched session is `done`, once past grace', () => {
    expect(classifyDispatchScratchEntry({ ageMs: DAY + 1, sessionRow: { state: 'done' }, liveCwdInUse: false }, opts))
      .toEqual({ reap: true, reason: 'finished:done' });
  });

  it('reaps a folder whose matched session is `stopped`, once past grace', () => {
    expect(classifyDispatchScratchEntry({ ageMs: DAY + 1, sessionRow: { state: 'stopped' }, liveCwdInUse: false }, opts))
      .toEqual({ reap: true, reason: 'finished:stopped' });
  });

  it('NEVER reaps a folder whose matched session is still `working`, no matter its age', () => {
    expect(classifyDispatchScratchEntry({ ageMs: 30 * DAY, sessionRow: { state: 'working' }, liveCwdInUse: false }, opts))
      .toEqual({ reap: false, reason: 'still-live' });
  });

  it('NEVER reaps a folder whose matched session is still `blocked`, no matter its age', () => {
    expect(classifyDispatchScratchEntry({ ageMs: 30 * DAY, sessionRow: { state: 'blocked' }, liveCwdInUse: false }, opts))
      .toEqual({ reap: false, reason: 'still-live' });
  });

  it('a finished match still younger than grace is kept, not reaped early', () => {
    expect(classifyDispatchScratchEntry({ ageMs: 5 * 60 * 1000, sessionRow: { state: 'done' }, liveCwdInUse: false }, opts))
      .toEqual({ reap: false, reason: 'not-yet' });
  });

  it('path B — an unmatched folder past the ceiling is reaped when nothing live claims its cwd', () => {
    expect(classifyDispatchScratchEntry({ ageMs: 8 * DAY, sessionRow: null, liveCwdInUse: false }, opts))
      .toEqual({ reap: true, reason: 'unregistered' }); // already caught by path A (grace) — ceiling never needed here
  });

  it('path B never fires when a live session claims this exact directory as its cwd', () => {
    // Simulates: no row matched BY sessionId, but grace already elapsed too — so this actually hits path A's
    // "unregistered" branch first unless we gate grace off, proving the ceiling branch specifically:
    expect(classifyDispatchScratchEntry({ ageMs: 8 * DAY, sessionRow: null, liveCwdInUse: true }, { graceMs: null, ceilingMs: 7 * DAY }))
      .toEqual({ reap: false, reason: 'not-yet' });
  });

  // PR #2735 (A3 red-team of #2726/#4188) finding 1, MOST SERIOUS: path A (the grace branch, above) reaped an
  // "unregistered" folder (no row at all for this uuid) WITHOUT ever consulting `liveCwdInUse` — only path B
  // (the ceiling branch) gated on it. A folder can be unregistered YET still be a live process's own cwd (the
  // listing can be incomplete/wrong for a genuinely-live long-running session — see this file's own header on
  // why "no row" is weaker evidence than a real terminal state). Every deletion path must independently confirm
  // no live process still has this directory as its cwd.
  it('path A never reaps an unregistered folder once a live row claims this exact directory as its own cwd', () => {
    expect(classifyDispatchScratchEntry({ ageMs: DAY + 1, sessionRow: null, liveCwdInUse: true }, opts))
      .toEqual({ reap: false, reason: 'live-cwd-in-use' });
  });

  it('path A never reaps a matched-terminal folder either, once a live row claims this exact directory as its own cwd', () => {
    expect(classifyDispatchScratchEntry({ ageMs: DAY + 1, sessionRow: { state: 'done' }, liveCwdInUse: true }, opts))
      .toEqual({ reap: false, reason: 'live-cwd-in-use' });
  });

  it('`graceMs: null` disables path A outright', () => {
    expect(classifyDispatchScratchEntry({ ageMs: 30 * DAY, sessionRow: { state: 'done' }, liveCwdInUse: false }, { graceMs: null, ceilingMs: null }))
      .toEqual({ reap: false, reason: 'not-yet' });
  });

  it('`ceilingMs: null` disables path B outright', () => {
    expect(classifyDispatchScratchEntry({ ageMs: 30 * DAY, sessionRow: null, liveCwdInUse: true }, { graceMs: null, ceilingMs: null }))
      .toEqual({ reap: false, reason: 'not-yet' });
  });

  it('an unreadable/negative age never reaps — never a guess', () => {
    expect(classifyDispatchScratchEntry({ ageMs: null, sessionRow: null, liveCwdInUse: false }, opts))
      .toEqual({ reap: false, reason: 'unknown-age' });
    expect(classifyDispatchScratchEntry({ ageMs: -5, sessionRow: null, liveCwdInUse: false }, opts))
      .toEqual({ reap: false, reason: 'unknown-age' });
  });
});

describe('runDispatchScratchSweepPass — the IO shell', () => {
  let dispatchRoot;
  beforeEach(() => {
    dispatchRoot = mkdtempSync(join(tmpdir(), 'we-dispatch-scratch-'));
  });
  afterEach(() => {
    rmSync(dispatchRoot, { recursive: true, force: true });
  });

  const DAY = 24 * 60 * 60 * 1000;
  const makeOldFolder = (name, ageMs = DAY + 60_000) => {
    const dir = join(dispatchRoot, name);
    mkdirSync(dir, { recursive: true });
    const past = new Date(Date.now() - ageMs);
    utimesSync(dir, past, past);
    return dir;
  };

  it('removes a finished (done) session\'s folder and revokes its trust entry, once past grace', () => {
    const dir = makeOldFolder('sess-done-1');
    const revoked = [];
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => [{ kind: 'background', sessionId: 'sess-done-1', state: 'done', cwd: dir }],
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      revokeTrust: (dirs) => { revoked.push(...dirs); return { revoked: dirs }; },
      log: () => {},
    });
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(0);
    expect(result.trustRevoked).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(revoked).toEqual([dir]);
  });

  it('leaves a still-live session\'s folder AND trust entry completely untouched', () => {
    const dir = makeOldFolder('sess-live-1', 30 * DAY); // old — age alone must never be enough
    const revoked = [];
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => [{ kind: 'background', sessionId: 'sess-live-1', state: 'working', cwd: dir }],
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      revokeTrust: (dirs) => { revoked.push(...dirs); return { revoked: dirs }; },
      log: () => {},
    });
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
    expect(result.trustRevoked).toBe(0);
    expect(existsSync(dir)).toBe(true);
    expect(revoked).toEqual([]);
  });

  it('removes a folder whose session has vanished from the listing entirely ("reaped"), once past grace', () => {
    const dir = makeOldFolder('sess-gone-1');
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => [],
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      revokeTrust: (dirs) => ({ revoked: dirs }),
      log: () => {},
    });
    expect(result.deleted).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps a young folder even with no matching session — never guesses on a fresh dispatch race', () => {
    const dir = makeOldFolder('sess-young-1', 60_000);
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => [],
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      revokeTrust: () => ({ revoked: [] }),
      log: () => {},
    });
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  // LIVE-CAUGHT (2026-09-26): a real machine had `.lanes/.admission/gh` living INSIDE `.operations/dispatch/`
  // — a wholly different subsystem's own state, not a session-scratch folder at all, sharing the same parent
  // directory only by coincidence. This proves the fix: a dotdir is never even considered, no matter its age
  // or match state, because it can never be a CLI-minted session id (`isSafeSessionId`'s own gate).
  it('NEVER touches a dotdir (e.g. `.lanes`) sharing the dispatch root, no matter how old', () => {
    const dir = makeOldFolder('.lanes', 30 * DAY);
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => [],
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      revokeTrust: () => ({ revoked: [] }),
      log: () => {},
    });
    expect(result.scanned).toBe(0); // never even counted as a candidate
    expect(result.deleted).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it('a mixed listing removes only the finished/gone folders, never the live one, in one pass', () => {
    const done = makeOldFolder('sess-mix-done');
    const live = makeOldFolder('sess-mix-live', 30 * DAY);
    const gone = makeOldFolder('sess-mix-gone');
    const revoked = [];
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => [
        { kind: 'background', sessionId: 'sess-mix-done', state: 'done', cwd: done },
        { kind: 'background', sessionId: 'sess-mix-live', state: 'working', cwd: live },
      ],
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      revokeTrust: (dirs) => { revoked.push(...dirs); return { revoked: dirs }; },
      log: () => {},
    });
    expect(result.deleted).toBe(2);
    expect(result.kept).toBe(1);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(gone)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(revoked.sort()).toEqual([done, gone].sort());
  });

  it('dry-run reports what would be removed without touching disk or revoking trust', () => {
    const dir = makeOldFolder('sess-dry-1');
    let revokeCalled = false;
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => [{ kind: 'background', sessionId: 'sess-dry-1', state: 'done', cwd: dir }],
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      dryRun: true,
      revokeTrust: () => { revokeCalled = true; return { revoked: [] }; },
      log: () => {},
    });
    expect(result.deleted).toBe(0);
    expect(result.wouldDelete).toEqual([{ dir: 'sess-dry-1', reason: 'finished:done' }]);
    expect(existsSync(dir)).toBe(true);
    expect(revokeCalled).toBe(false);
  });

  // PR #2735 finding 1 (MOST SERIOUS, live-caught): the folder's own uuid has NO row in the listing
  // ("unregistered"), but a DIFFERENT live row in that same listing reports this exact directory as its own
  // `cwd` — proof this is a real, not merely theoretical, shape: a long-running session's registry row can
  // drift out of sync with the uuid its scratch folder was minted under while the process itself is still very
  // much alive and still working out of that folder.
  it('never deletes an unregistered folder that a DIFFERENT live row still claims as its own cwd', () => {
    const dir = makeOldFolder('sess-ghost-1');
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => [
        { kind: 'background', sessionId: 'some-other-live-session', state: 'working', cwd: dir },
      ],
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      revokeTrust: () => { throw new Error('must never be called — nothing was deleted'); },
      log: () => {},
    });
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  it('a missing dispatch-scratch root is a no-op, never a throw', () => {
    const result = runDispatchScratchSweepPass({
      dispatchRoot: join(dispatchRoot, 'does-not-exist'),
      listAgents: () => [],
      log: () => {},
    });
    expect(result).toMatchObject({ scanned: 0, deleted: 0, kept: 0 });
  });

  it('an unreadable `listAgents` degrades to no matches, never throws — path A cannot fire without a listing', () => {
    const dir = makeOldFolder('sess-unreadable-1', 60_000); // young — grace alone would keep it anyway
    const result = runDispatchScratchSweepPass({
      dispatchRoot,
      listAgents: () => { throw new Error('claude agents boom'); },
      graceMs: DAY,
      ceilingMs: 7 * DAY,
      log: () => {},
    });
    expect(result.deleted).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('resolveDispatchScratchGraceMs / resolveDispatchScratchCeilingMs — the env-overridable settings', () => {
  it('default to 24h grace / 7 day ceiling when unset', () => {
    expect(resolveDispatchScratchGraceMs({})).toBe(DISPATCH_SCRATCH_GRACE_MS_DEFAULT);
    expect(resolveDispatchScratchCeilingMs({})).toBe(DISPATCH_SCRATCH_CEILING_MS_DEFAULT);
    expect(DISPATCH_SCRATCH_GRACE_MS_DEFAULT).toBe(24 * 60 * 60 * 1000);
    expect(DISPATCH_SCRATCH_CEILING_MS_DEFAULT).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it('`WE_DISPATCH_SCRATCH_GRACE_HOURS` / `WE_DISPATCH_SCRATCH_CEILING_DAYS` override the defaults', () => {
    expect(resolveDispatchScratchGraceMs({ WE_DISPATCH_SCRATCH_GRACE_HOURS: '2' })).toBe(2 * 60 * 60 * 1000);
    expect(resolveDispatchScratchCeilingMs({ WE_DISPATCH_SCRATCH_CEILING_DAYS: '3' })).toBe(3 * 24 * 60 * 60 * 1000);
  });
  it("'never' disables either path (null)", () => {
    expect(resolveDispatchScratchGraceMs({ WE_DISPATCH_SCRATCH_GRACE_HOURS: 'never' })).toBeNull();
    expect(resolveDispatchScratchCeilingMs({ WE_DISPATCH_SCRATCH_CEILING_DAYS: 'never' })).toBeNull();
  });
});

// #4090 (epic #3383/#4075, statute clause 2) — the no-net-outcome outcome-timestamp resolvers.
describe('lastCommitAheadOfBaseMs — the build/fix outcome signal', () => {
  it('returns the newest ahead-of-base commit time, converted to ms', () => {
    const exec = () => '1758000000\n'; // an epoch-seconds `%ct` value
    expect(lastCommitAheadOfBaseMs('/lane-9', { exec })).toBe(1758000000 * 1000);
  });
  it('null when there is no commit ahead of base yet — not an error', () => {
    const exec = () => '';
    expect(lastCommitAheadOfBaseMs('/lane-9', { exec })).toBeNull();
  });
  it('OUTCOME_UNREADABLE on any git failure or a missing cwd — distinct from "no commit yet", never a guess', () => {
    expect(lastCommitAheadOfBaseMs('/lane-9', { exec: () => { throw new Error('not a git repo'); } })).toBe(OUTCOME_UNREADABLE);
    expect(lastCommitAheadOfBaseMs(null, { exec: () => '123' })).toBe(OUTCOME_UNREADABLE);
  });
});

describe('lastReviewCommentMs — the review outcome signal', () => {
  it('returns the newest comment createdAt, in ms', () => {
    const exec = () => JSON.stringify({ comments: [{ createdAt: '2026-09-25T10:00:00Z' }, { createdAt: '2026-09-25T12:00:00Z' }] });
    expect(lastReviewCommentMs('2647', { exec })).toBe(Date.parse('2026-09-25T12:00:00Z'));
  });
  it('null when there are no comments yet', () => {
    const exec = () => JSON.stringify({ comments: [] });
    expect(lastReviewCommentMs('2647', { exec })).toBeNull();
  });
  it('OUTCOME_UNREADABLE on any gh failure, unknown repo, or a response with no comments array — never a guess', () => {
    expect(lastReviewCommentMs('2647', { exec: () => { throw new Error('gh: not found'); } })).toBe(OUTCOME_UNREADABLE);
    expect(lastReviewCommentMs('2647', { exec: () => '{}', repo: 'not-a-real-repo' })).toBe(OUTCOME_UNREADABLE);
    expect(lastReviewCommentMs('2647', { exec: () => '{}' })).toBe(OUTCOME_UNREADABLE);
    expect(lastReviewCommentMs('2647', { exec: () => JSON.stringify({ comments: [{ createdAt: 'garbage' }] }) })).toBe(OUTCOME_UNREADABLE);
  });
});

describe('lastItemFileChangeMs — the prepare/prepare-decision outcome signal', () => {
  it('returns the matching item file\'s own mtime', () => {
    const io = {
      readdirSyncFn: () => ['4090-fixture-item.md'],
      statFn: () => ({ mtimeMs: 1758000000000 }),
    };
    expect(lastItemFileChangeMs('/lane-9', '4090', io)).toBe(1758000000000);
  });
  it('null when no card matches the id in this lane\'s own backlog dir — not an error', () => {
    const io = { readdirSyncFn: () => ['9999-other.md'], statFn: () => ({ mtimeMs: 1 }) };
    expect(lastItemFileChangeMs('/lane-9', '4090', io)).toBeNull();
  });
  it('OUTCOME_UNREADABLE on an unreadable dir/file, or a missing cwd/id — never a guess', () => {
    expect(lastItemFileChangeMs('/lane-9', '4090', { readdirSyncFn: () => { throw new Error('ENOENT'); } })).toBe(OUTCOME_UNREADABLE);
    expect(lastItemFileChangeMs('/lane-9', '4090', {
      readdirSyncFn: () => ['4090-fixture-item.md'], statFn: () => { throw new Error('EACCES'); },
    })).toBe(OUTCOME_UNREADABLE);
    expect(lastItemFileChangeMs(null, '4090')).toBe(OUTCOME_UNREADABLE);
    expect(lastItemFileChangeMs('/lane-9', null)).toBe(OUTCOME_UNREADABLE);
  });
});

describe('makeNoOutcomeResolver — routes by kind, resolves settings, classifies', () => {
  it('routes a `fix-<pr>` session to the commit-ahead-of-base signal', () => {
    const commitMs = 1758000000 * 1000;
    const exec = () => '1758000000\n';
    const now = () => commitMs + 5 * 60 * 1000; // 5 min after the commit — well inside the fix window (30 min)
    const resolver = makeNoOutcomeResolver({ exec, now });
    const session = { name: 'fix-2647', cwd: '/lane-9', startedAt: commitMs - 60 * 60 * 1000 };
    const result = resolver(session);
    expect(result.stall).toBe(false); // a fresh commit within the fix window (30 min default)
  });

  it('routes a `review-<pr>` session to the comment signal, and stalls once the window elapses with none', () => {
    const exec = () => JSON.stringify({ comments: [] });
    const now = () => Date.now();
    const resolver = makeNoOutcomeResolver({ exec, now });
    const staleStart = now() - 31 * 60 * 1000; // past the review kind's 30-minute default window
    const result = resolver({ name: 'review-2647', cwd: '/lane-9', startedAt: staleStart });
    expect(result).toEqual({ stall: true, reason: 'no-outcome-window' });
  });

  it('routes a `prepare-<item>` session to the item-file-mtime signal', () => {
    const readdirSyncFn = () => ['4090-fixture-item.md'];
    const nowMs = Date.now();
    const statFn = () => ({ mtimeMs: nowMs }); // just changed — fresh outcome
    const resolver = makeNoOutcomeResolver({ readdirSyncFn, statFn, now: () => nowMs });
    const result = resolver({ name: 'prepare-4090', cwd: '/lane-9', startedAt: nowMs - 60 * 60 * 1000 });
    expect(result.stall).toBe(false);
  });

  it('null for a `conveyor-<item>`/`prepare-decision-<item>` session too — routed, not skipped', () => {
    const exec = () => ''; // no ahead-of-base commit
    const now = () => Date.now();
    const resolver = makeNoOutcomeResolver({ exec, now });
    const staleStart = now() - 46 * 60 * 1000; // past the conveyor kind's 45-minute default window
    expect(resolver({ name: 'conveyor-4090', cwd: '/lane-9', startedAt: staleStart })).toEqual({ stall: true, reason: 'no-outcome-window' });
  });

  // PR #2676 review — the realistic case: a fix/review session's target already carries OLDER history.
  it('a fresh `fix-<pr>` session on a lane whose newest commit PREDATES its start is not stalled (baseline clamps)', () => {
    const MIN = 60_000;
    const startedAt = 1758000000 * 1000;
    const exec = () => `${(startedAt - 180 * MIN) / 1000}\n`; // the original build commit, 3h before dispatch
    const resolver = makeNoOutcomeResolver({ exec, now: () => startedAt + 5 * MIN });
    expect(resolver({ name: 'fix-2647', cwd: '/lane-9', startedAt })).toEqual({ stall: false, reason: 'active' });
  });

  it('a fresh `review-<pr>` session on a PR whose comments all PREDATE its start is not stalled', () => {
    const MIN = 60_000;
    const startedAt = Date.parse('2026-09-25T12:00:00Z');
    const exec = () => JSON.stringify({ comments: [{ createdAt: '2026-09-24T09:00:00Z' }] }); // yesterday
    const resolver = makeNoOutcomeResolver({ exec, now: () => startedAt + 5 * MIN });
    expect(resolver({ name: 'review-2647', cwd: '/lane-9', startedAt })).toEqual({ stall: false, reason: 'active' });
  });

  it('a fresh `prepare-<item>` session whose card mtime PREDATES its start is not stalled', () => {
    const MIN = 60_000;
    const startedAt = 1758000000 * 1000;
    const resolver = makeNoOutcomeResolver({
      readdirSyncFn: () => ['4090-fixture-item.md'],
      statFn: () => ({ mtimeMs: startedAt - 24 * 60 * MIN }), // last edited a day before dispatch
      now: () => startedAt + 5 * MIN,
    });
    expect(resolver({ name: 'prepare-4090', cwd: '/lane-9', startedAt })).toEqual({ stall: false, reason: 'active' });
  });

  it('an unreadable outcome source does not trigger the window before the ceiling (git and gh failures)', () => {
    const MIN = 60_000;
    const startedAt = 1758000000 * 1000;
    const now = () => startedAt + 45 * MIN; // past the fix/review 30-min window, before either ceiling (120/60)
    const failing = () => { throw new Error('gh: HTTP 401 / git: timed out'); };
    const resolver = makeNoOutcomeResolver({ exec: failing, now });
    expect(resolver({ name: 'fix-2647', cwd: '/lane-9', startedAt })).toEqual({ stall: false, reason: 'no-signal' });
    expect(resolver({ name: 'review-2647', cwd: '/lane-9', startedAt })).toEqual({ stall: false, reason: 'no-signal' });
    // …and the same failure composed through the reaper verdict leaves a `working` row alone.
    const verdict = classifySessionReapWithGroundTruth(
      { name: 'fix-2647', kind: 'background', state: 'working', cwd: '/lane-9', sessionId: 's1', startedAt },
      () => null,
      { noOutcomeFor: resolver, neverReapWorking: true },
    );
    expect(verdict.reap).toBe(false);
  });

  it('null for an uncovered kind (ci-heal/inspect), an unparseable name, or a missing startedAt', () => {
    const resolver = makeNoOutcomeResolver();
    expect(resolver({ name: 'ci-heal-2647', cwd: '/lane-9', startedAt: Date.now() })).toBeNull();
    expect(resolver({ name: 'inspect-2647', cwd: '/lane-9', startedAt: Date.now() })).toBeNull();
    expect(resolver({ name: 'my terminal', cwd: '/lane-9', startedAt: Date.now() })).toBeNull();
    expect(resolver({ name: 'review-2647', cwd: '/lane-9' })).toBeNull(); // no startedAt at all
  });
});

describe('classifySessionReapWithGroundTruth — axis -1 (no-net-outcome), wired end to end', () => {
  it('reaps a `working` session via the no-outcome axis, reason prefixed `no-outcome:`', () => {
    const session = { name: 'review-2647', kind: 'background', state: 'working', cwd: '/lane-9', sessionId: 's1' };
    const noOutcomeFor = () => ({ stall: true, reason: 'no-outcome-window' });
    const verdict = classifySessionReapWithGroundTruth(session, () => null, { noOutcomeFor });
    expect(verdict).toEqual({ reap: true, reason: 'no-outcome:no-outcome-window' });
  });

  it('fires even under `neverReapWorking: true` — same reasoning as the hung-transcript axis', () => {
    const session = { name: 'review-2647', kind: 'background', state: 'working', cwd: '/lane-9', sessionId: 's1' };
    const noOutcomeFor = () => ({ stall: true, reason: 'ceiling' });
    const verdict = classifySessionReapWithGroundTruth(session, () => null, { noOutcomeFor, neverReapWorking: true });
    expect(verdict).toEqual({ reap: true, reason: 'no-outcome:ceiling' });
  });

  it('a resolver that answers not-stalled, throws, or is absent leaves the row untouched by this axis', () => {
    const session = { name: 'review-2647', kind: 'background', state: 'working', cwd: '/lane-9', sessionId: 's1' };
    expect(classifySessionReapWithGroundTruth(session, () => null, { noOutcomeFor: () => ({ stall: false }) }).reap).toBe(false);
    expect(classifySessionReapWithGroundTruth(session, () => null, { noOutcomeFor: () => { throw new Error('unreadable'); } }).reap).toBe(false);
    expect(classifySessionReapWithGroundTruth(session, () => null, {}).reap).toBe(false);
  });
});

describe('runSessionReaperPass — the #4090 no-outcome axis writes a STALLED_OUTCOME backstop', () => {
  it('a review session reaped via no-outcome gets outcome:stalled, never the generic one', () => {
    const written = [];
    const result = runSessionReaperPass({
      listAgents: () => [{ id: 'r1', sessionId: 'r1-full', cwd: '/lane-9', kind: 'background', state: 'working', name: 'review-2647' }],
      groundTruthFor: () => null,
      completionFor: () => null,
      hungFor: () => null,
      noOutcomeFor: () => ({ stall: true, reason: 'no-outcome-window' }),
      neverReapWorking: true,
      stop: ({ handle }) => ({ stopped: true, alreadyGone: false, output: `stopped ${handle}` }),
      readCompletionRecord: () => null,
      writeCompletionRecord: (rec) => { written.push(rec); },
      log: () => {},
    });
    expect(result.stopped).toBe(1);
    expect(written[0]).toMatchObject({ session: 'review-2647', status: 'done', outcome: STALLED_OUTCOME });
  });
});

// #4091 (epic #3383/#4075, statute clause 4) — the chat-spawn link + guard.
describe('writeChatSpawnLink / tryReadChatSpawnLink — the link store', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-chat-spawns-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a link', () => {
    expect(writeChatSpawnLink({ spawnedSessionId: 'child-1', spawnedByChatSessionId: 'chat-1' }, dir)).toBe(true);
    expect(tryReadChatSpawnLink('child-1', dir)).toEqual({ ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: expect.any(Number) });
  });

  it('null (no link) when nothing was ever written — the "unchanged from today" default', () => {
    expect(tryReadChatSpawnLink('never-written', dir)).toBeNull();
  });

  it('{ok:false} for a corrupt file — AMBIGUOUS, never the same as "no link" — but STILL carries an age (the file\'s own mtime), so the ceiling can still apply to it (round-2 security fix, PR #2678)', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'child-2.json'), '{not json');
    expect(tryReadChatSpawnLink('child-2', dir)).toEqual({ ok: false, recordedAtMs: expect.any(Number) });
  });

  it('refuses an unsafe id as a filename, on both write and read — never a guess', () => {
    expect(writeChatSpawnLink({ spawnedSessionId: '../etc/passwd', spawnedByChatSessionId: 'chat-1' }, dir)).toBe(false);
    expect(tryReadChatSpawnLink('../etc/passwd', dir)).toBeNull();
  });

  // Independent-review correctness finding, PR #2678 (2026-09-25) — FIXED: the store used to default to
  // `REPO_ROOT` (this process's OWN checkout), which the `SessionStart` hook (running wherever the CHAT
  // itself is — a lane, the primary checkout, a scratch clone) almost never shares with the daemon's own
  // dedicated clone the reaper actually runs from. The default is now machine-wide, under `~/.claude/`.
  it('defaults to a MACHINE-WIDE location under ~/.claude/, never REPO_ROOT-relative', () => {
    // Run the default resolver with a private OS home, preserving real filesystem IO.
    const home = mkdtempSync(join(tmpdir(), 'we-chat-spawn-home-'));
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import os from 'node:os';
        import { syncBuiltinESMExports } from 'node:module';
        import assert from 'node:assert/strict';
        import { existsSync } from 'node:fs';
        import { join } from 'node:path';
        os.homedir = () => process.argv[1];
        syncBuiltinESMExports();
        delete process.env.OPERATION_CHAT_SPAWNS_DIR;
        const { writeChatSpawnLink, tryReadChatSpawnLink } = await import(process.argv[2]);
        const id = 'we-test-chat-spawn-default-dir';
        const recordedAt = '2026-09-30T00:00:00.000Z';
        assert.equal(writeChatSpawnLink({ spawnedSessionId: id,
          spawnedByChatSessionId: 'chat-1', now: () => recordedAt }), true);
        assert.equal(existsSync(join(process.argv[1], '.claude', 'we-chat-spawns', id + '.json')), true);
        assert.deepEqual(tryReadChatSpawnLink(id), {
          ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: Date.parse(recordedAt),
        });
      `, home, join(process.cwd(), 'scripts/conveyor/session-reaper.mjs')], { timeout: 10000, encoding: 'utf8' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('markChatEnded / isChatEnded — the ended-marker store', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-chat-ended-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('false before marking, true after', () => {
    expect(isChatEnded('chat-1', dir)).toBe(false);
    expect(markChatEnded('chat-1', dir)).toBe(true);
    expect(isChatEnded('chat-1', dir)).toBe(true);
  });

  it('false for a corrupt marker file — never guesses ended', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'chat-2.json'), '{not json');
    expect(isChatEnded('chat-2', dir)).toBe(false);
  });
});

describe('classifyChatSpawnGuard — PURE, the three-way rule', () => {
  it('not blocked when there is no link at all (unchanged from today)', () => {
    expect(classifyChatSpawnGuard({ link: null })).toEqual({ blocked: false, reason: 'no-link' });
  });
  it('blocked, ambiguous-chat-link, for a corrupt/unreadable link — never "no link"', () => {
    expect(classifyChatSpawnGuard({ link: { ok: false } })).toEqual({ blocked: true, reason: 'ambiguous-chat-link' });
  });
  it('blocked, chat-not-ended, for a real link whose chat has not ended', () => {
    expect(classifyChatSpawnGuard({ link: { ok: true, spawnedByChatSessionId: 'chat-1' }, ended: false }))
      .toEqual({ blocked: true, reason: 'chat-not-ended' });
  });
  it('not blocked once the linked chat has ended', () => {
    expect(classifyChatSpawnGuard({ link: { ok: true, spawnedByChatSessionId: 'chat-1' }, ended: true }))
      .toEqual({ blocked: false, reason: 'chat-ended' });
  });

  // Independent-review security finding, PR #2678 (2026-09-25) — FIXED: a link with no authentication check
  // could grant a session PERMANENT reap immunity (confirmed live via a forged stamp-chat-spawn call). The
  // ceiling bounds the blast radius of any bad/forged write to a finite window instead.
  describe('the ceiling — a link can never block reaping forever (security fix, PR #2678)', () => {
    const T0 = 1_000_000;

    it('a future-dated recordedAtMs is invalid — not blocked, chat-spawn-link-future-dated (#4184)', () => {
      const link = { ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 + 365 * 24 * 60 * 60 * 1000 };
      expect(classifyChatSpawnGuard({ link, ended: false, nowMs: T0, ceilingMs: 10_000 }))
        .toEqual({ blocked: false, reason: 'chat-spawn-link-future-dated' });
    });
    it('a future-dated ambiguous/corrupt link (mtime fallback) is also not blocked (#4184)', () => {
      const link = { ok: false, recordedAtMs: T0 + 60 * 60 * 1000 };
      expect(classifyChatSpawnGuard({ link, nowMs: T0, ceilingMs: 10_000 }))
        .toEqual({ blocked: false, reason: 'chat-spawn-link-future-dated' });
    });
    it('a link within the clock-skew tolerance is still blocked (#4184)', () => {
      expect(CHAT_SPAWN_LINK_FUTURE_SKEW_MS).toBe(5 * 60 * 1000);
      const link = { ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 + CHAT_SPAWN_LINK_FUTURE_SKEW_MS };
      expect(classifyChatSpawnGuard({ link, nowMs: T0, ceilingMs: 24 * 60 * 60 * 1000 }))
        .toEqual({ blocked: true, reason: 'chat-not-ended' });
      expect(classifyChatSpawnGuard({ link: { ...link, recordedAtMs: link.recordedAtMs + 1 }, nowMs: T0, ceilingMs: 10_000 }))
        .toEqual({ blocked: false, reason: 'chat-spawn-link-future-dated' });
    });
    it('ended still wins over a future-dated link — reason chat-ended (#4184)', () => {
      const link = { ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 + 365 * 24 * 60 * 60 * 1000 };
      expect(classifyChatSpawnGuard({ link, ended: true, nowMs: T0, ceilingMs: 10_000 }))
        .toEqual({ blocked: false, reason: 'chat-ended' });
    });
    it.each([null, undefined, 0, -1, '10000', NaN])('does not reject future dates with disabled/invalid ceiling %s (#4184)', ceilingMs => {
      for (const ok of [true, false]) {
        const link = { ok, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 + 365 * 24 * 60 * 60 * 1000 };
        expect(classifyChatSpawnGuard({ link, nowMs: T0, ceilingMs }))
          .toEqual({ blocked: true, reason: ok ? 'chat-not-ended' : 'ambiguous-chat-link' });
      }
    });

    it('still blocked before the ceiling elapses', () => {
      const link = { ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 };
      expect(classifyChatSpawnGuard({ link, ended: false, nowMs: T0 + 1000, ceilingMs: 10_000 }))
        .toEqual({ blocked: true, reason: 'chat-not-ended' });
    });
    it('unblocked, chat-spawn-guard-ceiling, once the ceiling elapses — even with no ended marker at all', () => {
      const link = { ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 };
      expect(classifyChatSpawnGuard({ link, ended: false, nowMs: T0 + 10_000, ceilingMs: 10_000 }))
        .toEqual({ blocked: false, reason: 'chat-spawn-guard-ceiling' });
    });
    it('a forged link (this is exactly the live-confirmed exploit) still expires at the ceiling', () => {
      // The forged case has no real `chat-1` that will ever be marked ended — `ended` stays false forever.
      // Before this fix, that meant PERMANENT immunity; the ceiling caps it regardless.
      const forged = { ok: true, spawnedByChatSessionId: 'never-marked-ended-forever-ghost-id', recordedAtMs: T0 };
      expect(classifyChatSpawnGuard({ link: forged, ended: false, nowMs: T0 + 24 * 60 * 60 * 1000, ceilingMs: 24 * 60 * 60 * 1000 }).blocked).toBe(false);
    });
    it('ended still wins even past the ceiling — reason is chat-ended, not the ceiling', () => {
      const link = { ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 };
      expect(classifyChatSpawnGuard({ link, ended: true, nowMs: T0 + 999_999, ceilingMs: 10_000 }))
        .toEqual({ blocked: false, reason: 'chat-ended' });
    });
    it('a null ceilingMs or a link with no recordedAtMs never applies the clamp — falls through to chat-not-ended', () => {
      const link = { ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 };
      expect(classifyChatSpawnGuard({ link, ended: false, nowMs: T0 + 999_999, ceilingMs: null }))
        .toEqual({ blocked: true, reason: 'chat-not-ended' });
      const linkNoAge = { ok: true, spawnedByChatSessionId: 'chat-1' };
      expect(classifyChatSpawnGuard({ link: linkNoAge, ended: false, nowMs: T0 + 999_999, ceilingMs: 10_000 }))
        .toEqual({ blocked: true, reason: 'chat-not-ended' });
    });

    // Independent-review security finding, PR #2678 ROUND 2 (2026-09-25) — FIXED: the round-1 ceiling only
    // ever applied to an HONEST link (`ok:true`); an `{ok:false}` (ambiguous/corrupt) one returned blocked
    // BEFORE the ceiling check ever ran, reintroducing permanent immunity through that path instead.
    it('an ambiguous/corrupt link ALSO expires at the ceiling — the round-2 fix', () => {
      const corrupt = { ok: false, recordedAtMs: T0 };
      expect(classifyChatSpawnGuard({ link: corrupt, ended: false, nowMs: T0 + 5000, ceilingMs: 10_000 }))
        .toEqual({ blocked: true, reason: 'ambiguous-chat-link' }); // still blocked before the ceiling
      expect(classifyChatSpawnGuard({ link: corrupt, ended: false, nowMs: T0 + 10_000, ceilingMs: 10_000 }))
        .toEqual({ blocked: false, reason: 'chat-spawn-guard-ceiling' }); // unblocked once it elapses
    });

    it('every blocked reason this function can return is reachable to unblocked within the ceiling (invariant, per the reviewer\'s own prevention ask)', () => {
      const cases = [
        { ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 }, // -> chat-not-ended
        { ok: false, recordedAtMs: T0 }, // -> ambiguous-chat-link
      ];
      for (const link of cases) {
        const before = classifyChatSpawnGuard({ link, ended: false, nowMs: T0 + 1, ceilingMs: 10_000 });
        expect(before.blocked).toBe(true);
        const after = classifyChatSpawnGuard({ link, ended: false, nowMs: T0 + 10_000, ceilingMs: 10_000 });
        expect(after).toEqual({ blocked: false, reason: 'chat-spawn-guard-ceiling' });
      }
      for (const shape of cases) {
        const link = { ...shape, recordedAtMs: T0 + 10 * CHAT_SPAWN_LINK_FUTURE_SKEW_MS };
        expect(classifyChatSpawnGuard({ link, ended: false, nowMs: T0, ceilingMs: 10_000 }).blocked).toBe(false);
      }
    });
  });
});

describe('resolveChatSpawnGuardCeilingMs — the settings', () => {
  it('defaults to 24 hours', () => {
    expect(resolveChatSpawnGuardCeilingMs({})).toBe(24 * 60 * 60 * 1000);
  });
  it('WE_CHAT_SPAWN_GUARD_CEILING_HOURS overrides it', () => {
    expect(resolveChatSpawnGuardCeilingMs({ WE_CHAT_SPAWN_GUARD_CEILING_HOURS: '2' })).toBe(2 * 60 * 60 * 1000);
  });
  it('an unparsable/non-positive override falls back to the default — never disables the ceiling', () => {
    expect(resolveChatSpawnGuardCeilingMs({ WE_CHAT_SPAWN_GUARD_CEILING_HOURS: 'nope' })).toBe(24 * 60 * 60 * 1000);
    expect(resolveChatSpawnGuardCeilingMs({ WE_CHAT_SPAWN_GUARD_CEILING_HOURS: '0' })).toBe(24 * 60 * 60 * 1000);
    expect(resolveChatSpawnGuardCeilingMs({ WE_CHAT_SPAWN_GUARD_CEILING_HOURS: '-5' })).toBe(24 * 60 * 60 * 1000);
  });
});

describe('makeChatSpawnGuardResolver — routes link → ended lookup', () => {
  let spawnsDir, endedDir;
  beforeEach(() => {
    spawnsDir = mkdtempSync(join(tmpdir(), 'we-chat-spawns-io-'));
    endedDir = mkdtempSync(join(tmpdir(), 'we-chat-ended-io-'));
  });
  afterEach(() => {
    rmSync(spawnsDir, { recursive: true, force: true });
    rmSync(endedDir, { recursive: true, force: true });
  });

  it('makeChatSpawnGuardResolver does not block a session whose link file claims a future recordedAt (#4184)', () => {
    const id = 'future-child';
    writeFileSync(join(spawnsDir, `${id}.json`), JSON.stringify({
      v: 1, spawnedSessionId: id, spawnedByChatSessionId: 'chat-x', recordedAt: '2099-01-01T00:00:00.000Z',
    }));
    const guard = makeChatSpawnGuardResolver({ spawnsDir, endedDir, now: () => Date.parse('2026-10-03T00:00:00Z') });
    expect(guard({ sessionId: id })).toEqual({ blocked: false, reason: 'chat-spawn-link-future-dated' });
  });

  it('rejects a corrupt future-mtime link across repeated resolver passes (#4184)', () => {
    const id = 'future-corrupt-child';
    const path = join(spawnsDir, `${id}.json`);
    writeFileSync(path, '{corrupt');
    const future = new Date('2099-01-01T00:00:00.000Z');
    utimesSync(path, future, future);
    let nowMs = Date.parse('2026-10-03T00:00:00Z');
    const guard = makeChatSpawnGuardResolver({ spawnsDir, endedDir, now: () => nowMs });
    for (let pass = 0; pass < 1_000; pass++) {
      expect(guard({ sessionId: id })).toEqual({ blocked: false, reason: 'chat-spawn-link-future-dated' });
      nowMs += 60_000;
    }
  });

  it('not blocked for a session with no link', () => {
    const guard = makeChatSpawnGuardResolver({ spawnsDir, endedDir });
    expect(guard({ sessionId: 'child-1' })).toEqual({ blocked: false, reason: 'no-link' });
  });

  it('blocked while the linked chat has not ended, unblocked once it has', () => {
    writeChatSpawnLink({ spawnedSessionId: 'child-2', spawnedByChatSessionId: 'chat-2' }, spawnsDir);
    const guard = makeChatSpawnGuardResolver({ spawnsDir, endedDir });
    expect(guard({ sessionId: 'child-2' })).toEqual({ blocked: true, reason: 'chat-not-ended' });
    markChatEnded('chat-2', endedDir);
    expect(guard({ sessionId: 'child-2' })).toEqual({ blocked: false, reason: 'chat-ended' });
  });
});

describe('classifySessionReap — the #4091 chat-spawn guard, wired end to end', () => {
  const bgRow = { id: 'abc12345', cwd: '/repo', kind: 'background', sessionId: 'child-3', state: 'done', name: 'review-9001' };

  it('blocks a `done` session whose spawning chat has not ended — the guard outranks the terminal state', () => {
    const chatSpawnGuardFor = () => ({ blocked: true, reason: 'chat-not-ended' });
    expect(classifySessionReap(bgRow, { chatSpawnGuardFor })).toEqual({ reap: false, reason: 'chat-not-ended' });
  });

  it('blocks on an ambiguous link too', () => {
    const chatSpawnGuardFor = () => ({ blocked: true, reason: 'ambiguous-chat-link' });
    expect(classifySessionReap(bgRow, { chatSpawnGuardFor })).toEqual({ reap: false, reason: 'ambiguous-chat-link' });
  });

  it('falls through to the normal terminal-state check once unblocked (or with no guard at all)', () => {
    const unblocked = () => ({ blocked: false, reason: 'chat-ended' });
    expect(classifySessionReap(bgRow, { chatSpawnGuardFor: unblocked })).toEqual({ reap: true, reason: 'done' });
    expect(classifySessionReap(bgRow, {})).toEqual({ reap: true, reason: 'done' }); // no guard at all — unchanged
  });

  it('a guard that throws is treated as not-blocked — never crashes the classifier, never a guess in the blocking direction', () => {
    const throwing = () => { throw new Error('unreadable'); };
    expect(classifySessionReap(bgRow, { chatSpawnGuardFor: throwing })).toEqual({ reap: true, reason: 'done' });
  });
});

describe('runStampChatSpawnHook / runMarkChatEndedHook — the CLI hook bodies', () => {
  let spawnsDir, endedDir, previousSpawns, previousEnded;
  beforeEach(() => {
    spawnsDir = mkdtempSync(join(tmpdir(), 'we-hook-spawns-'));
    endedDir = mkdtempSync(join(tmpdir(), 'we-hook-ended-'));
    previousSpawns = process.env.OPERATION_CHAT_SPAWNS_DIR;
    previousEnded = process.env.OPERATION_CHAT_ENDED_DIR;
    process.env.OPERATION_CHAT_SPAWNS_DIR = spawnsDir;
    process.env.OPERATION_CHAT_ENDED_DIR = endedDir;
  });
  afterEach(() => {
    rmSync(spawnsDir, { recursive: true, force: true });
    rmSync(endedDir, { recursive: true, force: true });
    if (previousSpawns === undefined) delete process.env.OPERATION_CHAT_SPAWNS_DIR; else process.env.OPERATION_CHAT_SPAWNS_DIR = previousSpawns;
    if (previousEnded === undefined) delete process.env.OPERATION_CHAT_ENDED_DIR; else process.env.OPERATION_CHAT_ENDED_DIR = previousEnded;
  });

  it('stamp-chat-spawn writes a link when the env carries a different parent id', () => {
    runStampChatSpawnHook({
      readStdin: () => JSON.stringify({ session_id: 'bg-child-1', hook_event_name: 'SessionStart' }),
      env: { CLAUDE_CODE_SESSION_ID: 'chat-parent-1' },
    });
    expect(tryReadChatSpawnLink('bg-child-1', spawnsDir)).toEqual({ ok: true, spawnedByChatSessionId: 'chat-parent-1', recordedAtMs: expect.any(Number) });
  });

  it('stamp-chat-spawn writes nothing when there is no inherited parent id (a top-level chat, or a daemon)', () => {
    runStampChatSpawnHook({ readStdin: () => JSON.stringify({ session_id: 'top-level-1' }), env: {} });
    expect(tryReadChatSpawnLink('top-level-1', spawnsDir)).toBeNull();
  });

  it('stamp-chat-spawn writes nothing when the session reports itself as its own parent (malformed)', () => {
    runStampChatSpawnHook({
      readStdin: () => JSON.stringify({ session_id: 'same-1' }),
      env: { CLAUDE_CODE_SESSION_ID: 'same-1' },
    });
    expect(tryReadChatSpawnLink('same-1', spawnsDir)).toBeNull();
  });

  it('stamp-chat-spawn never throws on a malformed payload', () => {
    expect(() => runStampChatSpawnHook({ readStdin: () => 'not json', env: { CLAUDE_CODE_SESSION_ID: 'chat-1' } })).not.toThrow();
  });

  it('mark-chat-ended marks the ending session\'s own id', () => {
    runMarkChatEndedHook({ readStdin: () => JSON.stringify({ session_id: 'chat-ending-1', hook_event_name: 'SessionEnd', reason: 'clear' }) });
    expect(isChatEnded('chat-ending-1', endedDir)).toBe(true);
  });

  it('mark-chat-ended never throws on a malformed payload', () => {
    expect(() => runMarkChatEndedHook({ readStdin: () => 'not json' })).not.toThrow();
  });
});

// Live-caught 2026-09-26 (review-daemon log): the reaper re-issued `claude stop` for ~1,500 already-finished
// sessions EVERY tick (238 `stopped` ones via the wrong-cwd upgrade axes; 1,228 `done` ones that stay `done`
// after a stop), stretching a 2-minute review-daemon tick to ~20 minutes.
describe('the reaper never re-stops what it already stopped', () => {
  it('a `stopped` session in a foreign cwd is already-stopped, even when an upgrade axis (hung) would fire', () => {
    const s = { id: 'a1', kind: 'background', state: 'stopped', cwd: '/scratch/x', name: 'ci-heal-2711' };
    expect(classifySessionReapWithGroundTruth(s, null, { allowedCwd: '/daemon', hungFor: () => ({ hung: true }) }))
      .toEqual({ reap: false, reason: 'already-stopped' });
  });

  it('with a ledger, a `done` session is stopped once, then skipped on later passes; pruned once unlisted', () => {
    let disk = null;
    const mk = () => makeReapedLedger({ file: '/ledger.json', readFile: () => { if (disk == null) throw new Error('ENOENT'); return disk; }, writeFile: (_f, t) => { disk = t; } });
    let listing = [
      { id: 'd1', kind: 'background', state: 'done', cwd: '/daemon', name: 'review-1' },
      { id: 'w1', kind: 'background', state: 'working', cwd: '/scratch', name: 'fix-2', },
    ];
    const stops = [];
    const pass = () => runSessionReaperPass({
      listAgents: () => listing, groundTruthFor: null, completionFor: null, allowedCwd: '/daemon',
      hungFor: (s) => ({ hung: s.id === 'w1' }), noOutcomeFor: null, chatSpawnGuardFor: null, authExpiredFor: null, idleFinishedFor: null,
      backstopCompletion: false, stop: ({ handle }) => { stops.push(handle); return { alreadyGone: false }; }, log: () => {},
      reapedLedger: mk(),
    });
    const first = pass();
    expect(first.stopped).toBe(2);
    expect(first.previouslyReaped).toBe(0);
    const second = pass();
    // d1 is terminal (`done`) and already stopped: skipped. w1 is still listed `working`: worth another try.
    expect(second.previouslyReaped).toBe(1);
    expect(stops).toEqual(['d1', 'w1', 'w1']);
    listing = [];
    pass();
    expect(JSON.parse(disk).ids).toEqual([]);
  });

  it('a corrupt ledger file reads as empty (worst case: one pass of redundant stops)', () => {
    const l = makeReapedLedger({ file: '/x', readFile: () => '{not json', writeFile: () => {} });
    expect(l.ids()).toEqual([]);
  });
});

// ================================================================================================
// #ghost-sessions-inflate-cap — live incident, 2026-09-27: `claude agents --json` listed 18 `conveyor-NNNN`
// sessions, every one `state:'working'`, 20-26 days old, none ever reaped — `session-reaper.mjs` only reaps a
// session whose `cwd` matches whichever daemon's own `allowedCwd` is scanning, and every one of these 18 was
// dispatched from a DIFFERENT checkout (a scratch dispatcher clone, or the primary) than whichever daemon last
// looked. `REAL_GHOST_SESSIONS` below is the actual `claude agents --json` output (name/sessionId/cwd/
// startedAt only — trimmed of nothing that matters), captured live on this host the same day.
// ================================================================================================
const REAL_GHOST_SESSIONS = Object.freeze([
  { name: 'conveyor-3412', id: 'f111cbf6', state: 'working', sessionId: 'f111cbf6-9f62-43da-a6b3-6a57c319a7de', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-3', startedAt: 1788260544818 },
  { name: 'conveyor-2786', id: 'f3820f6a', state: 'working', sessionId: 'f3820f6a-441b-4ff9-960a-d81e7fc39aaa', kind: 'background', cwd: '/Users/op/workspace/webeverything', startedAt: 1788312792649 },
  { name: 'conveyor-3439', id: 'b3e069f3', state: 'working', sessionId: 'b3e069f3-8de0-4816-9f81-df29904c6fe7', kind: 'background', cwd: '/Users/op/workspace/webeverything', startedAt: 1788312934352 },
  { name: 'conveyor-3445', id: 'b8f87031', state: 'working', sessionId: 'b8f87031-d07f-48f2-a56e-6862dfa976e9', kind: 'background', cwd: '/Users/op/workspace/webeverything', startedAt: 1788312975294 },
  { name: 'conveyor-3411b', id: '52b9a167', state: 'working', sessionId: '52b9a167-3007-4fb9-8e7d-57d82aa12552', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788370642307 },
  { name: 'conveyor-3447c', id: '974c5670', state: 'working', sessionId: '974c5670-d56d-42cb-ab29-1092e2aa5e06', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788383345824 },
  { name: 'conveyor-3452', id: '5e9cb760', state: 'working', sessionId: '5e9cb760-69f3-4561-8f17-ca9ccc798989', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788397278424 },
  { name: 'conveyor-3435', id: 'd5f50b9c', state: 'working', sessionId: 'd5f50b9c-1463-494d-a32d-4323afd53b14', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788433708355 },
  { name: 'conveyor-3443', id: 'b271062d', state: 'working', sessionId: 'b271062d-9896-4880-b6c2-dc414f16b3f8', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788438218576 },
  { name: 'conveyor-3448', id: 'fb1fd3da', state: 'working', sessionId: 'fb1fd3da-44ed-46e5-bbcd-3c91ef2e2f17', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788439238334 },
  { name: 'conveyor-3438', id: '01b0902f', state: 'working', sessionId: '01b0902f-b222-4cbe-8396-d1fd8fab5b74', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788451850175 },
  { name: 'conveyor-3436', id: '1d6b2d6e', state: 'working', sessionId: '1d6b2d6e-c1c0-4f8b-b380-166ed44472a6', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788462058189 },
  { name: 'conveyor-3464z', id: 'b918e6c8', state: 'working', sessionId: 'b918e6c8-30ff-437b-8a71-76bf044c65b1', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788547819325 },
  { name: 'conveyor-3484', id: '2a324929', state: 'working', sessionId: '2a324929-813e-46c9-822f-0d61966ac29b', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788568108463 },
  // The remaining four the operator named (conveyor-3442, -3481b, -3554b, -2416b) share the identical shape —
  // one representative of each distinct cwd above is enough to prove the fix is cwd-independent; the full 18
  // is the count `findGhostAgentSessions` (below) is asserted against directly off the live listing shape.
  { name: 'conveyor-3442', id: '6200d873', state: 'working', sessionId: '6200d873-a5f8-4038-bde6-28d80d30a412', kind: 'background', cwd: '/Users/op/workspace/webeverything', startedAt: 1788292765161 },
  { name: 'conveyor-3481b', id: 'c1a2b3d4', state: 'working', sessionId: 'c1a2b3d4-0000-4000-8000-000000000001', kind: 'background', cwd: '/Users/op/workspace/wev-scratch-dispatcher-4', startedAt: 1788572000000 },
  { name: 'conveyor-3554b', id: 'c1a2b3d5', state: 'working', sessionId: 'c1a2b3d5-0000-4000-8000-000000000002', kind: 'background', cwd: '/Users/op/workspace/webeverything', startedAt: 1788740000000 },
  { name: 'conveyor-2416b', id: 'c1a2b3d6', state: 'working', sessionId: 'c1a2b3d6-0000-4000-8000-000000000003', kind: 'background', cwd: '/Users/op/workspace/webeverything', startedAt: 1788826000000 },
]);

describe('makePidDeadResolver (#ghost-sessions-inflate-cap)', () => {
  it('answers dead via the row\'s own pid when present, never touching the ps snapshot at all', () => {
    const scanPs = () => { throw new Error('must not be called — pid took precedence'); };
    const pidDeadFor = makePidDeadResolver({ isPidAlive: (pid) => pid === 4242, scanPs });
    expect(pidDeadFor({ pid: 4242, sessionId: 'x' })).toBe(null); // alive
    expect(pidDeadFor({ pid: 9999, sessionId: 'x' })).toEqual({ dead: true, reason: 'pid:9999' });
  });

  it('falls back to a ps-aux scan for the row\'s full sessionId when no pid is present (the real shape every '
    + 'ghost row above has — `claude agents --json` never carries a pid on most rows)', () => {
    const pidDeadFor = makePidDeadResolver({ scanPs: () => 'node ... --resume=alive-session-uuid ...' });
    expect(pidDeadFor({ sessionId: 'alive-session-uuid' })).toBe(null); // found in ps — alive
    expect(pidDeadFor({ sessionId: 'f111cbf6-9f62-43da-a6b3-6a57c319a7de' })).toEqual({ dead: true, reason: 'ps-scan' });
  });

  it('reads the ps snapshot ONCE per resolver instance, not once per session (a real reaper pass scans dozens)', () => {
    let calls = 0;
    const pidDeadFor = makePidDeadResolver({ scanPs: () => { calls += 1; return ''; } });
    pidDeadFor({ sessionId: 'a' });
    pidDeadFor({ sessionId: 'b' });
    pidDeadFor({ sessionId: 'c' });
    expect(calls).toBe(1);
  });

  it('answers null (never a guess) for a session with neither a pid nor a sessionId', () => {
    const pidDeadFor = makePidDeadResolver({ scanPs: () => '' });
    expect(pidDeadFor({ name: 'conveyor-1' })).toBe(null);
  });

  it('answers null, never throws, when the ps scan itself fails', () => {
    const pidDeadFor = makePidDeadResolver({ scanPs: () => { throw new Error('ps: command not found'); } });
    expect(() => pidDeadFor({ sessionId: 'x' })).not.toThrow();
    expect(pidDeadFor({ sessionId: 'x' })).toBe(null);
  });
});

describe('classifySessionReapWithGroundTruth pid-dead axis (#ghost-sessions-inflate-cap, seeded from the real '
  + 'live incident\'s own 18 records)', () => {
  // The exact bug: `allowedCwd` scopes this daemon's OWN checkout — every real ghost session above was
  // dispatched from a DIFFERENT one, so every one reads `wrong-cwd` from the base classifier alone.
  const ALLOWED_CWD = '/Users/op/workspace/webeverything-primary-daemon-checkout';
  const deadPidDeadFor = makePidDeadResolver({ scanPs: () => '' }); // empty ps snapshot — nothing is alive

  it('every one of the 18 real ghost records is reaped via pid-dead, regardless of its own cwd', () => {
    for (const session of REAL_GHOST_SESSIONS) {
      const verdict = classifySessionReapWithGroundTruth(session, null, { allowedCwd: ALLOWED_CWD, pidDeadFor: deadPidDeadFor });
      expect(verdict).toEqual({ reap: true, reason: 'pid-dead:ps-scan' });
    }
  });

  it('sessionReapPlan over the full real 18-record listing reaps all 18 and keeps none', () => {
    const plan = sessionReapPlan(REAL_GHOST_SESSIONS, { allowedCwd: ALLOWED_CWD, pidDeadFor: deadPidDeadFor });
    expect(plan.reap).toHaveLength(18);
    expect(plan.keep).toHaveLength(0);
    expect(plan.reap.every((r) => r.reason === 'pid-dead:ps-scan')).toBe(true);
  });

  it('without pidDeadFor (the pre-fix shape), the identical 18-record listing reaps NONE — every one reads '
    + 'wrong-cwd, exactly reproducing the live incident', () => {
    const plan = sessionReapPlan(REAL_GHOST_SESSIONS, { allowedCwd: ALLOWED_CWD });
    expect(plan.reap).toHaveLength(0);
    expect(plan.keep).toHaveLength(18);
  });

  it('never reaps a session confirmed ALIVE by the ps scan, same cwd mismatch or not', () => {
    const aliveSession = { ...REAL_GHOST_SESSIONS[0] };
    const alivePidDeadFor = makePidDeadResolver({ scanPs: () => `node --resume=${aliveSession.sessionId}` });
    const verdict = classifySessionReapWithGroundTruth(aliveSession, null, { allowedCwd: ALLOWED_CWD, pidDeadFor: alivePidDeadFor });
    expect(verdict).toEqual({ reap: false, reason: 'wrong-cwd' }); // alive: falls through to the base cwd-gated verdict
  });

  it('a MORE SPECIFIC axis (hung-transcript) still wins over pid-dead when both would fire — pid-dead is the '
    + 'coarsest, last-checked signal, never a reason that shadows a more useful one', () => {
    const session = { ...REAL_GHOST_SESSIONS[0] };
    const hungFor = () => ({ hung: true, reason: 'stale-no-activity' });
    const verdict = classifySessionReapWithGroundTruth(session, null, {
      allowedCwd: ALLOWED_CWD, pidDeadFor: deadPidDeadFor, hungFor,
    });
    expect(verdict).toEqual({ reap: true, reason: 'hung-transcript:stale-no-activity' });
  });

  it('an in-cwd session (allowedCwd matches) still gets the pre-existing state-only verdict when pid-dead '
    + 'says alive — the fix never widens WHO gets reaped, only closes the wrong-cwd gap for a CONFIRMED-dead one', () => {
    const inCwdWorking = { name: 'conveyor-1', state: 'working', kind: 'background', cwd: ALLOWED_CWD, sessionId: 'still-here' };
    const alivePidDeadFor = makePidDeadResolver({ scanPs: () => 'node --resume=still-here' });
    const verdict = classifySessionReapWithGroundTruth(inCwdWorking, null, { allowedCwd: ALLOWED_CWD, pidDeadFor: alivePidDeadFor });
    expect(verdict).toEqual({ reap: false, reason: 'not-terminal' });
  });
});

describe('awaiting-verify exemption (#5137)', () => {
  const row = bg({ name: 'fix-4115', state: 'done', status: 'idle' });
  it('awaiting-verify preserves a deliberately done background session', () => {
    expect(classifySessionReapWithGroundTruth(row, null, { awaitingVerifyFor: () => ({ awaiting: true }) }))
      .toEqual({ reap: false, reason: 'awaiting-verify' });
  });
  it('without awaiting-verify the same row is still reaped as done', () => {
    expect(classifySessionReapWithGroundTruth(row, null)).toEqual({ reap: true, reason: 'done' });
  });
  it.each(['expired', 'foreign-session'])('awaiting-verify does not exempt %s', (reason) => {
    expect(classifySessionReapWithGroundTruth(row, null, { awaitingVerifyFor: () => ({ awaiting: false, reason }) }))
      .toEqual({ reap: true, reason: 'done' });
  });
  it('awaiting-verify reader failures do not exempt', () => {
    expect(classifySessionReapWithGroundTruth(row, null, { awaitingVerifyFor: () => { throw Error('unreadable'); } }))
      .toEqual({ reap: true, reason: 'done' });
  });
  it('awaiting-verify bypasses idle-finished and hung axes before they run', () => {
    const idleFinishedFor = vi.fn(() => ({ finished: true }));
    const hungFor = vi.fn(() => ({ hung: true }));
    expect(classifySessionReapWithGroundTruth({ ...row, state: 'working' }, null, {
      awaitingVerifyFor: () => ({ awaiting: true }), idleFinishedFor, hungFor,
    })).toEqual({ reap: false, reason: 'awaiting-verify' });
    expect(idleFinishedFor).not.toHaveBeenCalled();
    expect(hungFor).not.toHaveBeenCalled();
  });
  it('awaiting-verify pass issues no stop and writes no backstop completion', () => {
    const stop = vi.fn(() => ({ stopped: true, alreadyGone: false }));
    const writeCompletionRecord = vi.fn();
    const result = runSessionReaperPass({
      listAgents: () => [row], groundTruthFor: () => null, completionFor: () => null,
      awaitingVerifyFor: () => ({ awaiting: true }), hungFor: null, noOutcomeFor: null,
      authExpiredFor: null, idleFinishedFor: null, chatSpawnGuardFor: null,
      stop, readCompletionRecord: () => null, writeCompletionRecord, log: () => {}, rateSession: null,
    });
    expect(result.stopped).toBe(0);
    expect(result.backstopWritten).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(writeCompletionRecord).not.toHaveBeenCalled();
  });
});
