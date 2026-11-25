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

  describe('maxFailures chain (up to 3 failed attempts of one job)', () => {
    const app = { slug: 'github-actions', id: 15368 };
    const at = (min) => `2026-11-01T12:${String(min).padStart(2, '0')}:00Z`;
    // Each attempt id N starts and ends strictly after the previous one; the original (id 21) ends at 12:01.
    const att = (id, conclusion, n) => ({ ...check(id, conclusion, at(3 + 2 * n), at(4 + 2 * n)), app });
    const orig = () => ({ ...check(21), app });
    const run = (checks, maxFailures = 3, extra = {}) => inspectMqReruns({ checks, repo, commit,
      removedAt: Date.parse('2026-11-01T12:02:00Z'), maxFailures, ...extra });

    it('maxFailures 3: two failures then a success on the same run and check confirms', () => {
      const a = run([orig(), att(41, 'failure', 0), att(61, 'success', 1)]);
      expect(a.confirmed).toBe(true);
      expect(a.candidates).toEqual([]);
      expect(a.reason).toBeNull();
      expect(a.failures).toBe(2);
      expect(a.checks.map(c => c.id)).toEqual([1021]);
    });
    it('one failure then a success confirms', () => {
      expect(run([orig(), att(41, 'success', 0)]).confirmed).toBe(true);
    });
    it('a lone original failure makes the original the candidate; F,F makes the second the candidate', () => {
      expect(run([orig()]).candidates).toEqual([21]);
      const a = run([orig(), att(41, 'failure', 0)]);
      expect(a.candidates).toEqual([41]);
      expect(a.confirmed).toBe(false);
      expect(a.reason).toBeNull();
    });
    it('F,F,queued is pending with no candidate', () => {
      const queued = { ...att(61, 'failure', 1), status: 'queued', conclusion: null, completed_at: null };
      const a = run([orig(), att(41, 'failure', 0), queued]);
      expect(a.confirmed).toBe(false);
      expect(a.candidates).toEqual([]);
    });
    it('F,F,F holds at 3/3 and a later green never clears it', () => {
      const three = [orig(), att(41, 'failure', 0), att(61, 'failure', 1)];
      for (const checks of [three, [...three, att(81, 'success', 2)]]) {
        const a = run(checks);
        expect(a.confirmed).toBe(false);
        expect(a.candidates).toEqual([]);
        expect(a.reason).toBe('rerun failed 3/3; operator must inspect failed jobs and enqueue manually');
      }
    });
    it('F,S,F,S is unavailable', () => {
      const a = run([orig(), att(41, 'success', 0), att(61, 'failure', 1), att(81, 'success', 2)]);
      expect(a.confirmed).toBe(false);
      expect(a.candidates).toEqual([]);
    });
    it.each([
      ['unbindable same-name details_url', { details_url: 'https://github.com/other/repo/actions/runs/201/job/41' }],
      ['non-github host', { details_url: `https://example.com/${repo}/actions/runs/201/job/41` }],
      ['bogus url', { details_url: 'not a url' }],
      ['different run id', { details_url: `https://github.com/${repo}/actions/runs/202/job/41` }],
      ['duplicate job id', { details_url: `https://github.com/${repo}/actions/runs/201/job/21` }],
      ['other app slug', { app: { slug: 'evil', id: 15368 } }],
      ['other app id', { app: { slug: 'github-actions', id: 1 } }],
      ['missing app', { app: undefined }],
      ['missing start', { started_at: undefined }],
      ['equal start and previous completion', { started_at: at(1) }],
    ])('refuses a chain with a %s member', (_name, overrides) => {
      const a = run([orig(), { ...att(41, 'success', 0), ...overrides }]);
      expect(a.confirmed).toBe(false);
      expect(a.candidates).toEqual([]);
    });
    it('refuses when a descending job id has ascending times (id order disagrees with time order)', () => {
      // id 11 is a success starting after the failure (id 21) completed: id order says success first.
      const a = run([orig(), { ...att(11, 'success', 0) }]);
      expect(a.confirmed).toBe(false);
      expect(a.candidates).toEqual([]);
    });
    it.each([0, 4, '3', NaN, 1.5, null])('maxFailures %s is unavailable', value => {
      const a = run([orig(), att(41, 'success', 0)], value);
      expect(a.confirmed).toBe(false);
      expect(a.candidates).toEqual([]);
    });
    it('maxFailures 1 keeps the historical reason for F,F,S', () => {
      const a = inspect([check(21), later(41, 'failure'), later(61, 'success')]);
      expect(a.reason).toBe('rerun failed; operator must inspect failed jobs and enqueue manually');
    });
    it('F,F at 3 POSTs only the second job id, once across repeated sightings', () => {
      const exec = vi.fn(), scope = () => {};
      for (let i = 0; i < 3; i++)
        requestMqReruns({ attempts: run([orig(), att(41, 'failure', 0)]), repo, exec, scope, eligible: true });
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][1]).toEqual(['api', '-X', 'POST', `repos/${repo}/actions/jobs/41/rerun`]);
      const dry = vi.fn();
      requestMqReruns({ attempts: run([orig(), att(41, 'failure', 0)]), repo, exec: dry, scope: () => {}, eligible: true, dryRun: true });
      expect(dry).not.toHaveBeenCalled();
    });
  });

  it('rejects oversized candidate lists before any POST and names operator inspection', () => {
    const exec = vi.fn();
    const result = requestMqReruns({ attempts: { confirmed: false, candidates: Array.from({ length: 11 }, (_, i) => i + 1) },
      repo, exec, eligible: true });
    expect(result.reason).toMatch(/10-job limit.*operator must inspect/);
    expect(exec).not.toHaveBeenCalled();
  });
});
