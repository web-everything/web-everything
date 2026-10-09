/** @file review-job-envelope.test.mjs — review job results and persisted v2 envelopes. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { reviewJobResult, writeReviewJobStarted, writeReviewJobDone } from '../review-job-envelope.mjs';
import { validateWorkerResult } from '../worker-result.mjs';
import { validateCompletionRecord } from '../completion-record.mjs';
import { tryReadCompletion } from '../completion-store.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'review-envelope-')); dirs.push(d); return d; };
const T0 = () => '2026-10-08T10:00:00.000Z';
const T1 = () => '2026-10-08T10:05:00.000Z';
const BOUNCED = { outcome: 'bounced', loopOutcome: 'complete', runId: 'run-1', label: null };

describe('reviewJobResult', () => {
  it.each(['auto-cleared', 'parked', 'bounced'])('maps a finished %s review to a valid done result', (outcome) => {
    const result = reviewJobResult({ outcome, verdict: 'accept', loopOutcome: 'complete', runId: 'r1' }, { pr: 5, repo: 'o/r' });
    expect(result).toMatchObject({ outcome: 'done', blocker: null });
    expect(validateWorkerResult(result, { role: 'review' }).ok).toBe(true);
  });
  it('maps infrastructure failures to a retryable blocker with evidence', () => {
    const result = reviewJobResult({ outcome: 'blocked-on-infra', label: 'review-loop exit 1: boom' });
    expect(result).toMatchObject({ outcome: 'blocked', blocker: { kind: 'infra-transient', retryable: true } });
    expect(result.blocker.evidence.text).toContain('boom');
    expect(validateWorkerResult(result, { role: 'review' }).ok).toBe(true);
  });
  it('identifies the lane pool on deferral and fails closed on unknown outcomes', () => {
    const deferred = reviewJobResult({ outcome: 'deferred-no-lane' });
    expect(deferred).toMatchObject({ outcome: 'blocked', blocker: { component: 'review-job lane pool' } });
    expect(validateWorkerResult(deferred, { role: 'review' }).ok).toBe(true);
    const unknown = reviewJobResult({ outcome: 'weird' });
    expect(unknown.outcome).toBe('blocked');
    expect(validateWorkerResult(unknown, { role: 'review' }).ok).toBe(true);
  });
});

describe('review job envelope writes', () => {
  it('writes started then done, preserving process identity and legacy words', () => {
    const dir = tmp();
    writeReviewJobStarted({ session: 'review-5', pr: 5, pid: 999, timeoutMs: 600_000, dir, now: T0 });
    const started = tryReadCompletion('review-5', dir);
    expect(started).toMatchObject({ v: 2, status: 'started', launcher: 'node-job', role: 'review', pid: 999, deadlineAt: '2026-10-08T10:10:00.000Z' });
    expect(validateCompletionRecord(started).ok).toBe(true);
    const done = writeReviewJobDone({ session: 'review-5', pr: 5, repo: 'o/r', classified: BOUNCED, dir, now: T1 });
    const expected = {
      v: 2, status: 'done', outcome: 'bounced', verdict: 'complete', runId: 'run-1',
      parse: { ok: true }, result: { outcome: 'done' }, action: { type: expect.any(String) },
      pid: 999, startedAt: started.startedAt,
    };
    expect(done).toMatchObject(expected);
    expect(tryReadCompletion('review-5', dir)).toMatchObject(expected);
    expect(validateCompletionRecord(done).ok).toBe(true);
  });
  it('writes a valid v2 done envelope when no started record exists', () => {
    const dir = tmp();
    expect(tryReadCompletion('review-5', dir)).toBeNull();
    writeReviewJobDone({ session: 'review-5', pr: 5, classified: BOUNCED, dir, now: T1 });
    const done = tryReadCompletion('review-5', dir);
    expect(done).toMatchObject({ v: 2, status: 'done', launcher: 'node-job', parse: { ok: true }, result: { outcome: 'done' } });
    expect(validateCompletionRecord(done)).toEqual({ ok: true, errors: [] });
  });
  it('increments infraStreak across separate started/done generations', () => {
    const dir = tmp();
    for (const [index, now] of [T0, T1].entries()) {
      writeReviewJobStarted({ session: 'review-5', pr: 5, pid: 999, timeoutMs: 600_000, dir, now });
      writeReviewJobDone({ session: 'review-5', pr: 5, classified: { outcome: 'blocked-on-infra' }, dir, now });
      expect(tryReadCompletion('review-5', dir)).toMatchObject({ infraStreak: index + 1, startedAt: now() });
    }
  });
});
