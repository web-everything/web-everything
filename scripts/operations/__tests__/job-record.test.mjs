/**
 * @file scripts/operations/__tests__/job-record.test.mjs
 * @description #4125 — the job block of a run record: the `host:pid:procStart` handle (a bare pid is never a
 *   handle), the block's validation, and that the run store round-trips a job record through its real
 *   validator (a `job:` op without a valid block is refused).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatJobHandle, parseJobHandle, newJobBlock, validateJobBlock, isJobRecord } from '../job-record.mjs';
import { newJobRunRecord, validateRunRecord } from '../run-record.mjs';
import { daemonJobsDir, daemonJobsRoot, readRun, tryReadRun, writeRun } from '../run-store.mjs';

const START = 'Mon Sep 28 17:23:12 2026';

describe('job handle', () => {
  it('round-trips host:pid:procStart, keeping the colons inside the start time', () => {
    const h = formatJobHandle({ host: 'mac-1.local', pid: 4242, procStart: `  ${START.replace(/ /g, '   ')} ` });
    expect(h).toBe(`mac-1.local:4242:${START}`);
    expect(parseJobHandle(h)).toEqual({ host: 'mac-1.local', pid: 4242, procStart: START });
  });

  it('refuses a bare pid, a missing start time, a zero/negative pid and a host with a colon', () => {
    expect(() => formatJobHandle({ host: 'h', pid: 1 })).toThrow(/bare pid/);
    expect(() => formatJobHandle({ host: 'h', pid: 1, procStart: '   ' })).toThrow(/bare pid/);
    expect(() => formatJobHandle({ host: 'h', pid: 0, procStart: START })).toThrow(/pid/);
    expect(() => formatJobHandle({ host: 'a:b', pid: 1, procStart: START })).toThrow(/host/);
    for (const bad of ['4242', 'h:4242', 'h:4242:', ':4242:x', 'h:04:x', 'h:-1:x', 'h:12a:x', null, 42]) {
      expect(parseJobHandle(bad)).toBeNull();
    }
  });
});

describe('job block validation', () => {
  it('accepts a fresh block and names each malformed field', () => {
    expect(validateJobBlock(newJobBlock({ kind: 'noop' }))).toEqual([]);
    const bad = { ...newJobBlock({ kind: 'noop' }), status: 'running', handle: null, attempts: -1, checkpoint: { step: 'x' } };
    const errors = validateJobBlock(bad).join('\n');
    expect(errors).toMatch(/running job must carry its handle/);
    expect(errors).toMatch(/attempts/);
    expect(errors).toMatch(/checkpoint/);
    expect(validateJobBlock({ ...newJobBlock({ kind: 'noop' }), handle: '4242' }).join()).toMatch(/host:pid:procStart/);
  });

  it('refuses a bad kind or code mode at construction', () => {
    expect(() => newJobBlock({ kind: 'No Spaces' })).toThrow(/kind/);
    expect(() => newJobBlock({ kind: 'ok', codeMode: 'anything' })).toThrow(/codeMode/);
  });
});

describe('job run record', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-job-record-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is a run record with op job:<kind> that the run store writes and reads back', () => {
    const rec = newJobRunRecord({ id: 'job-noop-1', kind: 'noop', input: { a: 1 }, codeSha: 'abc123' });
    expect(isJobRecord(rec)).toBe(true);
    expect(rec.op).toBe('job:noop');
    writeRun(rec, dir);
    expect(readRun('job-noop-1', dir)).toEqual(rec);
  });

  it('refuses a job: op with no job block, and a corrupt job block on read', () => {
    const rec = newJobRunRecord({ id: 'job-noop-2', kind: 'noop' });
    const { job, ...noBlock } = rec;
    expect(validateRunRecord(noBlock).ok).toBe(false);
    writeFileSync(join(dir, 'job-noop-2.json'), JSON.stringify({ ...rec, job: { ...job, status: 'exploded' } }));
    expect(() => tryReadRun('job-noop-2', dir)).toThrow(/refusing to read run/);
  });

  it('non-job run records stay valid without a job block', () => {
    const { job, ...plain } = newJobRunRecord({ id: 'r1', kind: 'noop' });
    expect(validateRunRecord({ ...plain, op: 'land' }).ok).toBe(true);
  });

  it('optional task metadata round-trips and rejects malformed fields', () => {
    const rec = newJobRunRecord({ id: 'task-review-1', kind: 'review' });
    const old = structuredClone(rec);
    expect(rec.job).not.toHaveProperty('task');
    writeRun(rec, dir);
    expect(readRun(rec.id, dir)).toEqual(old);
    const task = {
      id: 'review:owner/repo:42:1', kind: 'review', repo: 'owner/repo', item: 42, seq: 1,
      timeoutMs: 300000, policy: { timeoutMs: 300000 }, sources: { timeoutMs: 'standard' },
      acting: true, actingRepoCap: 1, resourceKind: 'review', failureCount: 0,
      outcome: null, resultRef: null,
    };
    rec.job.task = task;
    writeRun(rec, dir);
    expect(readRun(rec.id, dir).job.task).toEqual(task);
    for (const outcome of ['acted', 'nothing-owed', 'superseded', 'deferred-claim-held', 'deferred-read', 'failed']) {
      expect(validateJobBlock({ ...rec.job, task: { ...task, outcome, resultRef: 'results/task-review-1-1.json' } })).toEqual([]);
    }
    const bad = [
      null, [], {}, { ...task, id: 'review:owner/repo:42:2' }, { ...task, kind: 'other' },
      ...['Owner/repo', '../repo', 'owner/repo/extra', 'owner/repo\n', 'o/'.concat('r'.repeat(101))].map(repo => ({ ...task, repo })),
      ...['item', 'seq'].flatMap(key => [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map(v => ({ ...task, [key]: v }))),
      ...[0, -1, Infinity, NaN, '300000'].map(timeoutMs => ({ ...task, timeoutMs })),
      { ...task, policy: {} }, { ...task, policy: { timeoutMs: 1 } }, { ...task, sources: {} },
      { ...task, sources: { timeoutMs: 'unknown' } }, { ...task, acting: 'yes' },
      ...[0, 1.5, Infinity].map(actingRepoCap => ({ ...task, actingRepoCap })),
      ...[-1, 0.5, Infinity, '0', Number.MAX_SAFE_INTEGER + 1].map(failureCount => ({ ...task, failureCount })),
      { ...task, resourceKind: 'Bad Resource' }, { ...task, outcome: 'success' },
      { ...task, repo: 'owner/repo\n', id: 'review:owner/repo\n:42:1' },
      ...['../escape', '/local/result.json', 'results/../escape', 'results/x.json\n', `results/${'x'.repeat(257)}.json`, 1].map(resultRef => ({ ...task, resultRef })),
    ];
    for (const value of bad) {
      expect(validateJobBlock({ ...rec.job, task: value }).join(), JSON.stringify(value)).toMatch(/task/);
    }
    writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify({ ...rec, job: { ...rec.job, task: {} } }));
    expect(() => readRun(rec.id, dir)).toThrow();
  });
});

describe('daemon jobs dir', () => {
  it('is ~/.claude/daemon-jobs/<daemon> unless WE_DAEMON_JOBS_ROOT moves it, and refuses unsafe names', () => {
    expect(daemonJobsRoot({})).toMatch(/[/\\]\.claude[/\\]daemon-jobs$/);
    expect(daemonJobsDir('drain', { WE_DAEMON_JOBS_ROOT: '/tmp/jobs' })).toBe('/tmp/jobs/drain');
    expect(() => daemonJobsDir('../x', {})).toThrow(/daemon name/);
  });
});
