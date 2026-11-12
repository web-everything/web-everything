// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { markInfraOnlyRuns } from '../main-ci-infra-runs.mjs';
import { mainRedState } from '../../conveyor/main-ci-red-core.mjs';
import { readMainCiFact } from '../../merge-gate-check.mjs';

const repo = 'owner/repo';
const green = { databaseId: 1, headSha: 'aaaaaaa', status: 'completed', conclusion: 'success', createdAt: '2026-11-10T00:00:00Z' };
const failure = (id = 2) => ({ databaseId: id, headSha: 'bbbbbbb', status: 'completed', conclusion: 'failure', createdAt: `2026-11-10T${String(id).padStart(2, '0')}:00:00Z` });
const page = (conclusions, total = conclusions.length) => ({ total_count: total,
  jobs: conclusions.map((conclusion, id) => ({ id, name: `test-shard-${id}`, status: conclusion == null ? 'in_progress' : 'completed', conclusion, run_attempt: 1 })) });
const jobsExec = (data) => vi.fn((bin, args) => {
  expect(bin).toBe('gh');
  expect(args[0]).toBe('api');
  expect(args[1]).toMatch(/^repos\/owner\/repo\/actions\/runs\/\d+\/attempts\/1\/jobs\?per_page=100$/);
  return JSON.stringify(data);
});

describe('markInfraOnlyRuns', () => {
  it('counts a never-started (queued, no conclusion) job as infra, with the cancelled ones', () => {
    const runs = [failure(), green];
    markInfraOnlyRuns(runs, { repo, exec: jobsExec({ total_count: 3, jobs: [{ id: 1, status: 'completed', conclusion: 'success', run_attempt: 1 }, { id: 2, status: 'completed', conclusion: 'cancelled', run_attempt: 1 }, { id: 3, status: 'queued', conclusion: null, run_attempt: 1 }] }) });
    expect(runs[0].infraOnly).toBe(true);
  });
  it('stays red when a job is still running (a re-run began between the list and jobs reads) or from another attempt', () => {
    for (const data of [page(['cancelled', null]), { total_count: 1, jobs: [{ id: 1, status: 'completed', conclusion: 'cancelled', run_attempt: 2 }] }]) {
      const runs = [failure(), green];
      markInfraOnlyRuns(runs, { repo, exec: jobsExec(data) });
      expect(runs[0].infraOnly).toBeUndefined();
    }
  });
  it('keeps a re-run (attempt > 1) red: an inconclusive re-run cannot erase an earlier genuine failure', () => {
    const runs = [{ ...failure(), attempt: 2 }, green];
    const exec = jobsExec(page(['cancelled', 'cancelled']));
    markInfraOnlyRuns(runs, { repo, exec });
    expect(runs[0].infraOnly).toBeUndefined();
    expect(mainRedState(runs).status).toBe('red');
    expect(exec).not.toHaveBeenCalled();
  });
  it('marks an all-cancelled failure run infra-only so mainRedState is not red', () => {
    const runs = [failure(), green];
    const exec = jobsExec(page(['cancelled', 'cancelled']));
    expect(markInfraOnlyRuns(runs, { repo, exec })).toBe(runs);
    expect(runs[0].infraOnly).toBe(true);
    expect(mainRedState(runs).status).toBe('green');
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['a failed job', page(['cancelled', 'failure'])],
    ['a timed out job', page(['timed_out'])],
    ['zero jobs (startup_failure)', page([])],
    ['an incomplete job list', page(['cancelled'], 2)],
    ['a null jobs response', null],
  ])('keeps %s red', (label, data) => {
    const runs = [failure(), green];
    if (label.startsWith('zero')) runs[0].conclusion = 'startup_failure';
    markInfraOnlyRuns(runs, { repo, exec: jobsExec(data) });
    expect(runs[0].infraOnly).toBeUndefined();
    expect(mainRedState(runs).status).toBe('red');
  });
  it('keeps a throwing jobs read red and never throws', () => {
    const runs = [failure(), green];
    expect(markInfraOnlyRuns(runs, { repo, exec: () => { throw new Error('unreadable'); } })).toBe(runs);
    expect(mainRedState(runs).status).toBe('red');
  });
  it('bounds reads at maxReads and retains the merge hold for uninspected runs', () => {
    const runs = [failure(7), failure(6), failure(5), failure(4), failure(3), failure(2), green];
    const exec = jobsExec(page(['cancelled']));
    markInfraOnlyRuns(runs, { repo, exec });
    expect(exec).toHaveBeenCalledTimes(4);
    expect(runs.slice(0, 4).every((run) => run.infraOnly === true)).toBe(true);
    expect(runs[4].infraOnly).toBeUndefined();
    expect(mainRedState(runs).status).toBe('red');
  });
  it('honors an explicit read budget, including unreadable reads', () => {
    const runs = [failure(4), failure(3), failure(2), green];
    const exec = vi.fn(() => { throw new Error('unreadable'); });
    markInfraOnlyRuns(runs, { repo, exec, maxReads: 2 });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(mainRedState(runs).status).toBe('red');
  });
  it('stops at the first green and skips ignored runs', () => {
    const runs = [{ ...failure(4), conclusion: 'cancelled' }, failure(3), green, failure(2)];
    const exec = jobsExec(page(['cancelled']));
    markInfraOnlyRuns(runs, { repo, exec });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(runs[1].infraOnly).toBe(true);
    expect(runs[3].infraOnly).toBeUndefined();
  });
  it('does not read jobs with a zero budget and tolerates non-array input', () => {
    const exec = vi.fn();
    const runs = [failure()];
    expect(markInfraOnlyRuns(runs, { repo, exec, maxReads: 0 })).toBe(runs);
    expect(markInfraOnlyRuns(null, { repo, exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('readMainCiFact infrastructure evidence', () => {
  it.each([
    ['all cancelled jobs', page(['cancelled', 'cancelled']), false],
    ['a failed job', page(['cancelled', 'failure']), true],
  ])('reports the expected red verdict for %s', (_label, data, red) => {
    const apiExec = jobsExec(data);
    const exec = vi.fn((bin, args, options) => {
      if (args[0] === 'run') return JSON.stringify([failure(), green]);
      return apiExec(bin, args, options);
    });
    expect(readMainCiFact({ repo, exec }).red).toBe(red);
    expect(apiExec).toHaveBeenCalledTimes(1);
  });
});
