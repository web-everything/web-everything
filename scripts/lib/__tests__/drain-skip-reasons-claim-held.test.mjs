import { expect, it } from 'vitest';
import * as reasons from '../drain-skip-reasons.mjs';

it('claim-held prefix wins over holder text', () => {
  for (const holder of ['studio:83231 (lane BEHIND, cap)', 'restamp-stale-code', 'review hold', 'CodeQL', 'cap']) {
    expect(reasons.classifySkipReason(`claim-held: ci-heal claim on we#7267 held by ${holder}`)).toBe('claim-held');
  }
  expect(reasons.SKIP_KINDS).toContain('claim-held');
});
it('T17: old fix claim text keeps its existing classification', () => {
  expect(reasons.classifySkipReason('fix claim held by x')).toBe('unrecognized-reason');
});
it('T18: formatter produces claim-held rows and machine-readable stderr JSON', () => {
  expect(reasons.CLAIM_HELD_PREFIX).toBe('claim-held:');
  const reason = reasons.formatClaimHeldReason({ kind: 'ci-heal', holder: 'studio:83231', repo: 'we', pr: 7267, uncertain: false });
  expect(reason).toBe('claim-held: ci-heal claim on we#7267 held by studio:83231');
  const rows = reasons.buildSkipReasons({ revalidationAborted: [{ num: 7267, repo: 'we', reason }] });
  expect(rows).toEqual([{ num: 7267, repo: 'we', kind: 'claim-held', reason, source: 'revalidationAborted' }]);
  expect(JSON.parse(reasons.formatSkipReasonsLine(rows).split('skip-reasons: ')[1])).toEqual(rows);
});
it('formatter exposes fail-closed uncertainty to the operator', () => {
  const reason = reasons.formatClaimHeldReason({ kind: 'fixing', holder: '(fixing claim)', repo: 'we', pr: 7267, uncertain: 'invalid-heartbeat' });
  expect(reason).toBe('claim-held: fixing claim on we#7267 held by (fixing claim) (uncertain: invalid-heartbeat)');
  expect(reasons.classifySkipReason(reason)).toBe('claim-held');
});
