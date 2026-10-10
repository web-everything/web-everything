/**
 * @file parallel-judges.test.mjs — `review.parallelSeats` and `review.seatsByTouchSet`.
 *
 * What this pins, end to end through the review daemon's own driver (`runReviewLoopOnce`) with a stub reader, a
 * scripted judge (real timers, small delays), recording sinks and an in-memory store:
 *   1. CONCURRENCY — every independent seat starts before any seat ends; wall time ≈ the slowest seat.
 *   2. SAME RECORD — findings, verdict, telemetry and effects are identical to the sequential drive for the same
 *      seat answers; only the step timings differ (and they show the overlap).
 *   3. ONE SEAT FAILS — the run stops exactly where the sequential drive stops, earlier seats committed, and the
 *      spend of seats that ran but could not be committed is still recorded.
 *   4. RESUME — a failed run resumes with `--resume` and completes with the same verdict as a clean run.
 *   5. ONE LANE PER TOOL-BEARING SEAT — a second tool-bearing seat runs in a lane of its own when one is given, and
 *      waits for the primary lane when none is.
 *   6. DOCS-ONLY SEATING — an all-prose touch-set does not seat the security juror; code keeps both mandatory seats.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { createRegistry, op } from '../registry.mjs';
import { compute, judge as judgeStep } from '../step-kinds.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { startRun, advance } from '../engine.mjs';
import { driveRun, judgeOutcome, restampStepStart } from '../cli-adapter.mjs';
import { planJudgeBatch, readsAnyStep, runJudgeBatch } from '../parallel-judges.mjs';
import {
  REVIEW_EFFECTS, reviewPrOperation, seatSecurityForTouchSet, securitySeatFromRun, SECURITY_SEAT_STEP,
} from '../review-pr.mjs';
import { chooseSecuritySeat, declaresSecuritySeat, runReviewLoopOnce, TOUCH_SET_FILE_CAP } from '../review-loop-cli.mjs';
import { resolveReviewSeatSetting } from '../../lib/review-seat-settings.mjs';

const NET_PATHS = ['scripts/operations/review-pr.mjs'];

function stubReader() {
  return ({ pr, repo }) => ({
    state: 'OPEN',
    clearerId: undefined,
    createdAt: '',
    detail: {
      pr, repo, title: 'a PR', url: `https://example.invalid/${pr}`,
      labels: ['review:pending'], humanRequired: false, reviewClass: 'pending',
      disposition: { mode: 'converge', autoLand: false }, escalationReason: [], advisoryComment: null, humanComment: null,
      diffStat: NET_PATHS.map((p) => ({ path: p, additions: 1, deletions: 0 })),
    },
    headRefName: 'lane/thing',
    body: 'the PR description',
    net: { paths: NET_PATHS, base: 'abc123', rev: 'def456', scored: true },
    diff: { text: '--- a/x\n+++ b/x\n+one line\n', scored: true },
  });
}

function build(opts = {}) {
  const declaration = reviewPrOperation({ readPr: stubReader(), codexAdvisory: true, correctnessAdvisory: true, ...opts });
  const registry = createRegistry();
  registry.register(declaration);
  return { declaration, registry };
}

function recordingSinks() {
  return Object.fromEntries(Object.values(REVIEW_EFFECTS).map((t) => [t, async () => ({ ok: true })]));
}

const ANSWERS = {
  correctness: { summary: 'nothing blocking', findings: [] },
  security: { summary: 'one blocker', findings: [{ summary: 'an unchecked input reaches argv', file: NET_PATHS[0], disposition: 'blocker' }] },
};
const answerFor = (lens) => ANSWERS[lens] ?? { summary: `advisory ${lens}: fine`, findings: [] };
const DELAY = { correctness: 120, security: 90 };
const delayFor = (lens) => DELAY[lens] ?? 60;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** A scripted judge factory: every call is logged with its lens, cwd and real start/end instants. */
function scriptedJudge({ fail = null } = {}) {
  const calls = [];
  const make = () => async (request, opts) => {
    const call = { lens: request.lens, tools: Array.isArray(request.allowedTools) && request.allowedTools.length > 0, cwd: opts?.cwd ?? null, start: Date.now(), end: null };
    calls.push(call);
    await sleep(delayFor(request.lens));
    call.end = Date.now();
    if (fail && fail(request.lens)) {
      const e = new Error(`seat ${request.lens} crashed`);
      e.telemetry = { costUsd: 0.05, sessionId: `failed-${request.lens}`, servedModel: 'sonnet' };
      throw e;
    }
    return judgeOutcome(answerFor(request.lens), { costUsd: 0.1, sessionId: `sess-${request.lens}` });
  };
  return { calls, make };
}

