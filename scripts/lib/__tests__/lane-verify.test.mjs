// A completed, successful required CI check-run on EXACTLY the HEAD sha is an accepted verification source
// (open-pr / pr-land finish-guard); every unreadable/pending/cancelled/missing/other-sha result fails closed.
import { describe, it, expect } from 'vitest';
import { verifyGateDecision, ciGreenOnSha, readCiCheckRuns } from '../lane-verify.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (o = {}) => ({ id: 101, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success', ...o });

describe('ciGreenOnSha', () => {
  it('accepts a completed success on exactly the head sha and names run id + sha', () => {
    const v = ciGreenOnSha({ headSha: SHA, checkRuns: [run()] });
    expect(v.ok).toBe(true);
    expect(v.sources).toEqual([{ name: 'test', runId: 101, sha: SHA }]);
  });
  it('refuses a green run for a different sha', () => {
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run({ head_sha: OTHER })] }).ok).toBe(false);
  });
  it('refuses pending / in-progress / cancelled / failed / missing', () => {
    for (const r of [run({ status: 'in_progress', conclusion: null }), run({ status: 'queued', conclusion: null }),
      run({ conclusion: 'cancelled' }), run({ conclusion: 'failure' }), run({ name: 'lint' })]) {
      expect(ciGreenOnSha({ headSha: SHA, checkRuns: [r] }).ok).toBe(false);
    }
  });
  it('a newer in-progress re-run beats an older success', () => {
    const v = ciGreenOnSha({ headSha: SHA, checkRuns: [run({ id: 1 }), run({ id: 2, status: 'in_progress', conclusion: null })] });
    expect(v.ok).toBe(false);
  });
  it('refuses unreadable input and a missing sibling', () => {
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: null }).ok).toBe(false);
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: 'x' }).ok).toBe(false);
    expect(ciGreenOnSha({ headSha: '', checkRuns: [run()] }).ok).toBe(false);
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], required: ['test', 'lint'] }).ok).toBe(false);
  });
});

describe('verifyGateDecision with CI check-runs', () => {
  const base = { record: null, headSha: SHA, requireVerified: true };
  it('no marker + green CI on the sha is accepted, logging run id + sha', () => {
    const v = verifyGateDecision({ ...base, ciCheckRuns: [run()] });
    expect(v.ok).toBe(true);
    expect(v.status).toBe('ci-green');
    expect(v.detail).toContain('101');
    expect(v.detail).toContain(SHA.slice(0, 8));
  });
  it('green on another sha / pending / unreadable still refuse with the unverified reason', () => {
    for (const ciCheckRuns of [[run({ head_sha: OTHER })], [run({ status: 'in_progress', conclusion: null })], null, undefined]) {
      const v = verifyGateDecision({ ...base, ciCheckRuns });
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('unverified');
    }
  });
  it('never overrides a red or corrupt local marker', () => {
    expect(verifyGateDecision({ ...base, record: { sha: SHA, status: 'red', exitCode: 1 }, ciCheckRuns: [run()] }).ok).toBe(false);
    expect(verifyGateDecision({ ...base, record: { corrupt: true }, ciCheckRuns: [run()] }).ok).toBe(false);
  });
});

describe('readCiCheckRuns', () => {
  it('returns the check_runs array, null on any failure', () => {
    const ok = readCiCheckRuns({ repo: 'o/r', headSha: SHA, runGh: () => JSON.stringify({ check_runs: [run()] }) });
    expect(ok).toHaveLength(1);
    expect(readCiCheckRuns({ repo: 'o/r', headSha: SHA, runGh: () => { throw new Error('x'); } })).toBeNull();
    expect(readCiCheckRuns({ repo: 'o/r', headSha: SHA, runGh: () => 'not json' })).toBeNull();
    expect(readCiCheckRuns({ repo: 'o/r', headSha: 'zz', runGh: () => '{}' })).toBeNull();
  });
});
