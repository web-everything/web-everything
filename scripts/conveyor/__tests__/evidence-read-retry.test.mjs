import { describe, it, expect, vi } from 'vitest';
import { isEvidenceReadTimeout, EVIDENCE_READ_BACKOFF_MS } from '../evidence-read-retry.mjs';
import { readTimeoutEvidence } from '../reconcile-pass.mjs';
import { planReconcile } from '../reconcile-core.mjs';

const head = 'a'.repeat(40);
const repo = 'web-everything/web-everything';
const pr = { number: 5987, headRefOid: head };
const timeoutError = () => Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });

describe('evidence-read timeout is unknown, never ineligible', () => {
  it('classifies only timeouts as read timeouts', () => {
    expect(isEvidenceReadTimeout(timeoutError())).toBe(true);
    expect(isEvidenceReadTimeout(new Error('spawnSync gh ETIMEDOUT'))).toBe(true);
    expect(isEvidenceReadTimeout(new Error('evidence-read-deadline'))).toBe(true);
    expect(isEvidenceReadTimeout(new Error('stale-head'))).toBe(false);
    expect(isEvidenceReadTimeout(new Error('incomplete-diff'))).toBe(false);
  });

  it('retries a timed-out read with bounded backoff, then returns unknown (not a plain ineligible reason)', () => {
    const exec = vi.fn(() => { throw timeoutError(); });
    const sleep = vi.fn();
    const result = readTimeoutEvidence(pr, { repo, exec, sleep, facts: () => null });
    expect(result).toMatchObject({ eligible: false, unknown: true });
    expect(result.reason).toMatch(/^timeout-evidence-unknown:/);
    expect(exec).toHaveBeenCalledTimes(EVIDENCE_READ_BACKOFF_MS.length + 1);
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

  it('a non-timeout failure is not retried', () => {
    const exec = vi.fn(() => { throw new Error('HTTP 404'); });
    const sleep = vi.fn();
    const result = readTimeoutEvidence(pr, { repo, exec, sleep, facts: () => null });
    expect(result.unknown).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
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
  });
});