const ARGV = ['--pr=1234', '--repo=web-everything/web-everything', '--json'];
const lanes = () => {
  const released = [];
  return { released, provider: { acquire: async ({ step }) => ({ cwd: `/lanes/seat-${step}`, release: () => { released.push(step); } }) } };
};

async function loop({ parallel, judge, seatLanes = null, runId, store = createMemoryRunStore(), argv = ARGV, opts = {} }) {
  const { declaration, registry } = build(opts);
  const out = await runReviewLoopOnce({
    declaration, registry, argv, store, sinks: recordingSinks(), makeJudge: judge.make, mintRunId: () => runId,
    appendLearning: () => ({ path: '/dev/null' }), fileItem: async () => ({ code: 0, lines: ['{}'] }),
    parallelJudges: parallel, seatLanes,
  });
  return { out, run: store.read(out.run?.id ?? runId), store, declaration, registry };
}

/** Everything a verdict is made of — the record minus the wall-clock step timings. */
const substance = (run) => ({
  cursor: run.cursor, pending: run.pending, findings: run.findings, verdict: run.verdict, telemetry: run.telemetry,
  effects: (run.effects ?? []).map(({ key, step, type, payload, status }) => ({ key, step, type, payload, status })),
});

describe('review.parallelSeats — concurrency and an identical record', () => {
  it('starts every seat before any ends, and wall time is about the slowest seat', async () => {
    const judge = scriptedJudge();
    const { provider } = lanes();
    const t0 = Date.now();
    const { run } = await loop({ parallel: true, judge, seatLanes: provider, runId: 'r-par' });
    const wall = Date.now() - t0;
    expect(judge.calls.map((c) => c.lens).sort()).toEqual(['codex-correctness', 'correctness', 'security', 'simplicity'].sort());
    const lastStart = Math.max(...judge.calls.map((c) => c.start));
    const firstEnd = Math.min(...judge.calls.map((c) => c.end));
    expect(lastStart).toBeLessThan(firstEnd);
    const sum = judge.calls.reduce((n, c) => n + (c.end - c.start), 0);
    expect(wall).toBeLessThan(sum * 0.75);
    // The run record's own step timings show the overlap too.
    const seats = run.stepTimings.filter((t) => t.step.startsWith('judge'));
    expect(seats).toHaveLength(4);
    expect(Math.max(...seats.map((t) => Date.parse(t.startedAt)))).toBeLessThan(Math.min(...seats.map((t) => Date.parse(t.finishedAt))));
  });

  it('writes the same findings, verdict, telemetry and effects as the sequential drive', async () => {
    const seq = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-same' });
    const par = await loop({ parallel: true, judge: scriptedJudge(), seatLanes: lanes().provider, runId: 'r-same' });
    expect(par.out.code).toBe(seq.out.code);
    expect(substance(par.run)).toEqual(substance(seq.run));
    expect(par.run.verdict.verdict ?? par.run.verdict).toEqual(seq.run.verdict.verdict ?? seq.run.verdict);
    // Sequential seats never overlap; that is the cost this setting removes.
    const s = seq.run.stepTimings.filter((t) => t.step.startsWith('judge'));
    for (let i = 1; i < s.length; i += 1) expect(Date.parse(s[i].startedAt)).toBeGreaterThanOrEqual(Date.parse(s[i - 1].finishedAt));
  });
});

