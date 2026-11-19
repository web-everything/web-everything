import { describe, it, expect } from 'vitest';
import { completeCheckReadFixture } from './fixtures/complete-check-read-fixture.mjs';
import { readReviewChecks } from '../lib/review-ci-gate-io.mjs';
import { reviewCiGate } from '../lib/review-ci-gate.mjs';

const pr = { headRefOid: 'head', statusCheckRollup: [
  { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { context: 'legacy', state: 'SUCCESS', targetUrl: 'https://example.test/status' },
] };
const read = prs => readReviewChecks({ repo: 'owner/repo', headSha: 'head',
  run: argv => JSON.stringify(completeCheckReadFixture(prs, argv)) });

describe('shared drain CLI complete check fixture', () => {
  it('lets the real reader attest both check runs and legacy statuses for the requested head', () => {
    const checks = read([pr]);
    expect(checks).toHaveLength(2);
    expect(checks[1]).toMatchObject({ context: 'legacy', state: 'success', target_url: 'https://example.test/status' });
    expect(reviewCiGate({ headSha: 'head', requiredChecks: ['test', 'legacy'], checks,
      rowsComplete: checks.rowsComplete, rowsHead: checks.rowsHead }).allowed).toBe(true);
  });
  it('keeps failed, pending and wrong-head evidence blocking admission', () => {
    for (const row of [
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'test', status: 'IN_PROGRESS' },
      { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', head_sha: 'other' },
    ]) {
      const checks = read([{ ...pr, statusCheckRollup: [row] }]);
      expect(reviewCiGate({ headSha: 'head', requiredChecks: ['test'], checks,
        rowsComplete: checks.rowsComplete, rowsHead: checks.rowsHead }).allowed).toBe(false);
    }
  });
  it('refuses unknown heads and missing rollups instead of inventing empty complete evidence', () => {
    expect(() => read([{ ...pr, headRefOid: 'other' }])).toThrow('missing complete check fixture');
    expect(() => read([{ headRefOid: 'head' }])).toThrow('missing complete check fixture');
  });
  it('leaves targeted freshness reads and unrelated APIs to the calling shim', () => {
    expect(completeCheckReadFixture([pr], ['api', '--paginate', '--slurp',
      'repos/owner/repo/commits/head/check-runs?check_name=test&per_page=100'])).toBeUndefined();
    expect(completeCheckReadFixture([pr], ['api', 'graphql'])).toBeUndefined();
  });
});
