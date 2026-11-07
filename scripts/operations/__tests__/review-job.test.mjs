import * as reviewDispatch from '../review-dispatch.mjs';
import { runReviewTick } from '../../../skills-src/conveyor/review-daemon.mjs';
import { readReviewCiGate } from '../../lib/review-ci-gate-io.mjs';
/**
 * x26lw6u — the review arc as a deterministic job (we:scripts/operations/review-job.mjs) and its job-record
 * store (we:scripts/operations/review-job-store.mjs). Every effect is faked: no lane pool, no `claude`, no `gh`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOCKED_ON_INFRA, DEFERRED_NO_LANE, MAX_LANE_DEFERRALS, REVIEW_JOB_KIND, REVIEW_JOB_LANE_WAIT_MS,
  classifyReviewLoopOutcome, crashLabelFromLoop, loopFailureLabel, decideJobClaim, dispatchReviewByMode, dispatchReviewJob,
  jobRecordToAgentRow, laneCooloffActive, listAgentsWithReviewJobs, listReviewJobAgents, nextLaneDeferral,
  parseReviewLoopStdout, readJobRecord, resolveReviewDispatchMode, runReviewJob, writeJobRecord,
} from '../review-job.mjs';
import { assessLiveness, bindAgents } from '../../conveyor/reconcile-core.mjs';
import { deriveReviewStatus, tagReviewStatus } from '../../conveyor/review-status-tag.mjs';
import { defaultReadAgents } from '../../conveyor/reconcile-pass.mjs';
import { repoProfile } from '../../lib/repo-profile.mjs';

const REPO = 'web-everything/web-everything';
// Landing-freeze fix (lane-leftover-reclaim) — `we`'s lane-pool `--repo=` value is now ALWAYS an absolute path
// (see `repo-profile.mjs`'s own docblock: the literal `.` broke for a dispatched session, whose cwd is a
// scratch directory outside the checkout, not the checkout itself).
const WE_LANE_REPO = repoProfile('we').lanePoolRepo;
const FRESH = () => ({ fresh: true, behind: 0 });

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'review-jobs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('classifyReviewLoopOutcome — the brief\'s outcome words, read off review-loop-cli --json', () => {
  it('maps each stop to bounced / auto-cleared / parked, and anything unrecognised to blocked-on-infra', () => {
    const loop = { outcome: 'converged' };
    expect(classifyReviewLoopOutcome({ runId: 'r1', stopped: 'complete', verdict: { verdict: 'accept', loop } }))
      .toEqual({ outcome: 'auto-cleared', verdict: 'accept', loopOutcome: 'converged', runId: 'r1' });
    expect(classifyReviewLoopOutcome({ stopped: 'complete', verdict: { verdict: 'changes' } }).outcome).toBe('bounced');
    expect(classifyReviewLoopOutcome({ stopped: 'effect-in-flight', verdict: { verdict: 'changes' } }).outcome).toBe('bounced');
    expect(classifyReviewLoopOutcome({ stopped: 'confirm', verdict: { verdict: 'accept' } }).outcome).toBe('parked');
    expect(classifyReviewLoopOutcome({ queued: 'accept-needs-human', stopped: 'confirm' }).outcome).toBe('parked');
    expect(classifyReviewLoopOutcome({ preventionFiled: [], stopped: 'complete' }).outcome).toBe('auto-cleared');
    expect(classifyReviewLoopOutcome({ stopped: 'refused' }).outcome).toBe(BLOCKED_ON_INFRA);
    expect(classifyReviewLoopOutcome(null).outcome).toBe(BLOCKED_ON_INFRA);
  });
});

describe('parseReviewLoopStdout', () => {
  it('parses the pretty-printed payload, and survives a stray leading line (#3647)', () => {
    const payload = { runId: 'r9', stopped: 'complete' };
    expect(parseReviewLoopStdout(JSON.stringify(payload, null, 2))).toEqual(payload);
    expect(parseReviewLoopStdout(`notice: something\n${JSON.stringify(payload, null, 2)}\n`)).toEqual(payload);
    expect(parseReviewLoopStdout('error: boom')).toBeNull();
    expect(parseReviewLoopStdout('')).toBeNull();
  });
});

describe('crashLabelFromLoop — card x5s8b47\'s second defect: the real crash message was losable to stderr noise', () => {
  it('prefers stdout\'s own deliberate `error: ` line over ANY stderr content, noise or not', () => {
    // FAILS BEFORE THE FIX: the old `loop.stderr || loop.stdout` picked stderr whenever it was non-empty,
    // discarding the real message `review-loop-cli.mjs`'s own catch handler deliberately wrote to stdout.
    expect(crashLabelFromLoop({
      stdout: 'error: judgeAdvisory spawn failed — codex quota exhausted',
      stderr: '(node:12345) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n(Use `node --trace-deprecation ...` to show where the warning was created)',
    })).toBe('error: judgeAdvisory spawn failed — codex quota exhausted');
  });

  it('finds the `error: ` line anywhere in multi-line stdout; the LAST such line wins; mid-line text is not matched (#4446)', () => {
    const noise = '(node) [DEP0040] DeprecationWarning: punycode';
    expect(crashLabelFromLoop({ stdout: 'progress line\nmore\nerror: boom', stderr: noise })).toBe('error: boom');
    expect(crashLabelFromLoop({ stdout: 'error: echoed sub-error\nprogress\nerror: real crash\n', stderr: noise })).toBe('error: real crash');
    expect(crashLabelFromLoop({ stdout: 'stderr said error: x', stderr: noise })).toBe(noise);
  });

  it('falls back to stderr, then stdout, when stdout carries no deliberate `error: ` line — unchanged from before', () => {
    expect(crashLabelFromLoop({ stdout: '', stderr: 'a real stderr crash' })).toBe('a real stderr crash');
    expect(crashLabelFromLoop({ stdout: 'some other stdout, no error prefix', stderr: '' })).toBe('some other stdout, no error prefix');
    expect(crashLabelFromLoop({})).toBe('');
  });
});

describe('lane deferral — next tick retries, bounded', () => {
  it('counts consecutive deferrals and escalates to blocked-on-infra at the cap', () => {
    expect(nextLaneDeferral(null)).toEqual({ count: 1, outcome: DEFERRED_NO_LANE, label: 'lane-deferrals:1' });
    let prev = null;
    for (let i = 1; i < MAX_LANE_DEFERRALS; i += 1) prev = { ...nextLaneDeferral(prev), status: 'done' };
    expect(prev.outcome).toBe(DEFERRED_NO_LANE);
    expect(nextLaneDeferral(prev)).toEqual({ count: MAX_LANE_DEFERRALS, outcome: BLOCKED_ON_INFRA, label: `lane-deferrals:${MAX_LANE_DEFERRALS}` });
    // A real review in between resets the count.
    expect(nextLaneDeferral({ outcome: 'bounced', label: null }).count).toBe(1);
  });

  it('cools off only after an escalated lane exhaustion, and only for the cool-off window', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    const rec = { status: 'done', outcome: BLOCKED_ON_INFRA, label: 'lane-deferrals:5', updatedAt: '2026-09-25T11:55:00Z' };
    expect(laneCooloffActive(rec, now)).toBe(true);
    expect(laneCooloffActive({ ...rec, updatedAt: '2026-09-25T11:30:00Z' }, now)).toBe(false);
    expect(laneCooloffActive({ ...rec, label: 'review-loop exit 1' }, now)).toBe(false); // a loop failure is not a lane cool-off
    expect(laneCooloffActive({ ...rec, outcome: DEFERRED_NO_LANE }, now)).toBe(false);
  });
});

describe('job records — liveness by pid, without a transcript', () => {
  it('decideJobClaim: free when absent / ours / dead, held when another live pid owns it', () => {
    const alive = (p) => p === 11;
    expect(decideJobClaim(null, 5, alive)).toEqual({ ok: true });
    expect(decideJobClaim({ pid: 5 }, 5, alive)).toEqual({ ok: true });
    expect(decideJobClaim({ pid: 12 }, 5, alive)).toEqual({ ok: true });
    expect(decideJobClaim({ pid: 11 }, 5, alive)).toEqual({ ok: false, heldBy: 11 });
  });

  it('lists live jobs as agent rows and prunes a dead job\'s record', () => {
    writeJobRecord({ slug: 'review-10', pr: 10, repo: REPO, pid: 111, startedAt: '2026-09-25T10:00:00Z', cwd: '/lane' }, dir);
    writeJobRecord({ slug: 'review-20', pr: 20, repo: REPO, pid: 222, startedAt: '2026-09-25T10:00:00Z', cwd: '/lane' }, dir);
    const rows = listReviewJobAgents({ dir, isAlive: (p) => p === 111 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'review-10', state: 'working', pid: 111, kind: REVIEW_JOB_KIND, sessionId: null });
    expect(readJobRecord('review-20', dir)).toBeNull(); // pruned
    expect(listReviewJobAgents({ dir: join(dir, 'nope') })).toEqual([]);
  });

  it('a live job row binds to its PR and reads live-process in reconcile, and reviewing in review-status-tag', () => {
    const row = { ...jobRecordToAgentRow({ slug: 'review-10', pr: 10, repo: REPO, pid: 111, startedAt: '2026-09-25T10:00:00Z', cwd: '/lane' }), pidAlive: true };
    const pr = { number: 10, headRefOid: 'abc' };
    const bound = bindAgents(pr, [row], 'we');
    expect(bound).toHaveLength(1);
    expect(assessLiveness(bound)).toMatchObject({ kind: 'live-process', pid: 111 });
    expect(deriveReviewStatus({ pr: 10, agents: [row], repo: 'we' })).toEqual({ role: 'review', state: 'reviewing' });
    // A dead job is not live — the PR is free to be reconciled again.
    expect(assessLiveness(bindAgents(pr, [{ ...row, pidAlive: false }], 'we'))).toBeNull();
  });

  it('listAgentsWithReviewJobs merges the listing with the job rows, and a job-read failure costs nothing', () => {
    const merged = listAgentsWithReviewJobs({ listAgents: () => [{ name: 'fix-3' }], listJobs: () => [{ name: 'review-4' }], listWrapped: () => [] });
    expect(merged.map((a) => a.name)).toEqual(['fix-3', 'review-4']);
    expect(listAgentsWithReviewJobs({ listAgents: () => [{ name: 'x' }], listJobs: () => { throw new Error('io'); }, listWrapped: () => [] })).toEqual([{ name: 'x' }]);
  });
  // PR #4462 review: a wrapped fixer is a live-session population readers decide on by absence, so a failed listing of it
  // aborts the read (like a failed `claude agents`) instead of showing "no fixer".
  it('listAgentsWithReviewJobs does not read a failed wrapped listing as no wrapped workers', () => {
    expect(() => listAgentsWithReviewJobs({ listAgents: () => [], listJobs: () => [], listWrapped: () => { throw new Error('io'); } })).toThrow('io');
  });
  it('listAgentsWithReviewJobs carries the wrapped listing\'s incomplete marker across the merge', () => {
    const gap = { reason: 'wrapped record fix-9 unreadable', session: 'fix-9' };
    const wrapped = Object.defineProperty([{ name: 'fix-3' }], 'incomplete', { value: [gap] });
    const merged = listAgentsWithReviewJobs({ listAgents: () => [{ name: 'x' }], listJobs: () => [], listWrapped: () => wrapped });
    expect(merged.map((a) => a.name)).toEqual(['x', 'fix-3']);
    expect(merged.incomplete).toEqual([gap]);
    expect(listAgentsWithReviewJobs({ listAgents: () => [], listJobs: () => [], listWrapped: () => [] }).incomplete).toBeUndefined();
  });
});

/** A fake io recording every effect in order. */
function fakeIo(over = {}) {
  const calls = [];
  const io = {
    root: '/daemon',
    now: (() => { let t = 1_000; return () => { t += 10; return t; }; })(),
    newActorId: () => 'actor-fresh-uuid',
    readPrevCompletion: () => null,
    report: (flags) => calls.push(['report', flags.status, flags]),
    claim: (slug, rec) => { calls.push(['claim', slug, rec.pid]); return { ok: true }; },
    updateRecord: (rec) => calls.push(['update', rec.cwd, rec.actorId]),
    unclaim: (slug, pid) => calls.push(['unclaim', slug, pid]),
    prepareLane: () => ({ head: 'a'.repeat(40) }),
    acquireLane: (o) => { calls.push(['acquire', o]); return { lanePath: '/lanes/lane-7' }; },
    runLoop: (o) => {
      calls.push(['loop', o]);
      return { status: 0, stdout: JSON.stringify({ runId: 'review-pr-1', stopped: 'complete', verdict: { verdict: 'accept', loop: { outcome: 'converged' } } }), stderr: '' };
    },
    releaseLane: (slug) => calls.push(['release', slug]),
    log: () => {},
    ...over,
  };
  return { io, calls };
}