describe('review.parallelSeats — one seat fails', () => {
  it('stops where the sequential drive stops, keeps earlier answers, and records every spawn it paid for', async () => {
    const failSecurity = (lens) => lens === 'security';
    const seqStore = createMemoryRunStore();
    await expect(loop({ parallel: false, judge: scriptedJudge({ fail: failSecurity }), runId: 'r-fail', store: seqStore })).rejects.toThrow('seat security crashed');
    const parStore = createMemoryRunStore();
    await expect(loop({ parallel: true, judge: scriptedJudge({ fail: failSecurity }), seatLanes: lanes().provider, runId: 'r-fail', store: parStore })).rejects.toThrow('seat security crashed');
    const seq = seqStore.read('r-fail');
    const par = parStore.read('r-fail');
    expect(par.pending?.step).toBe(SECURITY_SEAT_STEP);
    expect(par.pending).toEqual(seq.pending);
    expect(par.findings).toEqual(seq.findings);
    expect(par.cursor).toBe(seq.cursor);
    // Sequential: the committed seat + the failed one. Parallel: the same two rows FIRST, then the advisory seats
    // that ran alongside and whose answers could not be committed — their cost is real, so it is on the record.
    expect(par.telemetry.slice(0, seq.telemetry.length)).toEqual(seq.telemetry);
    expect(par.telemetry.slice(seq.telemetry.length).map((t) => t.step).sort()).toEqual(['judgeAdvisory', 'judgeCorrectnessAdvisory']);
  });

  it('resumes a failed run with --resume and completes with the same verdict as a clean run', async () => {
    const store = createMemoryRunStore();
    await expect(loop({ parallel: true, judge: scriptedJudge({ fail: (l) => l === 'security' }), seatLanes: lanes().provider, runId: 'r-resume', store })).rejects.toThrow();
    const resumed = await loop({ parallel: true, judge: scriptedJudge(), seatLanes: lanes().provider, runId: 'r-resume', store, argv: ['--resume=r-resume', '--json'] });
    const clean = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-clean' });
    expect(resumed.run.cursor).toBe(clean.run.cursor);
    expect(resumed.run.findings.reduce).toEqual(clean.run.findings.reduce);
    expect(resumed.run.findings.judgeSecurity).toEqual(clean.run.findings.judgeSecurity);
  });
});

describe('review.parallelSeats — one lane per tool-bearing seat', () => {
  it('runs the second tool-bearing seat in a lane of its own, concurrently, and releases it', async () => {
    const judge = scriptedJudge();
    const { released, provider } = lanes();
    await loop({ parallel: true, judge, seatLanes: provider, runId: 'r-lane' });
    const correctness = judge.calls.find((c) => c.lens === 'correctness');
    const security = judge.calls.find((c) => c.lens === 'security');
    expect(correctness.cwd).toBe(null); // the primary lane (the judge factory's own cwd)
    expect(security.cwd).toBe(`/lanes/seat-${SECURITY_SEAT_STEP}`);
    expect(security.start).toBeLessThan(correctness.end);
    expect(released).toEqual([SECURITY_SEAT_STEP]);
  });

  it('with no lane to give, the second tool-bearing seat waits for the primary lane; tool-free seats still overlap', async () => {
    const judge = scriptedJudge();
    await loop({ parallel: true, judge, seatLanes: null, runId: 'r-nolane' });
    const correctness = judge.calls.find((c) => c.lens === 'correctness');
    const security = judge.calls.find((c) => c.lens === 'security');
    expect(security.cwd).toBe(null);
    expect(security.start).toBeGreaterThanOrEqual(correctness.end);
    const advisory = judge.calls.filter((c) => !c.tools);
    expect(advisory.length).toBeGreaterThan(0);
    for (const a of advisory) expect(a.start).toBeLessThan(correctness.end);
  });
});

