import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepPrCancelledRerun, formatPrCancelledReport } from '../pr-cancelled-rerun.mjs';
import { main } from '../ci-red-recovery-watch.mjs';

const repo = 'web-everything/web-everything';
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const now = Date.parse('2026-10-26T12:00:00Z');
const key = (pr = 42, head = sha) => `${repo}#${pr}@${head}`;
const check = (name, conclusion = 'SUCCESS', overrides = {}) => ({
  __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion,
  startedAt: '2026-10-26T11:00:00Z', completedAt: '2026-10-26T11:10:00Z', ...overrides,
});
const pr = (overrides = {}) => ({
  number: 42, state: 'OPEN', headRefName: 'lane/cancelled', headRefOid: sha, baseRefName: 'main',
  statusCheckRollup: [check('smoke', 'CANCELLED'), check('test'), check('lint', 'SKIPPED')],
  ...overrides,
});
const run = (overrides = {}) => ({
  databaseId: 123, headSha: sha, headBranch: 'lane/cancelled', workflowName: 'CI',
  status: 'completed', conclusion: 'cancelled', createdAt: '2026-10-26T11:00:00Z',
  updatedAt: '2026-10-26T11:10:00Z', ...overrides,
});
const job = (duration = 30_000) => ({
  databaseId: 456, name: 'smoke', status: 'completed', conclusion: 'cancelled',
  startedAt: new Date(now - 900_000).toISOString(),
  completedAt: new Date(now - 900_000 + duration).toISOString(),
});
const action = (overrides = {}) => ({ action: 'pr-cancelled-rerun', pr: 42, sha, runId: 123, ...overrides });

