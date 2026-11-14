// A completed, successful required CI check-run on EXACTLY the HEAD sha is an accepted verification source
// (open-pr / pr-land finish-guard); every unreadable/pending/cancelled/missing/other-sha result fails closed.
import { describe, it, expect } from 'vitest';
import { verifyGateDecision, ciGreenOnSha, readCiCheckRuns, readCiWorkflowRuns, repoSlugFromRemote } from '../lane-verify.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const run = (o = {}) => ({ id: 101, name: 'test', head_sha: SHA, status: 'completed', conclusion: 'success', app: { id: 15368 }, check_suite: { id: 500 }, ...o });
const WF = [{ id: 900, path: '.github/workflows/ci.yml', head_sha: SHA, check_suite_id: 500, status: 'completed', conclusion: 'success' }];
const wf = (o = {}) => ({ id: 900, path: '.github/workflows/ci.yml', head_sha: SHA, check_suite_id: 500, status: 'completed', conclusion: 'success', ...o });

describe('ciGreenOnSha', () => {
  it('accepts a completed success on exactly the head sha and names run id + sha', () => {
    const v = ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run()] });
    expect(v.ok).toBe(true);
    expect(v.sources).toEqual([{ name: 'test', runId: 101, sha: SHA }]);
  });
  it('refuses a green run for a different sha', () => {
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run({ head_sha: OTHER })] }).ok).toBe(false);
  });
  it('refuses pending / in-progress / cancelled / failed / missing', () => {
    for (const r of [run({ status: 'in_progress', conclusion: null }), run({ status: 'queued', conclusion: null }),
      run({ conclusion: 'cancelled' }), run({ conclusion: 'failure' }), run({ name: 'lint' })]) {
      expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [r] }).ok).toBe(false);
    }
  });
  it('a newer in-progress re-run beats an older success', () => {
    const v = ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run({ id: 1 }), run({ id: 2, status: 'in_progress', conclusion: null })] });
    expect(v.ok).toBe(false);
  });
  it('refuses malformed or duplicate ids, and a caller cannot swap out `test`', () => {
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run({ id: undefined })] }).ok).toBe(false);
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run({ id: 1 }), run({ id: 'x', conclusion: 'failure' })] }).ok).toBe(false);
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run(), run({ conclusion: 'failure' })] }).ok).toBe(false);
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run({ name: 'lint' })], required: ['lint'] }).ok).toBe(false);
  });
  it('ignores a same-named check from another app, even a newer success over a real failure', () => {
    const v = ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run({ id: 1, conclusion: 'failure' }), run({ id: 2, app: { id: 1 } })] });
    expect(v.ok).toBe(false);
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run({ app: undefined })] }).ok).toBe(false);
  });
  it('refuses unreadable input and a missing sibling', () => {
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: null }).ok).toBe(false);
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: 'x' }).ok).toBe(false);
    expect(ciGreenOnSha({ headSha: '', checkRuns: [run()] }).ok).toBe(false);
    expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run()], required: ['test', 'lint'] }).ok).toBe(false);
  });
});