describe('planJudgeBatch — only independent judge steps are batched', () => {
  it('batches every review-pr seat and stops before reduce', () => {
    const { registry } = build();
    let run = startRun({ op: 'review-pr', id: 'r-plan', input: { pr: 1, repo: 'web-everything/web-everything' }, registry });
    run = advance(run, { registry }); // read
    run = advance(run, { registry }); // suspends on judge
    expect(planJudgeBatch(run, { registry }).map((s) => s.step)).toEqual(['judge', 'judgeSecurity', 'judgeAdvisory', 'judgeCorrectnessAdvisory']);
  });

  it('stops at a judge step that reads an earlier seat', () => {
    const shape = { type: 'object' };
    const declaration = op('dep-fixture', {
      input: { x: 'number' },
      base: compute({ reads: ['input.x'], fn: (v) => v.input.x }),
      a: judgeStep({ reads: ['findings.base'], request: () => ({ mandate: 'm', input: 'a', shape }) }),
      b: judgeStep({ reads: ['findings.base'], request: () => ({ mandate: 'm', input: 'b', shape }) }),
      c: judgeStep({ reads: ['findings.a'], request: (v) => ({ mandate: 'm', input: JSON.stringify(v.findings.a), shape }) }),
    });
    const registry = createRegistry();
    registry.register(declaration);
    let run = startRun({ op: 'dep-fixture', id: 'r-dep', input: { x: 1 }, registry });
    run = advance(advance(run, { registry }), { registry });
    expect(planJudgeBatch(run, { registry }).map((s) => s.step)).toEqual(['a', 'b']);
    expect(readsAnyStep(['findings.a'], new Set(['a']), declaration)).toBe(true);
    expect(readsAnyStep(['input.x', 'findings.base'], new Set(['a']), declaration)).toBe(false);
  });

  it('runJudgeBatch never throws and reports each seat', async () => {
    const results = await runJudgeBatch({
      batch: [{ step: 'a', stepIndex: 1, request: { lens: 'a' } }, { step: 'b', stepIndex: 2, request: { lens: 'b' } }],
      judge: async (r) => { if (r.lens === 'b') throw new Error('no'); return 1; },
    });
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });
});

