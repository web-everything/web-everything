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

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { createRegistry, op } from '../registry.mjs';
import { compute, judge as judgeStep } from '../step-kinds.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { startRun, advance, rewindRunToStep } from '../engine.mjs';
import { createDefaultJudge, driveRun, judgeOutcome, restampStepStart, unwrapJudgeOutcome } from '../cli-adapter.mjs';
import { planJudgeBatch, readsAnyStep, runJudgeBatch, seatFailureEvidence } from '../parallel-judges.mjs';
import {
  REVIEW_EFFECTS, reviewPrOperation, renameSourcePaths, seatSecurityForTouchSet, securitySeatFromRun, SECURITY_SEAT_STEP,
} from '../review-pr.mjs';
import {
  chooseSecuritySeat, createSeatLaneProvider, declaresSecuritySeat, pathsWithRenameSources, RESUME_STEP, runReviewLoopOnce, TOUCH_SET_FILE_CAP,
} from '../review-loop-cli.mjs';
import { resolveReviewSeatSetting } from '../../lib/review-seat-settings.mjs';

const NET_PATHS = ['scripts/operations/review-pr.mjs'];

function stubReader(paths = NET_PATHS, diffText = '--- a/x\n+++ b/x\n+one line\n', diffScored = true) {
  return ({ pr, repo }) => ({
    state: 'OPEN',
    clearerId: undefined,
    createdAt: '',
    detail: {
      pr, repo, title: 'a PR', url: `https://example.invalid/${pr}`,
      labels: ['review:pending'], humanRequired: false, reviewClass: 'pending',
      disposition: { mode: 'converge', autoLand: false }, escalationReason: [], advisoryComment: null, humanComment: null,
      diffStat: paths.map((p) => ({ path: p, additions: 1, deletions: 0 })),
    },
    headRefName: 'lane/thing',
    body: 'the PR description',
    net: { paths, base: 'abc123', rev: 'def456', scored: true },
    diff: { text: diffText, scored: diffScored },
  });
}

const PROSE_PATHS = ['backlog/x-a-card.md'];

