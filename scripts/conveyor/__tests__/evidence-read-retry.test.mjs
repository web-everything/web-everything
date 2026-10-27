import { describe, it, expect, vi } from 'vitest';
import { isEvidenceReadTimeout, EVIDENCE_READ_BACKOFF_MS } from '../evidence-read-retry.mjs';
import { enrichPrsWithMainRedFacts, readTimeoutEvidence } from '../reconcile-pass.mjs';
import { planReconcile, REFUSAL_KINDS } from '../reconcile-core.mjs';

const head = 'a'.repeat(40);
const repo = 'web-everything/web-everything';
const pr = { number: 5987, headRefOid: head };
const timeoutError = () => Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
const goTimeoutError = () => Object.assign(new Error('Command failed: gh api repos/x/y'), {
  stderr: Buffer.from('Get "https://api.github.com/repos/x/y": dial tcp 140.82.112.6:443: i/o timeout\n'),
});
const misleadingCheckNames = [
  'CI timed out', 'ETIMEDOUT', 'CI\nspawnSync gh ETIMEDOUT', 'CI\r\u2028timed out',
  'Get "https://api.github.com": dial tcp: i/o timeout',
  'CI\nGet "https://api.github.com": dial tcp: i/o timeout',
  'CI\rGet "https://api.github.com": dial tcp: i/o timeout',
  'CI\u2028Get "https://api.github.com": dial tcp: i/o timeout',
  '`timed out`', '"timed out"', '--ETIMEDOUT', '../timed out',
  '\u200btimed out', 'ＣＩ timed out', 'CI timed' + ' out',
];

