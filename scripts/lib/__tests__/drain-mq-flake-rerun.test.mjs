import { describe, expect, it, vi } from 'vitest';
import { inspectMqReruns, requestMqReruns } from '../drain-mq-flake-rerun.mjs';

const repo = 'fixture/drain', commit = 'a'.repeat(40);
const check = (id, conclusion = 'failure', start = '2026-11-01T12:00:00Z', end = '2026-11-01T12:01:00Z') => ({
  id: id + 1000, name: 'unit', head_sha: commit, status: 'completed', conclusion,
  started_at: start, completed_at: end,
  details_url: `https://github.com/${repo}/actions/runs/201/job/${id}`,
});
const inspect = checks => inspectMqReruns({ checks, repo, commit, removedAt: Date.parse('2026-11-01T12:02:00Z') });
const later = (id, conclusion) => check(id, conclusion, '2026-11-01T12:03:00Z', '2026-11-01T12:04:00Z');

describe('one-shot MQ rerun requests', () => {
  it('confirms a later completed successful rerun on the same commit without another POST', () => {
    const attempts = inspect([later(41, 'success'), check(21)]);
    expect(attempts.confirmed).toBe(true);
    expect(attempts.candidates).toEqual([]);
    expect(attempts.reason).toBeNull();
    const exec = vi.fn();
    requestMqReruns({ attempts, repo, exec, eligible: true });
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong-commit successor', { head_sha: 'b'.repeat(40) }],
    ['missing-commit successor', { head_sha: undefined }],
    ['in-progress successful successor', { status: 'in_progress' }],
    ['queued successful successor', { status: 'queued' }],
    ['missing-status successor', { status: undefined }],
    ['missing-completion successor', { completed_at: undefined }],
    ['invalid-completion successor', { completed_at: 'not-a-date' }],
    ['null-completion successor', { completed_at: null }],
    ['missing-start successor', { started_at: undefined }],
    ['invalid-start successor', { started_at: 'not-a-date' }],
    ['successor completing before its start', { completed_at: '2026-11-01T12:02:30Z' }],
    ['successor starting before original completion', { started_at: '2026-11-01T12:00:30Z' }],
    ['successor starting at original completion', { started_at: '2026-11-01T12:01:00Z' }],
    ['failed successor', { conclusion: 'failure' }],
    ['neutral successor', { conclusion: 'neutral' }],
    ['skipped successor', { conclusion: 'skipped' }],
    ['cancelled successor', { conclusion: 'cancelled' }],
    ['timed-out successor', { conclusion: 'timed_out' }],
    ['missing-conclusion successor', { conclusion: undefined }],
    ['null-conclusion successor', { conclusion: null }],
    ['wrong-name successor', { name: 'different-unit' }],
    ['wrong-workflow-run successor', { details_url: `https://github.com/${repo}/actions/runs/202/job/41` }],
    ['same-Actions-job successor', { details_url: `https://github.com/${repo}/actions/runs/201/job/21` }],
  ])('rejects %s as rerun confirmation', (_name, overrides) => {
    expect(inspect([check(21), { ...later(41, 'success'), ...overrides }]).confirmed).toBe(false);
  });

  it('rejects ambiguous history with two successful successors', () => {
    expect(inspect([check(21), later(41, 'success'), later(61, 'success')]).confirmed).toBe(false);
  });

  it.each([
    ['mismatched original head_sha', { head_sha: 'b'.repeat(40) }],
    ['missing original head_sha', { head_sha: undefined }],
    ['in-progress original check', { status: 'in_progress' }],
    ['queued original check', { status: 'queued' }],
    ['missing original status', { status: undefined }],
    ['missing original start timestamp', { started_at: undefined }],
    ['null original start timestamp', { started_at: null }],
    ['numeric original start timestamp', { started_at: 1793534400000 }],
    ['invalid original start timestamp', { started_at: 'not-a-date' }],
    ['missing original completion timestamp', { completed_at: undefined }],
    ['null original completion timestamp', { completed_at: null }],
    ['numeric original completion timestamp', { completed_at: 1793534460000 }],
    ['invalid original completion timestamp', { completed_at: 'not-a-date' }],
    ['original completion before its start', { completed_at: '2026-11-01T11:59:00Z' }],
    ['original completion at removal time', { completed_at: '2026-11-01T12:02:00Z' }],
    ['original completion after removal time', { completed_at: '2026-11-01T12:03:00Z' }],
  ])('rejects %s without authorizing or POSTing a rerun', (_name, overrides) => {
    const attempts = inspect([{ ...check(21), ...overrides }]);
    expect(attempts.confirmed).toBe(false);
    expect(attempts.candidates).toEqual([]);
    const exec = vi.fn();
    requestMqReruns({ attempts, repo, exec, eligible: true });
    expect(exec).not.toHaveBeenCalled();
  });

  it('does not POST again while repeated sightings still contain only the original failed job', () => {
    const exec = vi.fn(), scope = () => {};
    for (let sighting = 0; sighting < 3; sighting++)
      requestMqReruns({ attempts: inspect([check(21)]), repo, exec, scope, eligible: true });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][1]).toEqual(['api', '-X', 'POST', `repos/${repo}/actions/jobs/21/rerun`]);
  });

  it('does not repeat an ambiguous POST failure through a replacement live reader', () => {
    const scope = () => {}, first = vi.fn(() => { throw new Error('connection lost'); }), second = vi.fn();
    const attempts = inspect([check(21)]);
    expect(requestMqReruns({ attempts, repo, exec: first, scope, eligible: true }).reason).toMatch(/operator must inspect/);
    requestMqReruns({ attempts, repo, exec: second, scope, eligible: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('a failed second attempt remains failure evidence even after a third attempt succeeds', () => {
    const attempts = inspect([check(21), later(41, 'failure'), later(61, 'success')]);
    expect(attempts.confirmed).toBe(false);
    expect(attempts.candidates).toEqual([]);
    expect(attempts.reason).toMatch(/rerun failed.*operator must inspect/);
    const exec = vi.fn();
    requestMqReruns({ attempts, repo, exec, eligible: true });
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects oversized candidate lists before any POST and names operator inspection', () => {
    const exec = vi.fn();
    const result = requestMqReruns({ attempts: { confirmed: false, candidates: Array.from({ length: 11 }, (_, i) => i + 1) },
      repo, exec, eligible: true });
    expect(result.reason).toMatch(/10-job limit.*operator must inspect/);
    expect(exec).not.toHaveBeenCalled();
  });
});