describe('runReviewJob — the arc, no Claude wrapper session', () => {
  it('claims, reports started, acquires, runs the loop ONCE under a fresh actor id, reports done, releases, unclaims', () => {
    const { io, calls } = fakeIo();
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(out).toMatchObject({ pr: 10, sessionSlug: 'review-10', outcome: 'auto-cleared', verdict: 'accept', loopOutcome: 'converged', runId: 'review-pr-1', lanePath: '/lanes/lane-7' });
    // No release BEFORE acquire: a live session could share the slug (see the arc's step 1 comment).
    expect(calls.map((c) => c[0])).toEqual(['claim', 'report', 'acquire', 'update', 'loop', 'report', 'release', 'unclaim']);
    const acquire = calls.find((c) => c[0] === 'acquire')[1];
    const loop = calls.find((c) => c[0] === 'loop')[1];
    expect(acquire).toMatchObject({ slug: 'review-10', actorId: 'actor-fresh-uuid', laneRepo: WE_LANE_REPO });
    expect(loop).toMatchObject({ pr: 10, repo: REPO, lanePath: '/lanes/lane-7', actorId: 'actor-fresh-uuid' });
    const done = calls.filter((c) => c[0] === 'report')[1][2];
    expect(done).toMatchObject({ session: 'review-10', status: 'done', outcome: 'auto-cleared', verdict: 'converged', runId: 'review-pr-1' });
    expect(out.timings.loopMs).toBeGreaterThan(0);
  });

  it('#3647 — a non-zero exit whose stdout is a finished review reports the review\'s real outcome', () => {
    const { io, calls } = fakeIo({
      runLoop: () => ({ status: 1, stdout: JSON.stringify({ runId: 'r2', stopped: 'complete', verdict: { verdict: 'changes' } }), stderr: 'filing failed' }),
    });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(out.outcome).toBe('bounced');
    expect(calls.filter((c) => c[0] === 'report')[1][2]).toMatchObject({ outcome: 'bounced', runId: 'r2', label: 'exit 1' });
  });

  it('no lane → deferred-no-lane, the loop never runs, done is still reported and the slot freed', () => {
    const { io, calls } = fakeIo({ acquireLane: () => ({ lanePath: null, error: 'pool full' }) });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(out.outcome).toBe(DEFERRED_NO_LANE);
    expect(calls.some((c) => c[0] === 'loop')).toBe(false);
    expect(calls.filter((c) => c[0] === 'report')[1][2]).toMatchObject({ status: 'done', outcome: DEFERRED_NO_LANE, label: 'lane-deferrals:1' });
    expect(calls.at(-1)).toEqual(['unclaim', 'review-10', 99]);
    expect(calls.some((c) => c[0] === 'release')).toBe(false); // no lane was taken, so none is released by slug
  });

  it('the fifth consecutive no-lane escalates to blocked-on-infra', () => {
    const { io } = fakeIo({
      acquireLane: () => ({ lanePath: null }),
      readPrevCompletion: () => ({ status: 'done', outcome: DEFERRED_NO_LANE, label: `lane-deferrals:${MAX_LANE_DEFERRALS - 1}` }),
    });
    expect(runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io).outcome).toBe(BLOCKED_ON_INFRA);
  });

  it('a live job already holding the PR refuses without reporting or touching a lane', () => {
    const { io, calls } = fakeIo({ claim: () => ({ ok: false, heldBy: 7 }) });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(out).toMatchObject({ refused: true, outcome: 'refused-live-job' });
    expect(calls).toEqual([]);
  });

  it('a timed-out loop is blocked-on-infra, and the lane is still released', () => {
    const { io, calls } = fakeIo({ runLoop: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', timedOut: true }) });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99, loopTimeoutMs: 60_000 }, io);
    expect(out.outcome).toBe(BLOCKED_ON_INFRA);
    expect(out.label).toMatch(/timed out/);
    expect(calls.slice(-2)).toEqual([['release', 'review-10'], ['unclaim', 'review-10', 99]]);
  });

  it('a crash mid-arc still writes done, releases and unclaims', () => {
    const { io, calls } = fakeIo({ runLoop: () => { throw new Error('spawn EAGAIN'); } });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(out.outcome).toBe(BLOCKED_ON_INFRA);
    expect(calls.filter((c) => c[0] === 'report')[1][2]).toMatchObject({ status: 'done', outcome: BLOCKED_ON_INFRA, label: 'spawn EAGAIN' });
    expect(calls.slice(-2)).toEqual([['release', 'review-10'], ['unclaim', 'review-10', 99]]);
  });

  it('card x5s8b47 — a child-process crash with unparseable stdout persists the REAL error, not stderr noise', () => {
    // Reproduces the measured incident: `review-loop-cli.mjs` exits 1 having written its own `error: ` line to
    // STDOUT, while stderr carries only an unrelated Node deprecation warning. FAILS BEFORE THE FIX (the label
    // used to be the deprecation-warning noise); PASSES AFTER (the label is the real error).
    const { io, calls } = fakeIo({
      runLoop: () => ({
        status: 1,
        stdout: 'error: review-pr.reduce: the `simplicity` juror (`judgeAdvisory` step) crashed: spawn codex ENOENT',
        stderr: '(node:12345) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.\n(Use `node --trace-deprecation ...` to show where the warning was created)',
      }),
    });
    const out = runReviewJob({ pr: 10, repo: REPO, pid: 99 }, io);
    expect(out.outcome).toBe(BLOCKED_ON_INFRA);
    expect(out.label).toContain('spawn codex ENOENT');
    expect(out.label).not.toContain('DeprecationWarning');
    expect(calls.filter((c) => c[0] === 'report')[1][2].label).toContain('spawn codex ENOENT');
  });
});

describe('dispatchReviewJob — what the daemon calls', () => {
  const base = { ciGate: () => ({ allowed: true, headSha: 'a'.repeat(40) }), pr: 10, repo: REPO, root: '/daemon', checkStaleness: FRESH, readCompletion: () => null };

  it.each(['matching', 'mismatched', 'missing', 'unreadable', 'head-changed'])('advisory CI waiver: %s', state => {
    let spawns = 0;
    const out = dispatchReviewJob({ ...base, dir, resolveSettingsEnv: () => null, env: { WE_REVIEW_START_AFTER: 'ci-green' },
      advisoryCiWaiver: { head: 'A'.repeat(40), reason: 'human-handoff' },
      ciGate: () => ({ allowed: false, headSha: state === 'missing' ? null : (state === 'mismatched' ? 'b' : 'a').repeat(40),
        reason: state === 'unreadable' ? 'unreadable-ci' : state === 'head-changed' ? 'head-changed' : 'required-checks-not-successful' }),
      spawnJob: () => { spawns++; return 4242; } });
    expect(spawns).toBe(state === 'matching' ? 1 : 0);
    expect(Boolean(out.skipped)).toBe(state !== 'matching');
  });

  it('spawns the job detached with the gh shim on PATH and WITHOUT the dispatcher\'s own actor id, and claims the slot', () => {
    const spawned = [];
    const out = dispatchReviewJob({
      ...base, dir,
      env: { PATH: '/usr/bin', CLAUDE_CODE_SESSION_ID: 'dispatcher-session', GH_TOKEN: 't' },
      resolveSettingsEnv: () => ({ PATH: '/shim:/usr/bin' }),
      spawnJob: (o) => { spawned.push(o); return 4242; },
    });
    expect(out).toMatchObject({ mode: 'job', pr: 10, sessionSlug: 'review-10', agentId: null, jobPid: 4242 });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].argv.slice(1)).toEqual(['run', '--pr=10', `--repo=${REPO}`]);
    expect(spawned[0].env.PATH).toBe('/shim:/usr/bin');
    expect(spawned[0].env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(readJobRecord('review-10', dir)).toMatchObject({ slug: 'review-10', pid: 4242, pr: 10 });
  });

  it('declines to spawn while a live job holds the PR, or during the lane cool-off', () => {
    writeJobRecord({ slug: 'review-10', pid: 555, pr: 10, repo: REPO, startedAt: new Date().toISOString(), cwd: '/x' }, dir);
    const spawnJob = () => { throw new Error('must not spawn'); };
    expect(dispatchReviewJob({ ...base, dir, spawnJob, isAlive: () => true })).toMatchObject({ skipped: 'live-job', jobPid: 555 });
    const now = Date.parse('2026-09-25T12:00:00Z');
    const cooled = { status: 'done', outcome: BLOCKED_ON_INFRA, label: 'lane-deferrals:5', updatedAt: '2026-09-25T11:59:00Z' };
    expect(dispatchReviewJob({ ...base, dir, now, spawnJob, isAlive: () => false, readCompletion: () => cooled })).toMatchObject({ skipped: 'lane-cooloff' });
  });

  it('refuses from a lane checkout and on a stale main, exactly like the session path', () => {
    expect(() => dispatchReviewJob({ ...base, dir, root: '/x/lane-7', spawnJob: () => 1 })).toThrow(/lane checkout/);
    expect(() => dispatchReviewJob({ ...base, dir, checkStaleness: () => ({ action: 'warn', behind: 3 }), spawnJob: () => 1 })).toThrow(/behind origin\/main/);
  });

  it('leaves no stray files beyond the claimed record', () => {
    dispatchReviewJob({ ...base, dir, resolveSettingsEnv: () => null, spawnJob: () => 1 });
    expect(readdirSync(dir).filter((n) => !n.endsWith('.log'))).toEqual(['review-10.json']);
    expect(existsSync(join(dir, 'review-10.json'))).toBe(true);
  });
});