let scratch;
beforeEach(() => { scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pr-cancelled-rerun-')); });
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

// All production IO is replaced. The only real filesystem operations create and
// remove this test's private temporary directory; records themselves stay in memory.
function fixture({ prs = [pr()], runs = [run()], initial = {}, jobs = [] } = {}) {
  let record = structuredClone(initial);
  const options = {
    repo, now, apply: true, requiredChecks: ['smoke', 'test', 'lint'],
    recordPath: join(scratch, 'pr-cancelled-rerun.json'),
    readOpenPrs: vi.fn(() => prs), readRuns: vi.fn(() => runs), readJobs: vi.fn(() => jobs),
    rerunFailed: vi.fn(() => ({ ok: true })),
    readRecord: vi.fn(() => structuredClone(record)),
    writeRecord: vi.fn((_path, value) => { record = structuredClone(value); }),
    lock: vi.fn((_path, fn) => ({ locked: true, value: fn() })), emitEvent: vi.fn(),
  };
  return { options, prs, runs, record: () => structuredClone(record), tick: () => sweepPrCancelledRerun(options) };
}

function expectNoMutation(f) {
  expect(f.options.rerunFailed).not.toHaveBeenCalled();
  expect(f.options.writeRecord).not.toHaveBeenCalled();
  expect(f.options.emitEvent).not.toHaveBeenCalled();
}

describe('PR cancelled required-check rerun acceptance', () => {
  it('reruns an eligible head exactly once, reserves before submission, and emits pr-ci-cancelled-rerun', () => {
    const f = fixture({ runs: [run({ databaseId: 122, conclusion: 'success', createdAt: '2026-10-26T10:00:00Z' }), run()] });
    f.options.rerunFailed.mockImplementation(() => {
      expect(f.options.writeRecord).toHaveBeenCalled();
      expect(f.record()[key()]).toMatchObject({ runId: 123, reserved: true });
      return { ok: true };
    });
    const result = f.tick();
    expect(result.dispatch).toEqual([expect.objectContaining(action({ cancelReason: 'unknown' }))]);
    expect(result.refusals).toEqual([]);
    expect(result.applied).toEqual([expect.objectContaining(action({ ok: true }))]);
    expect(f.options.rerunFailed).toHaveBeenCalledOnce();
    expect(f.options.rerunFailed).toHaveBeenCalledWith(123, { repo });
    expect(f.options.readRecord).toHaveBeenCalledWith(f.options.recordPath);
    expect(f.options.writeRecord.mock.calls[0]).toEqual([
      f.options.recordPath, expect.objectContaining({ [key()]: expect.objectContaining({ runId: 123, reserved: true }) }),
    ]);
    expect(f.record()[key()]).toMatchObject({ runId: 123 });
    expect(f.record()[key()].reserved).not.toBe(true);
    expect(f.options.emitEvent).toHaveBeenCalledOnce();
    expect(f.options.emitEvent).toHaveBeenCalledWith({
      kind: 'pr-ci-cancelled-rerun', detail: expect.objectContaining({ pr: 42, sha, runId: 123, cancelReason: 'unknown' }),
    });
  });

  it.each(['queued', 'in_progress'])('refuses later-run-exists when a later same-head run is %s', status => {
    const f = fixture({ runs: [run(), run({ databaseId: 124, status, conclusion: null, createdAt: '2026-10-26T11:20:00Z' })] });
    const result = f.tick();
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'later-run-exists' })]));
    expectNoMutation(f);
  });

  it.each(['success', 'failure', 'skipped'])('does not revive an old cancellation after a newer completed %s run', conclusion => {
    // Deliberately unsorted: input order must not make the old cancellation newest.
    const f = fixture({ runs: [run({ databaseId: 124, conclusion, createdAt: '2026-10-26T11:20:00Z' }), run()] });
    expect(f.tick().dispatch).toEqual([]);
    expectNoMutation(f);
  });

  it('allows only one rerun per repo/PR/head record, including after a restart', () => {
    const f = fixture();
    f.tick();
    const saved = f.record();
    expect(saved[key()]).toBeDefined();
    expect(f.tick().refusals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'already-rerun' })]));
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(1);
    const restarted = fixture({ initial: saved });
    expect(restarted.tick().refusals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'already-rerun' })]));
    expectNoMutation(restarted);
  });

  it('gives a new head SHA on the same PR a fresh rerun allowance', () => {
    const f = fixture();
    f.tick();
    f.prs[0] = pr({ headRefOid: nextSha });
    f.runs[0] = run({ databaseId: 124, headSha: nextSha });
    expect(f.tick().dispatch).toEqual([expect.objectContaining(action({ sha: nextSha, runId: 124 }))]);
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(2);
    expect(f.options.rerunFailed).toHaveBeenLastCalledWith(124, { repo });
    expect(f.record()[key()]).toBeDefined();
    expect(f.record()[key(42, nextSha)]).toBeDefined();
  });

  it.each(['FAILURE', 'TIMED_OUT', 'ERROR'])('leaves a required %s to ci-heal without recording a rerun', conclusion => {
    const f = fixture({ prs: [pr({ statusCheckRollup: [check('smoke', conclusion), check('test'), check('lint')] })] });
    expect(f.tick().dispatch).toEqual([]);
    expect(f.record()).toEqual({});
    expectNoMutation(f);
  });

  it.each(['FAILURE', 'TIMED_OUT', 'ERROR'])('refuses mixed required cancellation and %s', conclusion => {
    const f = fixture({ prs: [pr({ statusCheckRollup: [check('smoke', 'CANCELLED'), check('test', conclusion), check('lint')] })] });
    expect(f.tick().dispatch).toEqual([]);
    expect(f.record()).toEqual({});
    expectNoMutation(f);
  });

  it('ignores cancellation of an optional check', () => {
    const f = fixture({ prs: [pr({ statusCheckRollup: [check('smoke'), check('test'), check('lint'), check('optional', 'CANCELLED')] })] });
    expect(f.tick().dispatch).toEqual([]);
    expectNoMutation(f);
  });

  it('uses the latest rollup row rather than an older cancellation of the same required check', () => {
    const f = fixture({ prs: [pr({ statusCheckRollup: [
      check('smoke', 'SUCCESS', { startedAt: '2026-10-26T11:20:00Z', completedAt: '2026-10-26T11:25:00Z' }),
      check('smoke', 'CANCELLED'), check('test'), check('lint'),
    ] })] });
    expect(f.tick().dispatch).toEqual([]);
    expectNoMutation(f);
  });

  it.each(['throws', 'null', 'invalid'])('fails closed on unreadable runs (%s)', mode => {
    const f = fixture();
    f.options.readRuns.mockImplementation(() => {
      if (mode === 'throws') throw Error('runs unreadable');
      return mode === 'null' ? null : { unexpected: 'shape' };
    });
    const result = f.tick();
    expect(result.dispatch).toEqual([]);
    expect(result.refusals.length).toBeGreaterThan(0);
    expectNoMutation(f);
  });

  it('fails closed on an unreadable record', () => {
    const f = fixture();
    f.options.readRecord.mockImplementation(() => { throw Error('record unreadable'); });
    const result = f.tick();
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'record-unreadable' })]));
    expectNoMutation(f);
  });

  it.each([null, [], 'invalid json', { [key()]: {} }].map(initial => ({ initial })))(
    'fails closed on invalid persisted record %#', ({ initial }) => {
    const f = fixture({ initial });
    const result = f.tick();
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'record-unreadable' })]));
    expectNoMutation(f);
    },
  );

  it('refuses without submitting or writing when the lock is not obtained', () => {
    const f = fixture();
    f.options.lock.mockReturnValue({ locked: false });
    const result = f.tick();
    expect(f.options.lock).toHaveBeenCalledOnce();
    expect(result.dispatch).toEqual([]);
    expect(result.refusals.length).toBeGreaterThan(0);
    expectNoMutation(f);
  });

  it.each([undefined, null, '', 0, -1, 1.5, 'not-a-run-id', '123; touch sentinel', Number.MAX_SAFE_INTEGER + 1])(
    'refuses a missing or invalid run ID (%s)', databaseId => {
      const f = fixture({ runs: [run({ databaseId })] });
      const result = f.tick();
      expect(result.dispatch).toEqual([]);
      expect(result.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'invalid-run-id' })]));
      expectNoMutation(f);
    },
  );

  it.each([undefined, 2])('caps an oversized sweep at maxPerTick (configured: %s; default: 3)', maxPerTick => {
    const cap = maxPerTick ?? 3;
    const prs = Array.from({ length: 5 }, (_, i) => pr({ number: 42 + i, headRefOid: String(i + 1).repeat(40), headRefName: `lane/p${i}` }));
    const runs = prs.map((p, i) => run({ databaseId: 123 + i, headSha: p.headRefOid, headBranch: p.headRefName }));
    const f = fixture({ prs, runs });
    if (maxPerTick !== undefined) f.options.maxPerTick = maxPerTick;
    const result = f.tick();
    expect(result.dispatch).toHaveLength(cap);
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(cap);
    expect(Object.keys(f.record())).toHaveLength(cap);
    const capped = result.refusals.filter(r => r.reason === 'tick-cap');
    expect(capped).toHaveLength(prs.length - cap);
    // Excess heads remain available to a subsequent sweep instead of consuming a record.
    expect(f.tick().dispatch).toHaveLength(Math.min(cap, prs.length - cap));
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(cap + Math.min(cap, prs.length - cap));
  });

  it.each([undefined, false])('rolls back a confirmed rerun rejection (uncertain: %s) so the next sweep retries', uncertain => {
    const f = fixture();
    f.options.rerunFailed.mockReturnValueOnce({ ok: false, uncertain, error: 'rerun denied' });
    expect(f.tick().applied).toEqual([expect.objectContaining({ ok: false })]);
    expect(f.record()).toEqual({});
    expect(f.options.emitEvent).not.toHaveBeenCalled();
    expect(f.tick().dispatch).toEqual([expect.objectContaining(action())]);
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(2);
  });

  it('retains an uncertain reservation and reports rerun-outcome-unknown without resubmitting', () => {
    const f = fixture();
    f.options.rerunFailed.mockReturnValueOnce({ ok: false, uncertain: true, error: 'acknowledgement lost' });
    expect(f.tick().applied).toEqual([expect.objectContaining({ ok: false })]);
    expect(f.record()[key()]).toMatchObject({ runId: 123, reserved: true });
    const second = f.tick();
    expect(second.dispatch).toEqual([]);
    expect(second.refusals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'rerun-outcome-unknown' })]));
    expect(f.options.rerunFailed).toHaveBeenCalledOnce();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
    const restarted = fixture({ initial: f.record() });
    expect(restarted.tick().refusals).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'rerun-outcome-unknown' })]));
    expectNoMutation(restarted);
  });

  it.each([595_000, 600_000])('attributes a cancelled job lasting %sms to job-timeout in the dispatch and event', duration => {
    const f = fixture({ jobs: [job(duration)] });
    expect(f.tick().dispatch).toEqual([expect.objectContaining(action({ cancelReason: 'job-timeout' }))]);
    expect(f.options.readJobs).toHaveBeenCalledOnce();
    expect(f.options.readJobs.mock.calls[0][0]).toBe(123);
    expect(f.options.emitEvent).toHaveBeenCalledWith({ kind: 'pr-ci-cancelled-rerun',
      detail: expect.objectContaining({ pr: 42, sha, runId: 123, cancelReason: 'job-timeout' }) });
  });

  it('attributes a short cancelled job to superseded-by-newer-run when a different head ran on the same ref', () => {
    // A newer run of THIS head blocks rerunning; a newer head on the same ref
    // explains cancellation without satisfying that same-head refusal condition.
    const f = fixture({ jobs: [job()], runs: [run(), run({ databaseId: 124, headSha: nextSha,
      conclusion: 'success', createdAt: '2026-10-26T11:20:00Z' })] });
    expect(f.tick().dispatch).toEqual([expect.objectContaining(action({ cancelReason: 'superseded-by-newer-run' }))]);
    expect(f.options.emitEvent).toHaveBeenCalledWith({ kind: 'pr-ci-cancelled-rerun',
      detail: expect.objectContaining({ cancelReason: 'superseded-by-newer-run' }) });
  });

  it.each([30_000, 594_999])('reports unknown for a short cancelled job (%sms) without a newer same-ref run', duration => {
    const f = fixture({ jobs: [job(duration)], runs: [run(), run({ databaseId: 124, headSha: nextSha,
      headBranch: 'lane/unrelated', createdAt: '2026-10-26T11:20:00Z', conclusion: 'success' })] });
    expect(f.tick().dispatch).toEqual([expect.objectContaining(action({ cancelReason: 'unknown' }))]);
  });

  it('does not infer a timeout from a long successful job', () => {
    const f = fixture({ jobs: [{ ...job(600_000), conclusion: 'success' }] });
    expect(f.tick().dispatch).toEqual([expect.objectContaining(action({ cancelReason: 'unknown' }))]);
  });

  it('lists a dry-run dispatch without rerunning, writing, or emitting an action event', () => {
    const f = fixture();
    f.options.apply = false;
    const result = f.tick();
    expect(result.dispatch).toEqual([expect.objectContaining(action())]);
    expect(result.applied).toEqual([]);
    expect(f.record()).toEqual({});
    expectNoMutation(f);
  });
});

