// A completed, successful required CI check-run on EXACTLY the HEAD sha is an accepted verification source
// (open-pr / pr-land finish-guard); every unreadable/pending/cancelled/missing/other-sha result fails closed.
import { describe, it, expect } from 'vitest';
import { verifyGateDecision, ciGreenOnSha, readCiCheckRuns, readCiWorkflowRuns, repoSlugFromRemote } from '../lane-verify.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (o = {}) => ({ id: 101, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: 500 }, ...o });
const wf = (o = {}) => ({ id: 900, path: '.github/workflows/ci.yml', head_sha: SHA, check_suite_id: 500, status: 'completed', conclusion: 'success', ...o });

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
  it('refuses malformed or duplicate ids, and a caller cannot swap out `test`', () => {
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run({ id: undefined })] }).ok).toBe(false);
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run({ id: 1 }), run({ id: 'x', conclusion: 'failure' })] }).ok).toBe(false);
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run(), run({ conclusion: 'failure' })] }).ok).toBe(false);
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run({ name: 'lint' })], required: ['lint'] }).ok).toBe(false);
  });
  it('ignores a same-named check from another app, even a newer success over a real failure', () => {
    const v = ciGreenOnSha({ headSha: SHA, checkRuns: [run({ id: 1, conclusion: 'failure' }), run({ id: 2, app: { id: 1 } })] });
    expect(v.ok).toBe(false);
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run({ app: undefined })] }).ok).toBe(false);
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
    const ok = readCiCheckRuns({ repo: 'o/r', headSha: SHA, runGh: () => `${JSON.stringify(run())}\n${JSON.stringify(run({ id: 102 }))}\n` });
    expect(ok).toHaveLength(2);
    expect(readCiCheckRuns({ repo: 'o/r', headSha: SHA, runGh: () => { throw new Error('x'); } })).toBeNull();
    expect(readCiCheckRuns({ repo: 'o/r', headSha: SHA, runGh: () => 'not json' })).toBeNull();
    expect(readCiCheckRuns({ repo: 'o/r', headSha: 'zz', runGh: () => '{}' })).toBeNull();
  });
});

describe('pinned to the ci.yml workflow run on the exact sha', () => {
  it('accepts a green test from the ci.yml suite', () => {
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns: [wf()] }).ok).toBe(true);
  });
  it('an unrelated green `test` job from another suite cannot mask a failed ci.yml test', () => {
    const runs = [run({ id: 1, conclusion: 'failure' }), run({ id: 2, check_suite: { id: 777 } })];
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: runs, workflowRuns: [wf()] }).ok).toBe(false);
  });
  it('a green test whose suite is not a ci.yml run is refused', () => {
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run({ check_suite: { id: 777 } })], workflowRuns: [wf()] }).ok).toBe(false);
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns: [wf({ path: '.github/workflows/other.yml' })] }).ok).toBe(false);
  });
  it('refuses when workflow runs are missing/unreadable, other-sha, or the ci.yml run failed/cancelled/pending', () => {
    for (const workflowRuns of [undefined, null, [], [wf({ head_sha: OTHER })], [wf({ conclusion: 'failure' })], [wf({ conclusion: 'cancelled' })], [wf({ status: 'in_progress', conclusion: null })]]) {
      expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns }).ok).toBe(false);
    }
  });
  it('a failed newest ci.yml workflow run refuses even with an older green one', () => {
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns: [wf({ id: 1 }), wf({ id: 2, conclusion: 'failure' })] }).ok).toBe(false);
  });
  it('gate passes workflow runs through and refuses without them', () => {
    const base = { record: null, headSha: SHA, requireVerified: true, ciCheckRuns: [run()] };
    expect(verifyGateDecision({ ...base, ciWorkflowRuns: [wf()] }).ok).toBe(true);
    expect(verifyGateDecision({ ...base }).ok).toBe(false);
  });
  it('readCiWorkflowRuns parses NDJSON, null on failure', () => {
    expect(readCiWorkflowRuns({ repo: 'o/r', headSha: SHA, runGh: () => `${JSON.stringify(wf())}\n` })).toHaveLength(1);
    expect(readCiWorkflowRuns({ repo: 'o/r', headSha: SHA, runGh: () => { throw new Error('x'); } })).toBeNull();
  });
});

describe('repoSlugFromRemote', () => {
  it('parses canonical owner/repo from every remote spelling', () => {
    for (const u of ['git@github.com:o/r.git', 'https://github.com/o/r.git', 'https://github.com/o/r', 'ssh://git@github.com:22/o/r.git', 'ssh://git@github.com/o/r.git', 'https://user@github.com/o/r/']) {
      expect(repoSlugFromRemote(u)).toBe('o/r');
    }
  });
  it('returns null for non-github or garbage', () => {
    for (const u of ['', null, 'https://example.com/o/r.git', 'git@github.com:o', 'https://github.com/o/r/extra/more']) expect(repoSlugFromRemote(u)).toBeNull();
  });
});