describe('evidence-read timeout is unknown, never ineligible', () => {
  it('classifies only timeouts as read timeouts', () => {
    expect(isEvidenceReadTimeout(timeoutError())).toBe(true);
    expect(isEvidenceReadTimeout(new Error('spawnSync gh ETIMEDOUT'))).toBe(true);
    expect(isEvidenceReadTimeout(new Error('evidence-read-deadline'))).toBe(true);
    expect(isEvidenceReadTimeout(new Error('stale-head'))).toBe(false);
    expect(isEvidenceReadTimeout(new Error('incomplete-diff'))).toBe(false);
  });

  it.each(misleadingCheckNames)('does not classify validation data as a timeout: %j', (name) => {
    expect(isEvidenceReadTimeout(new Error(`unparseable-required-check-url:${name}`))).toBe(false);
  });

  it('keeps Go network timeouts retryable', () => {
    expect(isEvidenceReadTimeout(new Error('Get "https://api.github.com/repos/x/y": dial tcp 140.82.112.6:443: i/o timeout'))).toBe(true);
    expect(isEvidenceReadTimeout(new Error('Get "https://api.github.com/repos/x/y": net/http: TLS handshake timeout'))).toBe(true);
    expect(isEvidenceReadTimeout(new Error('Get "https://api.github.com/repos/x/y": context deadline exceeded (Client.Timeout exceeded while awaiting headers)'))).toBe(true);
    expect(isEvidenceReadTimeout(new Error('Get "https://api.github.com/repos/x/y": dial tcp 140.82.112.6:443: connect: operation timed out'))).toBe(true);
    expect(isEvidenceReadTimeout(Object.assign(new Error('Command failed: gh api repos/x/y'), {
      stderr: Buffer.from('Get "https://api.github.com/repos/x/y": dial tcp 140.82.112.6:443: i/o timeout\n'),
    }))).toBe(true);
    expect(isEvidenceReadTimeout(new Error('Get "https://api.github.com/repos/timed out/x": no such host'))).toBe(false);
    expect(isEvidenceReadTimeout(new SyntaxError('Unexpected token in "CI timed out"'))).toBe(false);
  });

  it.each(misleadingCheckNames)('keeps malformed check %j ineligible so ordinary ci-heal can proceed', (name) => {
    const pause = vi.spyOn(Atomics, 'wait').mockReturnValue('ok');
    try {
      const readJobAttempt = vi.fn();
      const p = {
        ...pr, state: 'OPEN', headRefName: 'lane/x', labels: [], comments: [], mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name, status: 'completed', conclusion: 'failure', detailsUrl: '' }],
      };
      const { prs, ...mainFacts } = enrichPrsWithMainRedFacts([p], {
        repo, requiredChecks: [name], readJobAttempt, readBudget: () => ({ confirmed: 0, pending: false }),
        readMainRuns: () => [{ status: 'completed', conclusion: 'success', headSha: 'b'.repeat(40), updatedAt: '2026-10-26T19:00:00Z' }],
        readAheadBy: () => 1, readMainLatestCheckRuns: () => [], readMainFixedSignatureFacts: () => null,
      });
      expect(prs[0].owedCiRerunRetry).toEqual({ eligible: false, reason: `unparseable-required-check-url:${name}` });
      expect(readJobAttempt).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      const out = planReconcile({ prs, ...mainFacts, now: Date.parse('2026-10-26T20:00:00Z'),
        requiredChecks: [name], reviewTiming: { startAfter: 'ci-green' } });
      expect(out.refusals.map(r => r.kind)).not.toContain('timeout-evidence-unknown');
      expect(out.dispatch.map(d => d.kind)).toContain('ci-heal');
    } finally {
      pause.mockRestore();
    }
  });

  it.each([timeoutError, goTimeoutError])('retries a timed-out read with bounded backoff, then returns unknown (not a plain ineligible reason): %s', (error) => {
    const exec = vi.fn(() => { throw error(); });
    const sleep = vi.fn();
    const result = readTimeoutEvidence(pr, { repo, exec, sleep, facts: () => null });
    expect(result).toMatchObject({ eligible: false, unknown: true });
    expect(result.reason).toMatch(/^timeout-evidence-unknown:/);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(EVIDENCE_READ_BACKOFF_MS).toEqual([500, 1500, 4000]);
    expect(sleep.mock.calls).toEqual([[500], [1500], [4000]]);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual(EVIDENCE_READ_BACKOFF_MS);
    expect(Math.max(...EVIDENCE_READ_BACKOFF_MS)).toBeLessThanOrEqual(5000);
  });

  it('a later successful read yields a real cause, not unknown', () => {
    let n = 0;
    const exec = vi.fn(() => {
      if (++n === 1) throw timeoutError();
      return JSON.stringify({ head: { sha: 'b'.repeat(40) }, state: 'open' });
    });
    const result = readTimeoutEvidence(pr, { repo, exec, sleep: vi.fn(), facts: () => null });
    expect(result.unknown).toBeUndefined();
    expect(result).toMatchObject({ eligible: false, reason: 'timeout-evidence:stale-head' });
  });

  it.each([new Error('HTTP 404'), new SyntaxError('Unexpected token in "CI timed out"')])('a non-timeout failure is not retried: %s', (error) => {
    const exec = vi.fn(() => { throw error; });
    const sleep = vi.fn();
    const result = readTimeoutEvidence(pr, { repo, exec, sleep, facts: () => null });
    expect(result.unknown).toBeUndefined();
    expect(result).toEqual({ eligible: false, reason: `timeout-evidence:${error.message}` });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('recovers eligible evidence after a transient timeout and stops retrying', () => {
    const prefix = `repos/${repo}`;
    const pull = { head: { sha: head }, base: { sha: 'b'.repeat(40) }, state: 'open', changed_files: 0 };
    const data = {
      [`${prefix}/pulls/${pr.number}`]: pull,
      [`${prefix}/pulls/${pr.number}/files?per_page=100&page=1`]: [],
      [`${prefix}/commits/${head}/check-runs?per_page=100&page=1&filter=latest`]: {
        total_count: 1,
        check_runs: [{ id: 20, name: 'test-shard (1)', status: 'completed', conclusion: 'cancelled',
          details_url: `https://github.com/${repo}/actions/runs/10/job/20` }],
      },
      [`${prefix}/commits/${head}/status`]: { total_count: 0 },
      [`${prefix}/actions/jobs/20`]: { id: 20, name: 'test-shard (1)', run_id: 10,
        head_sha: head, run_attempt: 1, status: 'completed', conclusion: 'cancelled' },
      [`${prefix}/actions/runs/10`]: { id: 10, head_sha: head, run_attempt: 1,
        repository: { full_name: repo }, path: '.github/workflows/ci.yml' },
    };
    const exec = vi.fn((_cmd, args) => {
      if (!Object.hasOwn(data, args[1])) throw new Error(`unexpected evidence read: ${args[1]}`);
      return JSON.stringify(data[args[1]]);
    }).mockImplementationOnce(() => { throw timeoutError(); });
    const sleep = vi.fn();
    const result = readTimeoutEvidence(pr, { repo, exec, sleep, facts: () => null });
    expect(result).toMatchObject({ eligible: true, infraCancelled: true, repo, pr: pr.number, head,
      jobs: [{ repo, head, run: 10, job: 20, attempt: 1 }] });
    expect(result.unknown).toBeUndefined();
    expect(sleep.mock.calls).toEqual([[500]]);
    expect(exec).toHaveBeenCalledTimes(8);
    expect(exec.mock.calls.filter(([, args]) => args[1] === `${prefix}/pulls/${pr.number}`)).toHaveLength(3);
  });

  it('core: unknown evidence emits its own event, is never timeout-retry-ineligible, and never heals blindly', () => {
    const p = {
      number: 5987, state: 'OPEN', headRefName: 'lane/x', headRefOid: head, labels: [], comments: [], mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }],
      timeoutRetryBudget: { confirmed: 0, pending: false },
      timeoutRetry: { eligible: false, unknown: true, reason: 'timeout-evidence-unknown:spawnSync gh ETIMEDOUT' },
    };
    const out = planReconcile({ prs: [p], now: Date.parse('2026-10-26T20:00:00Z'), requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' } });
    const kinds = out.refusals.map((r) => r.kind);
    expect(kinds).toContain('timeout-evidence-unknown');
    expect(kinds).not.toContain('timeout-retry-ineligible');
    expect(out.dispatch.map((d) => d.kind)).not.toContain('ci-heal');
    expect(out.dispatch).toEqual([]);
    expect(REFUSAL_KINDS).toContain('timeout-evidence-unknown');
  });

  it('core: unknown secondary (owed re-run) evidence also refuses and never heals blindly', () => {
    const p = {
      number: 5987, state: 'OPEN', headRefName: 'lane/x', headRefOid: head, labels: [], comments: [], mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }],
      timeoutRetryBudget: { confirmed: 0, pending: false },
      owedCiRerunRetry: { eligible: false, unknown: true, reason: 'timeout-evidence-unknown:spawnSync gh ETIMEDOUT' },
    };
    const out = planReconcile({ prs: [p], now: Date.parse('2026-10-26T20:00:00Z'), requiredChecks: ['gate'], reviewTiming: { startAfter: 'ci-green' } });
    expect(out.refusals.map((r) => r.kind)).toContain('timeout-evidence-unknown');
    expect(out.refusals.map((r) => r.kind)).not.toContain('timeout-retry-ineligible');
    expect(out.dispatch).toEqual([]);
  });
});