describe('PR cancelled report acceptance', () => {
  it.each(['job-timeout', 'superseded-by-newer-run', 'unknown'])('prints %s with the action, PR, SHA, and run on one line', cancelReason => {
    const report = formatPrCancelledReport({ dispatch: [action({ cancelReason })], refusals: [], applied: [] });
    expect(report.trim().split('\n')).toHaveLength(1);
    for (const value of ['pr-cancelled-rerun', '42', sha, '123', cancelReason]) expect(report).toContain(value);
  });

  it('strips terminal control characters and embedded newlines from report data', () => {
    const report = formatPrCancelledReport({ dispatch: [action({
      cancelReason: 'job-timeout\n\r\x1b[31m\x00\x07\x7f',
    })], refusals: [], applied: [] });
    expect(report.trim().split('\n')).toHaveLength(1);
    expect(report).toContain('job-timeout');
    expect(report.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });
});

describe('PR cancelled sweep CLI wiring acceptance', () => {
  function cli() {
    const pass = () => vi.fn(() => ({ dispatch: [], refusals: [], applied: [] }));
    return {
      sweepOptions: { repo, exhaustedRetrySettings: {} },
      sweepMainRed: pass(), sweepExhausted: pass(), sweepHung: pass(), sweepMissingRun: pass(),
      sweepMainCancelled: pass(), sweepPrCancelled: pass(), writeAll: vi.fn(), writeLine: vi.fn(),
    };
  }

  it('invokes sweepPrCancelled once and includes its result as prCancelledRerun in sweep --json', async () => {
    const deps = cli();
    const expected = { dispatch: [action({ cancelReason: 'unknown' })], refusals: [], applied: [] };
    deps.sweepPrCancelled.mockReturnValue(expected);
    const previousExitCode = process.exitCode;
    try {
      await main(['sweep', '--json'], deps);
      expect(deps.sweepPrCancelled).toHaveBeenCalledOnce();
      expect(deps.sweepPrCancelled.mock.calls[0][0]).toMatchObject({ apply: false });
      expect(deps.writeAll).toHaveBeenCalledOnce();
      expect(JSON.parse(deps.writeAll.mock.calls[0][1]).prCancelledRerun).toEqual(expected);
    } finally { process.exitCode = previousExitCode; }
  });

  it('isolates a throwing sweepPrCancelled and still executes and reports every other pass', async () => {
    const deps = cli();
    deps.sweepPrCancelled.mockImplementation(() => { throw Error('PR cancelled read failed'); });
    const previousExitCode = process.exitCode;
    try {
      await main(['sweep', '--json'], deps);
      expect(deps.sweepPrCancelled).toHaveBeenCalledOnce();
      const report = JSON.parse(deps.writeAll.mock.calls[0][1]);
      expect(report.prCancelledRerun.error).toContain('PR cancelled read failed');
      for (const [pass, field] of [
        ['sweepMainRed', 'mainRedRecovery'], ['sweepExhausted', 'exhaustedRetry'],
        ['sweepHung', 'hungRecovery'], ['sweepMissingRun', 'missingRunRecovery'],
        ['sweepMainCancelled', 'mainCancelledRetrigger'],
      ]) {
        expect(deps[pass]).toHaveBeenCalledOnce();
        expect(report[field]).toEqual({ dispatch: [], refusals: [], applied: [] });
      }
      expect(process.exitCode).toBe(1);
      expect(deps.writeLine.mock.calls.some(([, line]) => line.includes('PR cancelled read failed'))).toBe(true);
    } finally { process.exitCode = previousExitCode; }
  });
});