describe('verifyGateDecision with CI check-runs', () => {
  const base = { record: null, headSha: SHA, requireVerified: true };
  it('no marker + green CI on the sha is accepted, logging run id + sha', () => {
    const v = verifyGateDecision({ ...base, ciWorkflowRuns: WF, ciCheckRuns: [run()] });
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
      expect(ciGreenOnSha({ workflowRuns: WF, headSha: SHA, checkRuns: [run()], workflowRuns }).ok).toBe(false);
    }
  });
  it('a failed newest ci.yml workflow run refuses even with an older green one', () => {
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns: [wf({ id: 1 }), wf({ id: 2, conclusion: 'failure' })] }).ok).toBe(false);
  });
  it('an older red / running / young-queued ci.yml run is not masked by a newer green one on the same sha', () => {
    // Live shape: one sha carries a pull_request ci.yml run AND a workflow_dispatch ci.yml run, each its own suite.
    const NOW = Date.parse('2026-11-14T05:00:00Z');
    const runs = [run({ id: 1, conclusion: 'failure' }), run({ id: 2, check_suite: { id: 501 } })];
    const green2 = wf({ id: 2, check_suite_id: 501 });
    for (const older of [wf({ id: 1, conclusion: 'failure' }), wf({ id: 1, conclusion: 'timed_out' }), wf({ id: 1, conclusion: 'neutral' }),
      wf({ id: 1, status: 'in_progress', conclusion: null }),
      wf({ id: 1, status: 'queued', conclusion: null, created_at: '2026-11-14T04:55:00Z' }), // 5 min < 10 min window: not stuck yet
      wf({ id: 1, status: 'queued', conclusion: null })]) { // undatable
      const v = ciGreenOnSha({ headSha: SHA, checkRuns: runs, workflowRuns: [older, green2], nowMs: NOW, stuckQueuedMs: 600_000 });
      expect(v.ok).toBe(false);
      expect(v.detail).toContain('run 1');
    }
    // No stuck window configured → even an hours-old queued run refuses (fail closed).
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: runs, workflowRuns: [wf({ id: 1, status: 'queued', conclusion: null, created_at: '2026-11-14T01:00:00Z' }), green2], nowMs: NOW }).ok).toBe(false);
    // A cancelled run whose own suite already holds a failed check is red evidence, not ignorable.
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: runs, workflowRuns: [wf({ id: 1, conclusion: 'cancelled' }), green2], nowMs: NOW }).ok).toBe(false);
  });
  it('#6684 shape: a stuck-queued (or cleanly cancelled) pull_request ci.yml run is outweighed by the green dispatch run', () => {
    const NOW = Date.parse('2026-11-14T05:00:00Z');
    const green2 = wf({ id: 2, check_suite_id: 501 });
    const greenTest = [run({ id: 2, check_suite: { id: 501 } })];
    const stuck = wf({ id: 1, status: 'queued', conclusion: null, run_attempt: 1, created_at: '2026-11-14T01:00:00Z' });
    const v = ciGreenOnSha({ headSha: SHA, checkRuns: greenTest, workflowRuns: [stuck, green2], nowMs: NOW, stuckQueuedMs: 600_000 });
    expect(v.ok).toBe(true);
    expect(v.sources).toEqual([{ name: 'test', runId: 2, sha: SHA }]);
    const cancelled = wf({ id: 1, conclusion: 'cancelled', run_attempt: 1 });
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run({ id: 1, conclusion: 'cancelled' }), ...greenTest], workflowRuns: [cancelled, green2] }).ok).toBe(true);
    // Through the gate (no marker): the stuck window reaches ciGreenOnSha.
    expect(verifyGateDecision({ record: null, headSha: SHA, requireVerified: true, nowMs: NOW, ciCheckRuns: greenTest, ciWorkflowRuns: [stuck, green2], ciStuckQueuedMs: 600_000 }).status).toBe('ci-green');
    // Ignorable runs alone are never green evidence, and only a GREEN run's suite can supply `test`.
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns: [wf({ conclusion: 'cancelled' })] }).ok).toBe(false);
    // The green dispatch run (id 2, suite 501) has no `test`; a green `test` in the cancelled run's suite 500 must not count.
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run({ id: 9 })], workflowRuns: [wf({ id: 1, conclusion: 'cancelled' }), green2] }).ok).toBe(false);
    // Both ci.yml runs green → accepted, newest `test` named as the source.
    const both = ciGreenOnSha({ headSha: SHA, checkRuns: [run({ id: 1 }), run({ id: 2, check_suite: { id: 501 } })], workflowRuns: [wf({ id: 1 }), wf({ id: 2, check_suite_id: 501 })] });
    expect(both.ok).toBe(true);
    expect(both.sources).toEqual([{ name: 'test', runId: 2, sha: SHA }]);
  });
  it('red-team repro: a failed ci.yml `test` (101) is not masked by a newer green `test` (102) from another workflow', () => {
    const ciCheckRuns = [run({ id: 101, conclusion: 'failure' }), run({ id: 102, check_suite: { id: 777 } })];
    const ciWorkflowRuns = [wf({ conclusion: 'failure' }), { id: 901, path: '.github/workflows/other.yml', head_sha: SHA, check_suite_id: 777, status: 'completed', conclusion: 'success' }];
    const v = verifyGateDecision({ record: null, headSha: SHA, requireVerified: true, ciCheckRuns, ciWorkflowRuns });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unverified');
  });
  it('red-team round 2: a ref-qualified ci.yml path is the same workflow — judged when red, accepted when green', () => {
    const REF = '.github/workflows/ci.yml@refs/pull/4450/merge';
    // A green run spelled with its ref is accepted, through the gate too.
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns: [wf({ path: REF })] }).ok).toBe(true);
    expect(verifyGateDecision({ record: null, headSha: SHA, requireVerified: true, ciCheckRuns: [run()], ciWorkflowRuns: [wf({ path: REF })] }).status).toBe('ci-green');
    // A failed ref-qualified run (suite 499) is never hidden by a green plain-path run (suite 500).
    const ciCheckRuns = [run({ id: 1, conclusion: 'failure', check_suite: { id: 499 } }), run({ id: 2 })];
    const ciWorkflowRuns = [wf({ id: 1, path: REF, check_suite_id: 499, conclusion: 'failure' }), wf({ id: 2 })];
    const v = verifyGateDecision({ record: null, headSha: SHA, requireVerified: true, ciCheckRuns, ciWorkflowRuns });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unverified');
    expect(v.detail).toContain('run 1');
    // Every other ref spelling of ci.yml is judged too (branch, tag, sha).
    for (const path of ['.github/workflows/ci.yml@refs/heads/main', '.github/workflows/ci.yml@refs/tags/v1', `.github/workflows/ci.yml@${SHA}`]) {
      expect(ciGreenOnSha({ headSha: SHA, checkRuns: ciCheckRuns, workflowRuns: [wf({ id: 1, path, check_suite_id: 499, conclusion: 'failure' }), wf({ id: 2 })] }).ok).toBe(false);
    }
    // A ci.yml path whose ref part is unreadable fails closed: it is neither silently ignored nor trusted.
    for (const path of ['.github/workflows/ci.yml@', '.github/workflows/ci.yml@refs/pull/1 x', '.github/workflows/ci.yml@a@b', '.github/workflows/ci.yml@refs/x\n']) {
      expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run(), run({ id: 3, check_suite: { id: 499 } })], workflowRuns: [wf({ id: 1, path, check_suite_id: 499 }), wf({ id: 2 })] }).ok).toBe(false);
    }
    // A ci.yml spelling with no `@` that only differs by whitespace, an invisible character, `./`, `/` or a trailing
    // slash — or a missing/non-string path — also fails closed instead of being skipped as another workflow.
    const CI = '.github/workflows/ci.yml';
    const [ZWSP, LS, NUL] = [0x200b, 0x2028, 0x0].map((c) => String.fromCharCode(c));
    for (const path of [`${CI}\r`, `${CI}\n`, ` ${CI}`, `${CI} `, `./${CI}`, `/${CI}`, `${CI}/`, `${CI}${LS}`,
      `${CI}${ZWSP}`, `${CI}${ZWSP}@refs/heads/main`, `${CI}@refs/x${NUL}`, `${CI}@refs/${ZWSP}x`, undefined, null, 42]) {
      const v = ciGreenOnSha({ headSha: SHA, checkRuns: [run(), run({ id: 3, check_suite: { id: 499 }, conclusion: 'failure' })], workflowRuns: [wf({ id: 1, path, check_suite_id: 499, conclusion: 'failure' }), wf({ id: 2 })] });
      expect(v.ok).toBe(false);
      expect(v.detail).toContain('unreadable workflow path');
    }
    // An odd spelling on ANOTHER sha cannot block this one.
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns: [wf({ id: 1, path: `${CI}\r`, head_sha: OTHER }), wf({ id: 3 })] }).ok).toBe(true);
    // Look-alikes of another workflow stay other workflows.
    for (const path of ['.github/workflows/ci.yml.bak', '.github/workflows/ci.yml2@refs/heads/main', '.github/workflows/other.yml@refs/heads/main', 'x/.github/workflows/ci.yml']) {
      expect(ciGreenOnSha({ headSha: SHA, checkRuns: [run()], workflowRuns: [wf({ path })] }).ok).toBe(false);
    }
  });
  it('red-team round 3: a freshly requeued rerun is not stuck because its run kept an old created_at', () => {
    // GitHub keeps created_at on a rerun; the attempt's own queue time is run_started_at (and updated_at).
    const NOW = Date.parse('2026-11-14T05:00:00Z');
    const OLD = '2026-11-13T01:00:00Z';
    const green2 = wf({ id: 2, check_suite_id: 501 });
    const greenTest = [run({ id: 2, check_suite: { id: 501 } })];
    const rerun = (o) => wf({ id: 1, status: 'queued', conclusion: null, created_at: OLD, ...o });
    const refused = [
      rerun({ run_attempt: 2, run_started_at: '2026-11-14T05:00:00Z', updated_at: '2026-11-14T05:00:00Z' }), // the reported shape
      rerun({ run_attempt: 2, run_started_at: '2026-11-14T04:58:00Z', updated_at: OLD }), // only the attempt start is young
      rerun({ run_attempt: 1, run_started_at: OLD, updated_at: '2026-11-14T04:59:00Z' }), // only updated_at is young
      rerun({ run_attempt: 2, updated_at: OLD }), // a rerun with no attempt start time is undatable
      rerun({ run_attempt: 2, run_started_at: 'not a date', updated_at: OLD }), // unparseable attempt start
      rerun({ run_attempt: 1, run_started_at: OLD, updated_at: 'garbage' }), // unparseable updated_at
      rerun({ run_started_at: OLD, updated_at: OLD }), // no run_attempt: cannot tell a rerun apart
      rerun({ run_attempt: 0, run_started_at: OLD }), rerun({ run_attempt: '2', run_started_at: OLD }), rerun({ run_attempt: 1.5, run_started_at: OLD }),
      rerun({ run_attempt: 2, run_started_at: '2026-11-14T06:00:00Z' }), // attempt start in the future
    ];
    for (const queued of refused) {
      const v = ciGreenOnSha({ headSha: SHA, checkRuns: greenTest, workflowRuns: [queued, green2], nowMs: NOW, stuckQueuedMs: 600_000 });
      expect(v.ok).toBe(false);
      expect(v.detail).toContain('run 1');
      expect(verifyGateDecision({ record: null, headSha: SHA, requireVerified: true, nowMs: NOW, ciCheckRuns: greenTest, ciWorkflowRuns: [queued, green2], ciStuckQueuedMs: 600_000 }).ok).toBe(false);
    }
    // A first attempt genuinely queued past the window (every date old) is still stuck and outweighed by the green run.
    const stuckFirst = rerun({ run_attempt: 1, run_started_at: OLD, updated_at: '2026-11-14T04:00:00Z' });
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: greenTest, workflowRuns: [stuckFirst, green2], nowMs: NOW, stuckQueuedMs: 600_000 }).ok).toBe(true);
    // A rerun's run-level state and the latest-attempt check-runs hide attempt 1's verdict: an old-queued or
    // cancelled rerun is never ignorable, even with no unfinished check visible (attempt 1 may have failed).
    const stuckRerun = rerun({ run_attempt: 2, run_started_at: '2026-11-14T04:00:00Z', updated_at: '2026-11-14T04:00:00Z' });
    for (const hidden of [stuckRerun, wf({ id: 1, conclusion: 'cancelled', run_attempt: 2 }), wf({ id: 1, conclusion: 'cancelled' }), wf({ id: 1, conclusion: 'cancelled', run_attempt: '1' })]) {
      const v = ciGreenOnSha({ headSha: SHA, checkRuns: greenTest, workflowRuns: [hidden, green2], nowMs: NOW, stuckQueuedMs: 600_000 });
      expect(v.ok).toBe(false);
      expect(v.detail).toContain('run 1');
    }
    // A rerun that concluded green is still green evidence (a flake rerun).
    expect(ciGreenOnSha({ headSha: SHA, checkRuns: greenTest, workflowRuns: [wf({ id: 2, check_suite_id: 501, run_attempt: 3 })] }).ok).toBe(true);
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