describe('dispatchReviewJob — a managed clone behind origin/main (the default dispatch path)', () => {
  // Live 2026-10-03: the review daemon refused every dispatch ("21 commit(s) behind") because this job path called
  // `assertMainNotStale` without the review code path, so the #4387 narrowing only ever covered `--mode=session`.
  let root;
  let prevEnv;
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), 'x\n' + Math.random());
    git(cwd, 'add', file);
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`);
  };
  function behind(...files) {
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'up');
    const up = join(dir, 'up');
    commit(up, 'a.txt'); git(up, 'push', '-q', 'origin', 'main');
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'clone');
    for (const f of files) commit(up, f);
    git(up, 'push', '-q', 'origin', 'main');
    root = join(dir, 'clone');
    prevEnv = process.env.WE_DAEMON_MANAGED_CLONE; process.env.WE_DAEMON_MANAGED_CLONE = '1';
  }
  afterEach(() => { if (prevEnv === undefined) delete process.env.WE_DAEMON_MANAGED_CLONE; else process.env.WE_DAEMON_MANAGED_CLONE = prevEnv; prevEnv = undefined; });
  const go = () => dispatchReviewJob({
    ciGate: () => ({ allowed: true, headSha: 'a'.repeat(40) }), pr: 10, repo: REPO, root, dir: join(dir, 'jobs'),
    readCompletion: () => null, resolveSettingsEnv: () => null, spawnJob: () => 77,
  });

  it('behind only in code OFF the review path: dispatches and logs the tolerated files', () => {
    behind('scripts/lane-pool.mjs', 'scripts/backlog/capacity.mjs');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(go()).toMatchObject({ jobPid: 77 });
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toMatch(/2 commit\(s\) behind.*scripts\/lane-pool\.mjs.*tolerating the lag/);
    } finally { err.mockRestore(); }
  });

  it('behind in a file the review runs (review-loop-cli, or review-job\'s own imports): still refuses', () => {
    behind('scripts/lane-pool.mjs', 'scripts/operations/review-loop-cli.mjs');
    expect(() => go()).toThrow(/2 commit\(s\) behind origin\/main.*STALE code/s);
  });

  it('behind in frontmatter imported by collision healing: still refuses', () => {
    behind('scripts/lane-pool.mjs', 'scripts/backlog/frontmatter.mjs');
    expect(() => go()).toThrow(/2 commit\(s\) behind origin\/main.*STALE code/s);
  });
});

describe('the two readers that decide "is a review running" see job rows (x26lw6u)', () => {
  const jobRow = { name: 'review-10', state: 'working', pid: 111, kind: REVIEW_JOB_KIND, startedAt: Date.now(), cwd: '/lane' };

  it('reconcile-pass#defaultReadAgents merges the live jobs into the claude agents listing', () => {
    const exec = () => JSON.stringify([{ name: 'fix-3', state: 'working', pid: 5, startedAt: Date.now() }]);
    const rows = defaultReadAgents({ exec, env: { WE_CLAUDE_AGENTS_CACHE_TTL_MS: '0' }, completionFor: () => null, hungInfoFor: () => null, listJobs: () => [jobRow] });
    expect(rows.map((r) => r.name)).toEqual(['fix-3', 'review-10']);
  });

  it('review-status-tag labels a PR with a live job as review-status:reviewing', () => {
    const edits = [];
    const provider = { readLabels: () => [], ensureLabel: () => {}, setLabels: (_r, _p, e) => edits.push(e) };
    const out = tagReviewStatus({ pr: 10, repo: REPO, listAgents: () => listAgentsWithReviewJobs({ listAgents: () => [], listJobs: () => [jobRow], listWrapped: () => [] }), provider });
    expect(out).toMatchObject({ changed: true, label: 'review-status:reviewing' });
  });
});

describe('dispatch mode', () => {
  it('defaults to the job; only an explicit session opts back into claude --bg', () => {
    expect(resolveReviewDispatchMode({})).toBe('job');
    expect(resolveReviewDispatchMode({ WE_REVIEW_DISPATCH_MODE: 'bogus' })).toBe('job');
    expect(resolveReviewDispatchMode({ WE_REVIEW_DISPATCH_MODE: 'session' })).toBe('session');
  });

  it('dispatchReviewByMode routes job mode to the job dispatch', () => {
    const out = dispatchReviewByMode({
      mode: 'job', ciGate: () => ({ allowed: true }), pr: 10, repo: REPO, root: '/daemon', dir, checkStaleness: FRESH, readCompletion: () => null,
      resolveSettingsEnv: () => null, spawnJob: () => 31,
    });
    expect(out).toMatchObject({ mode: 'job', jobPid: 31 });
  });
});

describe('x6n7c2p required checks before review — fresh dispatch boundary', () => {
  it.each(['pending', 'red', 'missing', 'head-moved', 'stale-cache', 'fallback', 'error', 'green'])('stale green plan, fresh %s', state => {
    const reads = [];
    const headSha = 'a'.repeat(40);
    let headReads = 0;
    let spawns = 0;
    let sessionWrites = 0;
    const ciGate = ({ repo, pr }) => readReviewCiGate({ repo, pr, policy: { startAfter: 'ci-green', startEarly: 'off' },
      readHead: args => { reads.push(['head', args]); return state === 'head-moved' && headReads++ ? 'b'.repeat(40) : headSha; },
      readRequired: args => { reads.push(['required', args]); return { source: ['stale-cache', 'fallback'].includes(state) ? state : 'live', checks: ['test', 'daemon-soak'] }; },
      readChecks: args => {
        reads.push(['checks', args]);
        if (state === 'error') throw new Error('offline');
        return [{ name: 'test', status: 'completed', conclusion: 'success' },
          ...(state === 'missing' ? [] : [{ name: 'daemon-soak', status: state === 'pending' ? 'in_progress' : 'completed', conclusion: state === 'red' ? 'failure' : 'success' }])];
      },
    });
    const out = dispatchReviewJob({ pr: 3432, repo: REPO, root: '/daemon', dir, ciGate,
      checkStaleness: FRESH, readCompletion: () => null, resolveSettingsEnv: () => ({}),
      spawnJob: () => { spawns++; return 4242; } });
    expect(readJobRecord('review-3432', dir) !== null).toBe(state === 'green');
    expect(spawns).toBe(state === 'green' ? 1 : 0);
    expect(Boolean(out.skipped)).toBe(state !== 'green');
    expect(reads[0]).toEqual(['head', { repo: 'web-everything/web-everything', pr: 3432 }]);
    expect(reads[1]).toEqual(['required', { repo: 'web-everything/web-everything', ttlMs: 0 }]);
    if (!['stale-cache', 'fallback'].includes(state)) expect(reads[2]).toEqual(['checks', { repo: 'web-everything/web-everything', headSha }]);
    if (state !== 'green') expect(out.headSha).toBe(headSha);
  });
});

it('x6n7c2p required checks before review — default job four-tick soak spends one round', () => {
  // Replay the original strict-CI policy, independently of the shipped push/early-review timing.
  let spawns = 0;
  const rounds = [];
  const dispatched = [];
  for (const [head, status, conclusion] of [['a', 'in_progress', null], ['a', 'completed', 'failure'], ['b', 'in_progress', null], ['b', 'completed', 'success']]) {
    const out = runReviewTick({ repo: REPO,
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 3432, attempts: 2 }], refusals: [] }),
      readPrs: () => [{ number: 3432, labels: [{ name: 'review:pending' }] }], readAgents: () => [],
      acquirableLanes: () => 1, tagRound: row => rounds.push(row.round), tagStatus: () => {}, statusCandidates: () => [], holdReconcile: () => [],
      dispatch: options => dispatchReviewByMode({ ...options, mode: 'job', root: '/daemon', dir,
        checkStaleness: FRESH, readCompletion: () => null, resolveSettingsEnv: () => ({}),
        ciGate: args => readReviewCiGate({ ...args, policy: { startAfter: 'ci-green', startEarly: 'off' }, readHead: () => head.repeat(40),
          readRequired: () => ({ source: 'live', checks: ['test', 'daemon-soak'] }),
          readChecks: () => [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'daemon-soak', status, conclusion }],
        }), spawnJob: () => { spawns++; return 4242; },
      }),
    });
    dispatched.push(out.dispatched.length);
    if (conclusion !== 'success') {
      expect(out.notStarted).toEqual([{ prNumber: 3432, reason: expect.stringMatching(/^review-ci: required-checks-not-successful: daemon-soak=\w+$/) }]);
      expect(rounds).toEqual([]);
      expect(spawns).toBe(0);
      expect(readJobRecord('review-3432', dir)).toBeNull();
    }
  }
  expect(dispatched).toEqual([0, 0, 0, 1]);
  expect(spawns).toBe(1);
  expect(rounds).toEqual([3]);
});

// #4154 — the daemon's scan is reused by the job, with a bounded stale-hint fallback.
describe('preferred review lanes', () => {
  it('preferLane: the job acquires the daemon-assigned lane first and never auto-picks when it wins', () => {
    const { io, calls } = fakeIo();
    const out = runReviewJob({ pr: 10, repo: REPO, preferLane: 7 }, io);
    expect(calls.filter(c => c[0] === 'acquire').map(c => c[1])).toEqual([
      { laneRepo: WE_LANE_REPO, slug: 'review-10', actorId: 'actor-fresh-uuid', lane: 7, waitMs: 0 },
    ]);
    expect(calls.find(c => c[0] === 'loop')[1].lanePath).toBe('/lanes/lane-7');
    expect(out.outcome).toBe('auto-cleared');
  });

  it.each([false, true])('preferLane: a lost preferred lane falls back to the bounded auto-pick (both fail: %s)', bothFail => {
    const acquireLane = vi.fn()
      .mockReturnValueOnce({ lanePath: null, error: 'lane-7 is held' })
      .mockReturnValueOnce({ lanePath: bothFail ? null : '/lanes/lane-9', error: 'pool full' });
    const log = vi.fn();
    const { io, calls } = fakeIo({ acquireLane, log });
    const out = runReviewJob({ pr: 10, repo: REPO, preferLane: 7 }, io);
    expect(acquireLane.mock.calls.map(([c]) => c)).toEqual([
      { laneRepo: WE_LANE_REPO, slug: 'review-10', actorId: 'actor-fresh-uuid', lane: 7, waitMs: 0 },
      { laneRepo: WE_LANE_REPO, slug: 'review-10', actorId: 'actor-fresh-uuid', waitMs: REVIEW_JOB_LANE_WAIT_MS },
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('preferred lane-7 not taken (lane-7 is held) — falling back to auto-pick'));
    expect(out.outcome).toBe(bothFail ? DEFERRED_NO_LANE : 'auto-cleared');
    const done = calls.filter(c => c[0] === 'report' && c[1] === 'done');
    expect(done).toHaveLength(1);
    if (bothFail) expect(done[0][2].label).toBe('lane-deferrals:1');
  });

  it('no preferLane: a single auto-pick acquire, unchanged', () => {
    const { io, calls } = fakeIo();
    runReviewJob({ pr: 10, repo: REPO }, io);
    expect(calls.filter(c => c[0] === 'acquire').map(c => c[1])).toEqual([
      { laneRepo: WE_LANE_REPO, slug: 'review-10', actorId: 'actor-fresh-uuid', waitMs: REVIEW_JOB_LANE_WAIT_MS },
    ]);
  });

  it.each([5, null, 0, 'x', -1, 1.5, '5'])('dispatchReviewJob passes --prefer-lane=<n> only for a positive integer: %s', preferLane => {
    const spawnJob = vi.fn(() => null);
    dispatchReviewJob({ pr: 10, repo: REPO, preferLane, root: '/daemon', dir,
      ciGate: () => ({ allowed: true }), checkStaleness: FRESH, readCompletion: () => null,
      resolveSettingsEnv: () => null, spawnJob });
    expect(spawnJob.mock.calls[0][0].argv.slice(1)).toEqual([
      'run', '--pr=10', `--repo=${REPO}`, ...(preferLane === 5 ? ['--prefer-lane=5'] : []),
    ]);
  });

  it('dispatchReviewByMode session mode never forwards preferLane to dispatchReview', () => {
    const dispatch = vi.spyOn(reviewDispatch, 'dispatchReview').mockReturnValue({ agentId: 'session' });
    try {
      dispatchReviewByMode({ mode: 'session', pr: 10, repo: REPO, preferLane: 7 });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith({ pr: 10, repo: REPO });
    } finally { dispatch.mockRestore(); }
  });
});


it('#4154 soak: 100 seven-review ticks reuse distinct assignments without auto-pick', () => {
  let loops = 0;
  for (let tick = 0; tick < 100; tick += 1) {
    const lanes = [4, 9, 12, 15, 19, 22, 25];
    const acquired = new Set();
    const scan = vi.fn(() => lanes);
    const out = runReviewTick({
      reconcile: () => ({ dispatch: lanes.map((_, i) => ({ kind: 'review', prNumber: 100 + i })), refusals: [] }),
      acquirableLanes: scan, holdReconcile: () => [], statusCandidates: () => [], tagRound: () => {}, tagStatus: () => {},
      dispatch: options => {
        const { io } = fakeIo({ acquireLane: ({ lane, waitMs }) => {
          expect(lanes).toContain(lane);
          expect(waitMs).toBe(0);
          expect(acquired.has(lane)).toBe(false);
          acquired.add(lane);
          return { lanePath: `/lanes/lane-${lane}` };
        } });
        const result = runReviewJob(options, io);
        expect(result.outcome).toBe('auto-cleared');
        expect(result.lanePath).toBe(`/lanes/lane-${options.preferLane}`);
        loops += 1;
        return result;
      },
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(out.failed).toEqual([]);
    expect(out.dispatched).toHaveLength(7);
    expect(acquired.size).toBe(7);
  }
  expect(loops).toBe(700);
});

describe('loopFailureLabel — the loop\'s own error is recorded, never swallowed (outage 2026-10-03)', () => {
  it('carries the refusal text and stop word of a loop that stopped before judging', () => {
    const parsed = { stopped: 'step-refused', verdict: null, error: 'review-pr-io: refusing to review x/y#1 — origin is a/b' };
    expect(loopFailureLabel(parsed, 1)).toBe('exit 1 (step-refused): review-pr-io: refusing to review x/y#1 — origin is a/b');
  });
  it('is null on a clean exit and a bare exit code when the payload has no error', () => {
    expect(loopFailureLabel({ stopped: 'complete' }, 0)).toBeNull();
    expect(loopFailureLabel({ stopped: 'confirm' }, 2)).toBe('exit 2');
  });
});

describe('dead running red-team owner behind an unfinished review', () => {
  let evidence, recovery, fs, os, pid, store, createReviewJobIo;
  beforeEach(async () => {
    [evidence, recovery, fs, os, pid, store, { createReviewJobIo }] = await Promise.all([
      import('../../lib/drain-red-team-evidence.mjs'),
      import('../../lib/review-red-team-on-skip.mjs'),
      import('node:fs'), import('node:os'), import('../../lib/pid-alive.mjs'),
      import('../run-store.mjs'), import('../review-job.mjs'),
    ]);
  });

  function fixture({ status = 'running', quietMs = evidence.ABANDONED_REVIEW_AFTER_MS + 60_000,
    failedSeat = false, foreign = false, alive = false, unreadableProbe = false } = {}) {
    const now = Date.parse('2026-11-07T12:00:00Z');
    const hour = evidence.ABANDONED_REVIEW_AFTER_MS;
    const repo = REPO, pr = 6378, head = `d3fd9d3a${'a'.repeat(32)}`;
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_STALE_RUN_MS: String(2 * hour) };
    const key = { repo, pr, head, env };
    mkdirSync(env.WE_SHARED_RUNS_DIR, { recursive: true });
    mkdirSync(evidence.redTeamStatusDir(env), { recursive: true });
    const writerPath = join(evidence.redTeamStatusDir(env), `${encodeURIComponent(repo)}-${pr}-${head}.json`);
    const writer = { repo, pr, head, status, result: status === 'finished' ? 'ran' : null,
      pid: 99999999, host: foreign ? 'another-host' : os.hostname(), pidNamespace: pid.pidNamespace(),
      // Unknown birth time cannot authorize recovery by age for foreign/unprobeable owners.
      pidStart: 'fixture-owner-start' };
    if (status !== null) writeFileSync(writerPath, JSON.stringify(writer));
    const makeRun = (id, startedHoursAgo) => ({
      ...store.newRunRecord({ id, op: 'review-pr', input: { repo, pr } }),
      stepTimings: [{ step: 'read', stepIndex: 0, startedAt: new Date(now - startedHoursAgo * hour).toISOString() }],
      findings: { read: { netBasis: { rev: head }, diffText: '+code', netChangedFiles: ['scripts/example.mjs'] } },
    });
    const decided = { ...makeRun('review-pr-6378-decided', 6),
      verdict: { verdict: 'needs-human', humanRequired: true,
        lensVerdicts: { correctness: 'accept' }, findings: [], admittedFindings: [] } };
    const unfinished = { ...makeRun('review-pr-6378-unfinished', 3),
      effects: [{ key: 'review-pr-6378-unfinished:1:0', type: 'mandatoryReferrals', stepIndex: 1,
        index: 0, status: 'in-flight', handle: null }] };
    const put = (run, age) => {
      const path = join(env.WE_SHARED_RUNS_DIR, `${run.id}.json`);
      writeFileSync(path, JSON.stringify(run));
      fs.utimesSync(path, new Date(now - age), new Date(now - age));
      return path;
    };
    // Both mtimes postdate both read starts, so the bounded scan sees both records.
    put(decided, 90 * 60_000);
    const unfinishedPath = put(unfinished, quietMs);
    const probe = { host: os.hostname(), namespace: pid.pidNamespace(),
      isAlive: vi.fn(() => { if (unreadableProbe) throw Error('pid table unreadable'); return alive; }),
      readPidStart: vi.fn(() => writer.pidStart) };
    const seats = failedSeat ? [{ dispatchKind: 'review-seat', seat: 'red-team', repo, pr, rev: head, status: 'unparseable' }] : [];
    const witnessOptions = { ...key, runsDir: env.WE_SHARED_RUNS_DIR, now, stat: fs.statSync, readScorecards: () => seats };
    const readWitness = () => evidence.readRecoveryWitness(witnessOptions);
    const recoveryOptions = { now, probe, deadlineMs: 2 * hour };
    const plan = () => recovery.planRedTeamRecovery(readWitness(), recoveryOptions);
    const abandon = () => recovery.abandonStaleRedTeamRun(key, {
      readWitness, now: () => now, probe, deadlineMs: recoveryOptions.deadlineMs,
    });
    const planningOptions = { repo, refusals: [{ kind: 'already-reviewed-head', prNumber: pr, headSha: head }],
      rawPrs: [{ number: pr, headRefOid: head, comments: [], reviews: [], labels: ['review:human', 'red-team:pending'] }],
      readWitness, readEvidence: () => evidence.readDrainRedTeamEvidence(witnessOptions),
      readStatus: () => status === null ? null : writer, readCarry: () => null,
      headNeverReviewed: () => false, now, setting: { enabled: true, retryCooldownMin: 0 },
      lastDispatch: new Map(), recoveryOptions };
    return { key, env, now, decided, unfinished, unfinishedPath, put, writerPath, probe,
      witnessOptions, readWitness, plan, abandon, planningOptions };
  }

  it.each([false, true])('recovers the dead running writer with the newest decided advisory accept (failed seat=%s)', failedSeat => {
    const f = fixture({ failedSeat });
    const witness = f.readWitness();
    expect(witness).not.toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(witness.newest).toEqual(f.decided);
    expect(f.plan()).toMatchObject({ mode: 'fresh', retry: failedSeat, abandon: true,
      executionPrior: failedSeat ? { status: 'finished', result: 'failed' } : null });
    expect(f.probe.isAlive).toHaveBeenCalledWith(99999999);
    // The drain reader must retain its unfinished-review hold.
    expect(evidence.readDrainRedTeamEvidence(f.witnessOptions)).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });

  it('holds a slow live owner with matching pidStart instead of recovering it twice', () => {
    const f = fixture({ alive: true });
    expect(f.plan()).toMatchObject({ mode: 'skip', why: 'owner live' });
    expect(f.probe.readPidStart).toHaveBeenCalledWith(99999999);
    expect(f.abandon()).toEqual({ ok: false });
    expect(existsSync(`${f.writerPath}.stale-redispatch-1`)).toBe(false);
  });

  it.each(['foreign host', 'unreadable pid table'])('holds an owner with %s and never re-dispatches', kind => {
    const f = fixture({ foreign: kind === 'foreign host', unreadableProbe: kind === 'unreadable pid table' });
    expect(f.plan().mode).toBe('skip');
    expect(recovery.planRedTeamOnSkip(f.planningOptions)[0].action).toBe('skip');
    expect(f.abandon()).toEqual({ ok: false });
    expect(existsSync(`${f.writerPath}.stale-redispatch-1`)).toBe(false);
  });

  it('keeps review-unfinished when the unfinished run was touched less than an hour ago', () => {
    const f = fixture({ quietMs: evidence.ABANDONED_REVIEW_AFTER_MS - 1 });
    expect(f.readWitness()).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(f.plan().mode).toBe('skip');
  });

  it('keeps review-unfinished when another unfinished run of this PR on another head is still active', () => {
    const f = fixture();
    f.put({ ...f.unfinished, id: 'review-pr-6378-other-head',
      findings: { read: { netBasis: { rev: 'b'.repeat(40) } } } }, 1000);
    expect(f.readWitness()).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });

  it.each([null, 'finished'])('keeps review-unfinished with no active writer (status=%s)', status => {
    const f = fixture({ status });
    expect(f.readWitness()).toMatchObject({ ok: false, reason: 'review-unfinished' });
    expect(f.plan().mode).toBe('skip');
  });

  it('keeps review-unfinished when the decided same-head review does not owe a red team', () => {
    const f = fixture();
    f.put({ ...f.decided, verdict: { verdict: 'changes' } }, 90 * 60_000);
    expect(f.readWitness()).toMatchObject({ ok: false, reason: 'review-unfinished' });
  });

  it('dispatches dead owner recovery on already-reviewed-head exactly once after abandonment and queued admission', () => {
    const f = fixture();
    const decide = () => recovery.planRedTeamOnSkip(f.planningOptions)[0];
    expect(decide()).toMatchObject({ action: 'dispatch', staleRecovery: true, why: 'dead owner recovery' });
    expect(f.abandon()).toEqual({ ok: true });
    expect(existsSync(`${f.writerPath}.stale-redispatch-1`)).toBe(true);
    // This fixture exercises local admission; label projection would require live GitHub IO.
    const io = createReviewJobIo({ root: dir, env: { ...f.env, WE_RED_TEAM_STATUS_LABELS: 'false' }, readWitness: f.readWitness, recoveryProbe: f.probe });
    io.redTeamStatus({ ...f.key, loopPayload: f.decided, status: 'queued', redTeamMode: 'fresh' });
    expect(decide()).toMatchObject({ action: 'skip' });
    expect(f.abandon()).toEqual({ ok: false });
  });

  it('dispatches recovery without any label writes, including review:* and ready-to-merge', () => {
    const f = fixture();
    const setLabels = vi.fn(), ensureLabel = vi.fn(), syncLabels = vi.fn();
    const provider = { readPrState: () => f.planningOptions.rawPrs[0], setLabels, ensureLabel };
    const dispatch = vi.fn(() => ({ jobPid: 12345 }));
    const result = recovery.runRedTeamOnSkip({
      ...f.planningOptions, plan: { refusals: f.planningOptions.refusals }, env: f.env,
      now: () => f.now, capacity: { lanes: 1, remainingStarts: 1 },
      provider, syncLabels, dispatch, abandon: f.abandon, escalate: vi.fn(),
    });
    expect(setLabels).not.toHaveBeenCalled();
    expect(ensureLabel).not.toHaveBeenCalled();
    expect(syncLabels).not.toHaveBeenCalled();
    expect(result.rows[0]).toMatchObject({ action: 'dispatch', staleRecovery: true, why: 'dead owner recovery' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ repo: f.key.repo, pr: f.key.pr, redTeamOnly: true, redTeamMode: 'fresh' });
  });
});