describe('driveRun — parallel off by default', () => {
  it('a caller that does not ask stays sequential', async () => {
    const { registry } = build();
    const judge = scriptedJudge();
    const run = startRun({ op: 'review-pr', id: 'r-default', input: { pr: 1, repo: 'web-everything/web-everything' }, registry });
    await driveRun({ run, registry, store: createMemoryRunStore(), sinks: recordingSinks(), judge: judge.make(), autoConfirm: () => ({ value: 'abstain' }) }).catch(() => {});
    for (let i = 1; i < judge.calls.length; i += 1) expect(judge.calls[i].start).toBeGreaterThanOrEqual(judge.calls[i - 1].end);
  });

  it('restampStepStart moves only an open row', () => {
    const run = { stepTimings: [{ step: 'a', stepIndex: 0, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', durationMs: 1000 }, { step: 'b', stepIndex: 1, startedAt: '2026-01-01T00:00:05.000Z' }] };
    expect(restampStepStart(run, 1, '2026-01-01T00:00:02.000Z').stepTimings[1].startedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(restampStepStart(run, 0, '2026-01-01T00:00:02.000Z')).toBe(run);
  });
});

describe('review.seatsByTouchSet — the seat list comes from the touch-set, before the run', () => {
  it('an all-prose PR does not seat the security juror; code, mixed and unreadable PRs do', () => {
    expect(seatSecurityForTouchSet({ changedFiles: ['backlog/x-a-card.md'] }).securitySeat).toBe(false);
    expect(seatSecurityForTouchSet({ changedFiles: ['scripts/a.mjs'] }).securitySeat).toBe(true);
    expect(seatSecurityForTouchSet({ changedFiles: ['backlog/x.md', 'scripts/a.mjs'] }).securitySeat).toBe(true);
    expect(seatSecurityForTouchSet({ changedFiles: ['backlog/x.md', 'docs/agent/platform-decisions.md'] }).securitySeat).toBe(true);
    expect(seatSecurityForTouchSet({ changedFiles: [] }).securitySeat).toBe(true);
    // A non-mandatory caller-chosen seat keeps security, or no blocking lens would be seated at all.
    expect(seatSecurityForTouchSet({ changedFiles: ['backlog/x.md'], lens: 'simplicity' }).securitySeat).toBe(true);
  });

  it('chooseSecuritySeat fails closed and reads a resume off the saved run', () => {
    const prose = () => ['backlog/x.md'];
    expect(chooseSecuritySeat(['--pr=5'], { readChangedFiles: prose }).securitySeat).toBe(false);
    expect(chooseSecuritySeat(['--pr=5'], { enabled: false, readChangedFiles: prose }).securitySeat).toBe(true);
    expect(chooseSecuritySeat(['--pr=5'], { readChangedFiles: () => { throw new Error('gh down'); } }).securitySeat).toBe(true);
    expect(chooseSecuritySeat(['--pr=5'], { readChangedFiles: () => Array.from({ length: TOUCH_SET_FILE_CAP }, (_, i) => `backlog/${i}.md`) }).securitySeat).toBe(true);
    expect(chooseSecuritySeat([], { readChangedFiles: prose }).securitySeat).toBe(true);
    const store = createMemoryRunStore();
    store.write({ ...startRun({ op: 'review-pr', id: 'r-saved', input: { pr: 5, repo: 'r/r' }, registry: build().registry }), findings: { read: {}, judge: {} } });
    expect(chooseSecuritySeat(['--resume=r-saved'], { store, readChangedFiles: () => { throw new Error('must not read'); } }).securitySeat).toBe(false);
  });

  it('a docs-only run seats no security juror, reduces on correctness alone, and reads back as such', async () => {
    const judge = scriptedJudge();
    const { run, declaration } = await loop({ parallel: true, judge, seatLanes: lanes().provider, runId: 'r-docs', opts: { securitySeat: false } });
    expect(declaresSecuritySeat(declaration)).toBe(false);
    expect(judge.calls.map((c) => c.lens)).not.toContain('security');
    expect(run.findings).not.toHaveProperty(SECURITY_SEAT_STEP);
    expect(run.cursor).toBe(declaration.steps.length);
    expect(securitySeatFromRun(run)).toBe(false);
    // The code roster is untouched: both mandatory seats are declared by default.
    expect(declaresSecuritySeat(build().declaration)).toBe(true);
  });

  it('a parked run is never resumed under a different roster', async () => {
    // Covered by `rosterMatches` in runReviewLoopOnce: a saved full-roster run and a docs-only declaration disagree.
    const full = { findings: { judge: {}, judgeSecurity: {} } };
    expect(securitySeatFromRun(full)).toBe(true);
    expect(securitySeatFromRun({ findings: { judge: {} } })).toBe(false);
    expect(securitySeatFromRun({ findings: {} })).toBe(true);
  });
});

describe('review seat settings — the policy cascade', () => {
  it('env > settings file > built-in, unknown values fall through', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-seat-settings-'));
    const file = join(dir, 'review.json');
    writeFileSync(file, JSON.stringify({ parallelSeats: 'off', seatsByTouchSet: 'bogus' }));
    expect(resolveReviewSeatSetting('parallelSeats', { env: {}, file })).toEqual({ value: 'off', source: 'settings' });
    expect(resolveReviewSeatSetting('parallelSeats', { env: { WE_REVIEW_PARALLEL_SEATS: 'on' }, file })).toEqual({ value: 'on', source: 'env' });
    expect(resolveReviewSeatSetting('seatsByTouchSet', { env: {}, file })).toEqual({ value: 'on', source: 'default' });
    expect(resolveReviewSeatSetting('seatsByTouchSet', { env: { WE_REVIEW_SEATS_BY_TOUCH_SET: '0' }, file: join(dir, 'missing.json') })).toEqual({ value: 'off', source: 'env' });
  });
});