/** `opts.netPaths` is the PR's net changed-file list the stub reader reports; a prose roster defaults to a prose PR. */
function build({ netPaths, diffText, diffScored, ...opts } = {}) {
  const paths = netPaths ?? (opts.securitySeat === false ? PROSE_PATHS : NET_PATHS);
  const declaration = reviewPrOperation({ readPr: stubReader(paths, diffText, diffScored), codexAdvisory: true, correctnessAdvisory: true, ...opts });
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

  // Held item 223 (item 4): the seats that ran BESIDE the failed one and answered are not thrown away. Their answers
  // are saved on the run (`prefilledSeats`), and a resume commits them instead of paying for them again.
  it('saves the later seats\' answers on the run when a seat fails', async () => {
    const store = createMemoryRunStore();
    await expect(loop({ parallel: true, judge: scriptedJudge({ fail: (l) => l === 'security' }), seatLanes: lanes().provider, runId: 'r-save', store })).rejects.toThrow();
    const run = store.read('r-save');
    expect(run.pending?.step).toBe(SECURITY_SEAT_STEP);
    const saved = run.prefilledSeats ?? [];
    expect(saved.map((s) => s.step).sort()).toEqual(['judgeAdvisory', 'judgeCorrectnessAdvisory']);
    for (const s of saved) {
      expect(s.value).toEqual(answerFor(s.request.lens));
      expect(Number.isInteger(s.stepIndex)).toBe(true);
      expect(typeof s.startedAt).toBe('string');
      expect(typeof s.finishedAt).toBe('string');
      // Their spend is already on the record (see the test above), so a resume must not record it twice.
      expect(s.telemetryRecorded).toBe(true);
    }
  });

  it('a resume reuses the saved answers: only the failed seat is spawned again, and no spend is counted twice', async () => {
    const store = createMemoryRunStore();
    await expect(loop({ parallel: true, judge: scriptedJudge({ fail: (l) => l === 'security' }), seatLanes: lanes().provider, runId: 'r-reuse', store })).rejects.toThrow();
    const again = scriptedJudge();
    const resumed = await loop({ parallel: true, judge: again, seatLanes: lanes().provider, runId: 'r-reuse', store, argv: ['--resume=r-reuse', '--json'] });
    expect(again.calls.map((c) => c.lens)).toEqual(['security']);
    const clean = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-reuse-clean' });
    expect(resumed.run.cursor).toBe(clean.run.cursor);
    expect(resumed.run.findings.judgeAdvisory).toEqual(clean.run.findings.judgeAdvisory);
    expect(resumed.run.findings.judgeCorrectnessAdvisory).toEqual(clean.run.findings.judgeCorrectnessAdvisory);
    expect(resumed.run.findings.reduce).toEqual(clean.run.findings.reduce);
    expect(resumed.run.prefilledSeats ?? []).toEqual([]);
    const rows = (step) => resumed.run.telemetry.filter((t) => t.step === step).length;
    expect(rows('judgeAdvisory')).toBe(1);
    expect(rows('judgeCorrectnessAdvisory')).toBe(1);
  });

  it('a saved answer whose request no longer matches is discarded and the seat spawned again (spend not re-recorded)', async () => {
    const store = createMemoryRunStore();
    await expect(loop({ parallel: true, judge: scriptedJudge({ fail: (l) => l === 'security' }), seatLanes: lanes().provider, runId: 'r-stale', store })).rejects.toThrow();
    const run = store.read('r-stale');
    const stale = run.prefilledSeats.find((s) => s.step === 'judgeAdvisory');
    store.write({ ...run, prefilledSeats: run.prefilledSeats.map((s) => (s === stale ? { ...s, request: { ...s.request, mandate: 'a different request' } } : s)) });
    const again = scriptedJudge();
    const resumed = await loop({ parallel: true, judge: again, seatLanes: lanes().provider, runId: 'r-stale', store, argv: ['--resume=r-stale', '--json'] });
    expect(again.calls.map((c) => c.lens).sort()).toEqual(['security', stale.request.lens].sort());
    // One row from the first spawn (recorded at the failure), one from the respawn — never a third.
    expect(resumed.run.telemetry.filter((t) => t.step === 'judgeAdvisory').length).toBe(2);
    expect(resumed.run.telemetry.filter((t) => t.step === 'judgeCorrectnessAdvisory').length).toBe(1);
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

  // Held item 223: a failed seat says WHY — exit code, signal, attempts and a stderr tail — on the seat result and in
  // the log line, instead of a bare "failed after N ms" that left the cause unrecoverable.
  it('a failed seat carries its spawn evidence on the result and in the log line', async () => {
    const lines = [];
    const spawnErr = Object.assign(new Error('judge-spawn: the juror did not emit parseable JSON on stdout (attempt 2/2, exit 1, signal none, stdout 0 bytes).'), {
      exitCode: 1, signal: null, attempts: 2, stderrTail: 'boom: socket hang up',
    });
    const results = await runJudgeBatch({
      batch: [{ step: 'a', stepIndex: 1, request: { lens: 'a' } }, { step: 'judgeSecurity', stepIndex: 2, request: { lens: 'security' } }],
      judge: async (r) => { if (r.lens === 'security') throw spawnErr; return 1; },
      log: (l) => lines.push(l),
    });
    expect(results[1].ok).toBe(false);
    expect(results[1].failure).toEqual({ exitCode: 1, signal: null, attempts: 2, stderrTail: 'boom: socket hang up' });
    expect(results[0].failure).toBeUndefined();
    const line = lines.find((l) => l.includes('judgeSecurity failed'));
    expect(line).toMatch(/exit 1/);
    expect(line).toMatch(/signal none/);
    expect(line).toMatch(/2 attempts/);
    expect(line).toMatch(/socket hang up/);
  });

  it('seatFailureEvidence is null for an error with no spawn evidence, and bounds the stderr tail', () => {
    expect(seatFailureEvidence(new Error('plain'))).toBe(null);
    expect(seatFailureEvidence(null)).toBe(null);
    const ev = seatFailureEvidence(Object.assign(new Error('x'), { exitCode: 2, stderrTail: 'y'.repeat(5000) }));
    expect(ev.exitCode).toBe(2);
    expect(ev.signal).toBe(null);
    expect(ev.stderrTail.length).toBeLessThanOrEqual(1000);
  });
});

describe('driveRun — a changed request never commits its early answer', () => {
  it('discards the answer planned for the old request, records its spend, and respawns the seat', async () => {
    const shape = { type: 'object' };
    let n = 0; // the request of `b` differs every time it is built: the plan's copy and the engine's copy disagree
    const declaration = op('drift-fixture', {
      input: { x: 'number' },
      a: judgeStep({ reads: ['input.x'], request: () => ({ mandate: 'm', input: 'a', shape }) }),
      b: judgeStep({ reads: ['input.x'], request: () => { n += 1; return { mandate: 'm', input: `b-${n}`, shape }; } }),
      done: compute({ reads: ['findings.a', 'findings.b'], fn: (v) => ({ a: v.findings.a, b: v.findings.b }) }),
    });
    const registry = createRegistry();
    registry.register(declaration);
    const calls = [];
    const judge = async (request) => {
      calls.push(request.input);
      return judgeOutcome({ answered: request.input }, { costUsd: 0.1, sessionId: `s-${calls.length}` });
    };
    const store = createMemoryRunStore();
    const run = startRun({ op: 'drift-fixture', id: 'r-drift', input: { x: 1 }, registry });
    const out = await driveRun({ run, registry, store, sinks: {}, judge, parallelJudges: true, log: () => {} });
    expect(out.stopped).toBe('complete');
    // `b` was answered once for the planned request and once for the request the engine really asked for.
    expect(calls.filter((c) => c.startsWith('b-'))).toHaveLength(2);
    const planned = calls.find((c) => c.startsWith('b-'));
    // The committed answer is the fresh one, never the planned one.
    expect(out.run.findings.b.answered).not.toBe(planned);
    expect(out.run.findings.b.answered).toBe(calls.filter((c) => c.startsWith('b-'))[1]);
    // The planned answer's spend is on the record: a row for `b` beyond the committed one.
    expect(out.run.telemetry.filter((t) => t.step === 'b')).toHaveLength(2);
    expect(out.run.telemetry).toHaveLength(3);
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
    // A run STARTED on the prose roster reads back as prose, whatever it has answered so far.
    const store = createMemoryRunStore();
    store.write({ ...startRun({ op: 'review-pr', id: 'r-saved', input: { pr: 5, repo: 'r/r' }, registry: build({ securitySeat: false }).registry }), findings: { read: { securitySeat: false }, judge: {} } });
    expect(chooseSecuritySeat(['--resume=r-saved'], { store, readChangedFiles: () => { throw new Error('must not read'); } }).securitySeat).toBe(false);
  });

  it('a resume reads the roster the run STARTED with — a seat that failed or never answered does not change it', async () => {
    // The reviewer's case: a full-roster run answers `judge`, then `judgeSecurity` fails. The saved run has
    // `findings.judge` and no `findings.judgeSecurity`, and is pending ON the security seat.
    const fullStore = createMemoryRunStore();
    await expect(loop({ parallel: true, judge: scriptedJudge({ fail: (l) => l === 'security' }), seatLanes: lanes().provider, runId: 'r-full-fail', store: fullStore })).rejects.toThrow('seat security crashed');
    const failed = fullStore.read('r-full-fail');
    expect(failed.pending?.step).toBe(SECURITY_SEAT_STEP);
    expect(failed.findings).not.toHaveProperty(SECURITY_SEAT_STEP);
    const fullSeating = chooseSecuritySeat(['--resume=r-full-fail'], { store: fullStore, readChangedFiles: () => { throw new Error('must not read'); } });
    expect(fullSeating.securitySeat).toBe(true);
    expect(securitySeatFromRun(failed)).toBe(true);
    // Registered the way both CLIs register it, the resume completes (no 'suspended at step … but …' refusal).
    const done = await loop({ parallel: true, judge: scriptedJudge(), seatLanes: lanes().provider, runId: 'r-full-fail', store: fullStore, argv: ['--resume=r-full-fail', '--json'], opts: { securitySeat: fullSeating.securitySeat } });
    expect(done.run.findings).toHaveProperty(SECURITY_SEAT_STEP);
    expect(done.run.cursor).toBe(done.declaration.steps.length);

    // The opposite shape (codex): a PROSE run interrupted before its first seat answered must stay prose.
    const proseStore = createMemoryRunStore();
    await expect(loop({ parallel: false, judge: scriptedJudge({ fail: (l) => l === 'correctness' }), runId: 'r-prose-fail', store: proseStore, opts: { securitySeat: false } })).rejects.toThrow('seat correctness crashed');
    const proseFailed = proseStore.read('r-prose-fail');
    expect(proseFailed.findings).not.toHaveProperty('judge');
    const proseSeating = chooseSecuritySeat(['--resume=r-prose-fail'], { store: proseStore, readChangedFiles: () => { throw new Error('must not read'); } });
    expect(proseSeating.securitySeat).toBe(false);
    const proseDone = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-prose-fail', store: proseStore, argv: ['--resume=r-prose-fail', '--json'], opts: { securitySeat: proseSeating.securitySeat } });
    expect(declaresSecuritySeat(proseDone.declaration)).toBe(false);
    expect(proseDone.run.findings).not.toHaveProperty(SECURITY_SEAT_STEP);
  });

  it('a prose roster refuses when the net diff the run reads now holds code (the author pushed after the touch-set read)', async () => {
    const judge = scriptedJudge();
    const refused = await loop({ parallel: false, judge, runId: 'r-toctou', opts: { securitySeat: false, netPaths: ['backlog/x-a-card.md', 'scripts/operations/review-pr.mjs'] } });
    expect(refused.out.code).toBe(1);
    expect(JSON.stringify(refused.out)).toMatch(/roster leaves the security juror out/);
    expect(judge.calls).toHaveLength(0); // refused before any juror was paid for
    // The same run on a PR that is still all prose proceeds.
    const ok = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-toctou-ok', opts: { securitySeat: false } });
    expect(ok.run.findings).not.toHaveProperty(SECURITY_SEAT_STEP);
  });

  it('the roster is not an input a caller can name, and a refused prose run resumes on the full roster', async () => {
    // The roster is stamped on `findings.read` by the build itself; naming it at start is an unknown input.
    const { registry } = build();
    expect(() => startRun({ op: 'review-pr', id: 'r-bypass', input: { pr: 1, repo: 'web-everything/web-everything', securitySeat: false }, registry }))
      .toThrow(/unknown input field `securitySeat`/);
    // A prose run refused at `read` (code in the net list) never recorded a roster, so a resume is the full roster.
    const refused = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-refused', opts: { securitySeat: false, netPaths: ['scripts/operations/review-pr.mjs'] } });
    expect(refused.out.code).toBe(1);
    expect(refused.run.findings).not.toHaveProperty('read');
    expect(securitySeatFromRun(refused.run)).toBe(true);
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

  describe('a parked run is never resumed under a different roster (runReviewLoopOnce)', () => {
    // A run parked on a mandatory referral, resumable by the daemon's `findResumableRun`. Each case parks a run under
    // one roster, then starts the next round under the other and asks which run id comes back.
    const referral = (file) => ({ summary: 'one confirmed defect', findings: [{ summary: 'the guard is inverted', file, line: 3, disposition: 'blocker', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }] });
    const parkingSinks = (file) => ({
      ...recordingSinks(),
      [REVIEW_EFFECTS.MANDATORY_REFERRALS]: async () => ({ records: [], pending: ['k1'], blocked: [], pendingFindings: [{ file, line: 3, seat: 'judgeAdvisory', summary: 'the guard is inverted' }] }),
    });
    const round = async ({ store, opts, runId, resumable = null, judged = { n: 0 } }) => {
      const { declaration, registry } = build(opts);
      const file = opts.securitySeat === false ? PROSE_PATHS[0] : NET_PATHS[0];
      const makeJudge = () => async () => { judged.n += 1; return judgeOutcome(referral(file), { costUsd: 0.1, sessionId: 's' }); };
      const out = await runReviewLoopOnce({
        declaration, registry, argv: ARGV, store, sinks: parkingSinks(file), makeJudge, mintRunId: () => runId,
        appendLearning: () => ({ path: '/dev/null' }), fileItem: async () => ({ code: 0, lines: ['{}'] }),
        findResumableRun: () => resumable,
      });
      return { out, declaration, registry };
    };

    it.each([
      ['a full-roster run is not resumed by a docs-only round', { securitySeat: true }, { securitySeat: false }],
      ['a docs-only run is not resumed by a full-roster round', { securitySeat: false }, { securitySeat: true }],
    ])('%s', async (_name, parkedOpts, nextOpts) => {
      const store = createMemoryRunStore();
      const parked = await round({ store, opts: parkedOpts, runId: 'r-parked' });
      expect(parked.out.stopped).toBe('confirm');
      expect(securitySeatFromRun(store.read('r-parked'))).toBe(parkedOpts.securitySeat);
      const judged = { n: 0 };
      const next = await round({ store, opts: nextOpts, runId: 'r-fresh', resumable: 'r-parked', judged });
      expect(declaresSecuritySeat(next.declaration)).toBe(nextOpts.securitySeat);
      // TWO LAYERS hold this guarantee. `rosterMatches` refuses the resume up front; behind it the engine itself refuses to
      // rewind a run whose steps the declaration no longer matches (the roster moves every later step's index), and the
      // driver's catch turns that refusal into a fresh review. This test pins the guarantee, not one line: the outcome
      // above is fresh either way, and the engine's own refusal is pinned here so the second layer cannot silently go.
      expect(() => rewindRunToStep(store.read('r-parked'), { registry: next.registry, step: RESUME_STEP }))
        .toThrow(/declaration changed under a suspended run/);
      expect(next.out.run.id).toBe('r-fresh');          // a fresh review, not the parked run rewound
      expect(judged.n).toBeGreaterThan(0);              // the panel really sat again
      expect(store.read('r-parked').pending?.kind).toBe('confirm'); // and the parked run was left as it was
    });

    it.each([[{ securitySeat: true }], [{ securitySeat: false }]])('the SAME roster %j still resumes the parked run, with no new panel', async (opts) => {
      const store = createMemoryRunStore();
      await round({ store, opts, runId: 'r-parked' });
      const judged = { n: 0 };
      const next = await round({ store, opts, runId: 'r-must-not-be-minted', resumable: 'r-parked', judged });
      expect(next.out.run.id).toBe('r-parked');
      expect(judged.n).toBe(0);
    });
  });

  it('the roster a saved run reads back as comes from its `read` finding alone', () => {
    const full = { findings: { read: { securitySeat: true }, judge: {} } };
    expect(securitySeatFromRun(full)).toBe(true);
    expect(securitySeatFromRun({ findings: { read: { securitySeat: false }, judge: {} } })).toBe(false);
    // The roster is read off the `read` finding, never off which seats answered: no security finding does not mean none seated.
    expect(securitySeatFromRun({ findings: { read: { securitySeat: true }, judge: {} } })).toBe(true);
    // No recorded roster (nothing judged yet, or a record from before the setting): the full roster.
    expect(securitySeatFromRun({ findings: { judge: {} } })).toBe(true);
    expect(securitySeatFromRun({ findings: {} })).toBe(true);
    expect(securitySeatFromRun(null)).toBe(true);
    expect(securitySeatFromRun({ findings: { read: { securitySeat: 'false' } } })).toBe(true);
  });
});

describe('review.seatsByTouchSet — a rename carries its source path (code moved into a prose path is still code)', () => {
  const RENAME_DIFF = [
    'diff --git a/scripts/operations/review-pr.mjs b/backlog/x-a-card.md',
    'similarity index 100%',
    'rename from scripts/operations/review-pr.mjs',
    'rename to backlog/x-a-card.md',
    '',
  ].join('\n');

  it('renameSourcePaths reads the header lines only: rename, copy, quoted paths, and never a file’s own content', () => {
    expect(renameSourcePaths(RENAME_DIFF)).toEqual(['scripts/operations/review-pr.mjs']);
    expect(renameSourcePaths('copy from scripts/a.mjs\ncopy to docs/a.md\nrename from scripts/b.mjs\nrename to docs/b.md\n')).toEqual(['scripts/a.mjs', 'scripts/b.mjs']);
    expect(renameSourcePaths('rename from "scripts/a\\tb.mjs"\r\n')).toEqual(['scripts/a\tb.mjs']);
    expect(renameSourcePaths('rename from scripts/a.mjs\nrename from scripts/a.mjs\n')).toEqual(['scripts/a.mjs']);
    // A line of file content is prefixed (` `, `+`, `-`), so it cannot pose as a header.
    expect(renameSourcePaths('+rename from scripts/evil.mjs\n rename from scripts/evil2.mjs\n-copy from scripts/evil3.mjs\n')).toEqual([]);
    expect(renameSourcePaths(undefined)).toEqual([]);
    expect(renameSourcePaths('')).toEqual([]);
    // git ends a line at `\n` only: a bare CR, U+2028 or U+2029 inside a content line does not start a header.
    expect(renameSourcePaths('+x\rrename from scripts/evil.mjs\n+y copy from scripts/evil2.mjs\n+z rename from scripts/evil3.mjs\n')).toEqual([]);
    // The first line of the text is a header too; a CRLF header does not carry the CR into the path.
    expect(renameSourcePaths('rename from scripts/a.mjs\r\nrename to docs/a.md\r\n')).toEqual(['scripts/a.mjs']);
  });

  it('a prose roster refuses at `read` when the diff text did not read (rename sources cannot be ruled out)', async () => {
    const judge = scriptedJudge();
    const refused = await loop({ parallel: false, judge, runId: 'r-unscored', opts: { securitySeat: false, diffText: '', diffScored: false } });
    expect(refused.out.code).toBe(1);
    expect(JSON.stringify(refused.out)).toMatch(/did not read/);
    expect(judge.calls).toHaveLength(0);
    // The full roster has nothing to prove, so an unscored diff does not refuse it.
    const full = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-unscored-full', opts: { diffText: '', diffScored: false } });
    expect(full.run.findings).toHaveProperty(SECURITY_SEAT_STEP);
  });

  it('the touch-set read lists the source of a rename as well as its destination, and a prose destination alone no longer buys prose', () => {
    const files = [{ filename: 'backlog/x-a-card.md', previous_filename: 'scripts/operations/review-pr.mjs', status: 'renamed' }, { filename: 'backlog/y.md', status: 'added' }, null, {}];
    expect(pathsWithRenameSources(files)).toEqual(['backlog/x-a-card.md', 'scripts/operations/review-pr.mjs', 'backlog/y.md']);
    expect(pathsWithRenameSources(undefined)).toEqual([]);
    // Through the real chooser: the path-only list is prose (the old behaviour), the list with sources is code.
    expect(chooseSecuritySeat(['--pr=5'], { readChangedFiles: () => ['backlog/x-a-card.md'] }).securitySeat).toBe(false);
    expect(chooseSecuritySeat(['--pr=5'], { readChangedFiles: () => pathsWithRenameSources(files) }).securitySeat).toBe(true);
    // A pure-prose rename stays prose: the source being prose too does not add a seat.
    expect(chooseSecuritySeat(['--pr=5'], { readChangedFiles: () => pathsWithRenameSources([{ filename: 'backlog/b.md', previous_filename: 'backlog/a.md' }]) }).securitySeat).toBe(false);
  });

  it('a prose roster refuses at `read` when the net diff renames code into a prose path (the net list is path-only)', async () => {
    const judge = scriptedJudge();
    const refused = await loop({ parallel: false, judge, runId: 'r-rename', opts: { securitySeat: false, netPaths: PROSE_PATHS, diffText: RENAME_DIFF } });
    expect(refused.out.code).toBe(1);
    expect(JSON.stringify(refused.out)).toMatch(/roster leaves the security juror out/);
    expect(judge.calls).toHaveLength(0);
    // The same prose PR with no rename in its diff proceeds, so the refusal is the rename and nothing else.
    const ok = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-rename-ok', opts: { securitySeat: false, netPaths: PROSE_PATHS } });
    expect(ok.run.findings).not.toHaveProperty(SECURITY_SEAT_STEP);
  });

  it('the rename source is recorded apart: the juror list, citation scope and care-level score stay path-only', async () => {
    const { run } = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-rename-full', opts: { netPaths: PROSE_PATHS, diffText: RENAME_DIFF } });
    expect(run.findings.read.netChangedFiles).toEqual(['backlog/x-a-card.md']);
    expect(run.findings.read.netRenameSources).toEqual(['scripts/operations/review-pr.mjs']);
    // A source the net list already names is not listed twice.
    const dup = await loop({ parallel: false, judge: scriptedJudge(), runId: 'r-rename-dup', opts: { netPaths: ['backlog/x-a-card.md', 'scripts/operations/review-pr.mjs'], diffText: RENAME_DIFF } });
    expect(dup.run.findings.read.netRenameSources).toEqual([]);
  });
});

describe('createSeatLaneProvider — the real provider against a fake lane pool', () => {
  /** A scratch scaffold root whose `scripts/lane-pool.mjs` records its argv and answers as scripted. */
  function fakePool(script) {
    const root = mkdtempSync(join(tmpdir(), 'seat-lane-pool-'));
    mkdirSync(join(root, 'scripts'));
    const log = join(root, 'calls.jsonl');
    writeFileSync(join(root, 'scripts', 'lane-pool.mjs'),
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n${script}\n`);
    const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    return { root, calls };
  }
  const lanePath = mkdtempSync(join(tmpdir(), 'seat-lane-'));
  const WE = 'web-everything/web-everything';

  it('leases a lane the way the review job leases the primary one (same pool, adopted, no base), and releases it by its slug', async () => {
    const pool = fakePool(`if (process.argv[2] === 'acquire') console.log('noise line\\n' + ${JSON.stringify(lanePath)});`);
    const lease = await createSeatLaneProvider({ pr: 4763, repo: WE, root: pool.root }).acquire({ step: 'judge Security!' });
    expect(lease.cwd).toBe(lanePath);
    const [acquire] = pool.calls();
    expect(acquire[0]).toBe('acquire');
    expect(acquire).toEqual(expect.arrayContaining(['--purpose=review-loop-seat', '--wait-ms=0', '--growth-max-new=0', '--adopt']));
    // Never a `--base`: the primary lane is leased without one (`review-job.mjs#acquireLane`), so both seats read the same tree.
    expect(acquire.some((a) => a.startsWith('--base'))).toBe(false);
    const slug = acquire.find((a) => a.startsWith('--session=')).slice('--session='.length);
    expect(slug).toMatch(/^review-seat-4763-judgeSecurity-[0-9a-f]{8}$/);
    await lease.release();
    expect(pool.calls()[1]).toEqual(['release', '--all-pools', `--session=${slug}`]);
  });

  it('answers null — so the seat waits for the primary lane — when the pool has no free lane or prints no path', async () => {
    const none = fakePool('console.error("no free lane"); process.exit(2);');
    expect(await createSeatLaneProvider({ pr: 4763, repo: WE, root: none.root }).acquire({ step: 'judgeSecurity' })).toBeNull();
    const relative = fakePool('console.log("lane-3");');
    expect(await createSeatLaneProvider({ pr: 4763, repo: WE, root: relative.root }).acquire({ step: 'judgeSecurity' })).toBeNull();
    const notConstellation = fakePool('console.log("/x");');
    expect(await createSeatLaneProvider({ pr: 4763, repo: 'someone/else', root: notConstellation.root }).acquire({ step: 'judgeSecurity' })).toBeNull();
    expect(notConstellation.calls()).toEqual([]);
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

describe('createDefaultJudge — a retried seat says so on its telemetry (held item 223)', () => {
  it('carries the provider\'s `attempts` onto the telemetry the run record keeps', async () => {
    const provider = async () => ({ value: { summary: 'ok', findings: [] }, sessionId: 's2', costUsd: 0.2, wallMs: 30_000, attempts: 2 });
    const judge = createDefaultJudge({ provider });
    const { telemetry } = unwrapJudgeOutcome(await judge({ mandate: 'm', input: 'i', shape: { type: 'object' }, lens: 'x', effort: 'low', budget: null }));
    expect(telemetry.attempts).toBe(2);
  });
});
