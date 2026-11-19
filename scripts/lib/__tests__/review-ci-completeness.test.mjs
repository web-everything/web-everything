import { describe, it, expect, vi } from 'vitest';
import { readReviewChecks, readReviewCiGate } from '../review-ci-gate-io.mjs';

const headSha = 'a'.repeat(40);
const success = { name: 'test', status: 'completed', conclusion: 'success' };
const pages = (failure = false) => argv => JSON.stringify(argv[3].includes('/status?')
  ? [{ statuses: [] }, { statuses: [{ context: 'legacy', state: 'success' }] }]
  : [{ check_runs: Array.from({ length: 100 }, () => success) },
    { check_runs: [{ ...success, conclusion: failure ? 'failure' : 'success' }] }]);
const gate = readChecks => readReviewCiGate({
  repo: 'owner/repo', pr: 1, readHead: () => headSha,
  readRequired: () => ({ source: 'live', checks: ['test', 'legacy'] }), readChecks,
  policy: { startAfter: 'ci-green', startEarly: 'off', startBeforeCi: false },
});

describe('reader-to-reviewStartGate completeness integration', () => {
  it('fully paginated successful check runs and statuses allow strict ci-green review', () => {
    const run = vi.fn(pages());
    const result = gate(args => readReviewChecks({ ...args, run }));
    expect(result).toMatchObject({ allowed: true, rowsComplete: true, reason: 'required-checks-successful' });
    expect(result.checks).toHaveLength(102);
    expect(run.mock.calls.map(([argv]) => argv)).toEqual([
      ['api', '--paginate', '--slurp', `repos/owner/repo/commits/${headSha}/check-runs?per_page=100&filter=all`],
      ['api', '--paginate', '--slurp', `repos/owner/repo/commits/${headSha}/status?per_page=100`],
    ]);
  });

  it('a failure on a later page blocks review despite a full page of older successes', () => {
    expect(gate(args => readReviewChecks({ ...args, run: pages(true) })))
      .toMatchObject({ allowed: false, rowsComplete: true, affected: [{ name: 'test', reason: 'failure' }] });
  });

  it('bare, explicitly incomplete and serialized historical all-success rows fail closed', () => {
    const complete = readReviewChecks({ repo: 'owner/repo', headSha, run: pages() });
    for (const rows of [[success, { context: 'legacy', state: 'success' }],
      Object.assign([...complete], { rowsComplete: false }), JSON.parse(JSON.stringify(complete))]) {
      expect(gate(() => rows)).toMatchObject({ allowed: false, rowsComplete: false, reason: 'rows-incomplete' });
    }
  });

  it.each(['check-runs', 'status'])('unreadable later %s pages never establish completeness', endpoint => {
    const run = argv => argv[3].includes(`/${endpoint}?`)
      ? JSON.stringify(endpoint === 'check-runs' ? [{ check_runs: [success] }, {}] : [{ statuses: [] }, {}])
      : pages()(argv);
    expect(gate(args => readReviewChecks({ ...args, run })))
      .toMatchObject({ allowed: false, reason: 'unreadable-ci' });
  });

  it('pagination IO failure never establishes completeness', () => {
    expect(gate(args => readReviewChecks({ ...args, run: argv => {
      if (argv[3].includes('/status?')) throw new Error('later status page unavailable');
      return pages()(argv);
    } }))).toMatchObject({ allowed: false, reason: 'unreadable-ci' });
  });
});


// Commit check-run responses have no run_id/run_attempt; Actions jobs supply them.
const restCheck = (id, conclusion = 'success', runId = 700) => ({
  id, name: 'test', head_sha: headSha, status: 'completed', conclusion,
  app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 900 },
  details_url: `https://github.com/owner/repo/actions/runs/${runId}/job/${id + 100}`,
});
const restJob = (check, attempt, runId = 700) => ({
  id: check.id + 100, run_id: runId, run_attempt: attempt, head_sha: headSha,
  name: check.name, status: check.status, conclusion: check.conclusion,
  check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${check.id}`,
});
const rerunReader = (checks, jobs, calls = []) => argv => {
  const path = argv.at(-1);
  calls.push(path);
  if (path.includes('/check-runs?')) return JSON.stringify([{ total_count: checks.length, check_runs: checks }]);
  if (path.includes('/status?')) return JSON.stringify([{ statuses: [{ context: 'legacy', state: 'success' }] }]);
  const attempt = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/.exec(path);
  if (attempt) {
    const list = jobs.filter(job => job.run_id === Number(attempt[1]) && job.run_attempt === Number(attempt[2]));
    return JSON.stringify({ total_count: list.length, jobs: list });
  }
  const job = jobs.find(job => path === `repos/owner/repo/actions/jobs/${job.id}`);
  if (!job) throw new Error('job evidence unavailable');
  return JSON.stringify(job);
};

describe('REST rerun reader-to-gate compatibility', () => {
  const failed = restCheck(10, 'failure'), passed = restCheck(11);
  it.each([false, true])('successful REST reruns supersede older failures using validated Actions job attempts (reverse=%s)', reverse => {
    const checks = reverse ? [passed, failed] : [failed, passed];
    expect(checks.every(check => !('run_id' in check) && !('run_attempt' in check))).toBe(true);
    const calls = [];
    const result = gate(args => readReviewChecks({ ...args,
      run: rerunReader(checks, [restJob(failed, 1), restJob(passed, 2)], calls) }));
    expect(result).toMatchObject({ allowed: true, rowsComplete: true, reason: 'required-checks-successful' });
    expect(result.checks.find(row => row.id === passed.id)).toMatchObject({ run_id: 700, run_attempt: 2 });
    expect(calls.filter(path => path.includes('/actions/jobs/')).sort()).toEqual([
      'repos/owner/repo/actions/jobs/110', 'repos/owner/repo/actions/jobs/111',
    ]);
  });

  it('a successful different workflow run cannot supersede a REST failure', () => {
    const other = restCheck(11, 'success', 701);
    expect(gate(args => readReviewChecks({ ...args,
      run: rerunReader([failed, other], [restJob(failed, 1), restJob(other, 2, 701)]) })))
      .toMatchObject({ allowed: false, affected: [{ name: 'test', reason: 'failure' }] });
  });

  it('a singleton rerun never erases a failed same-name matrix sibling', () => {
    const sibling = { ...restJob(failed, 1), id: 999, check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/999' };
    expect(gate(args => readReviewChecks({ ...args,
      run: rerunReader([failed, passed], [restJob(failed, 1), sibling, restJob(passed, 2)]) })))
      .toMatchObject({ allowed: false, affected: [{ name: 'test', reason: 'failure' }] });
  });

  it.each(['partial', 'unreadable', 'wrong-head', 'missing-job', 'oversized'])('fails closed on %s attempt inventories', shape => {
    const run = rerunReader([failed, passed], [restJob(failed, 1), restJob(passed, 2)]);
    expect(gate(args => readReviewChecks({ ...args, run: argv => {
      if (!argv.at(-1).includes('/attempts/')) return run(argv);
      if (shape === 'unreadable') throw new Error('job inventory unavailable');
      const page = JSON.parse(run(argv));
      if (shape === 'partial') page.total_count++;
      if (shape === 'wrong-head') page.jobs[0].head_sha = 'b'.repeat(40);
      if (shape === 'missing-job') { page.total_count = 0; page.jobs = []; }
      if (shape === 'oversized') { page.total_count = 101; page.jobs = Array(101).fill(page.jobs[0]); }
      return JSON.stringify(page);
    } }))).toMatchObject({ allowed: false, reason: 'unreadable-ci' });
  });

  it('serialized job rows cannot carry the in-process rerun identity proof', async () => {
    const { reviewCiGate } = await import('../review-ci-gate.mjs');
    const checks = readReviewChecks({ repo: 'owner/repo', headSha,
      run: rerunReader([failed, passed], [restJob(failed, 1), restJob(passed, 2)]) });
    expect(reviewCiGate({ headSha, rowsComplete: true, requiredChecks: ['test'], checks }).allowed).toBe(true);
    expect(reviewCiGate({ headSha, rowsComplete: true, requiredChecks: ['test'],
      checks: JSON.parse(JSON.stringify(checks)) }).allowed).toBe(false);
  });

  it.each([
    ['job ID', { id: 999 }], ['workflow run', { run_id: 701 }],
    ['head', { head_sha: 'b'.repeat(40) }], ['check name', { name: 'other' }],
    ['check-run binding', { check_run_url: 'https://api.github.com/repos/owner/repo/check-runs/99' }],
    ['missing attempt', { run_attempt: undefined }], ['string attempt', { run_attempt: '2' }],
    ['invalid attempt', { run_attempt: 0 }],
  ])('mismatched or unreadable %s lineage never clears a failed attempt', (_label, change) => {
    expect(gate(args => readReviewChecks({ ...args,
      run: rerunReader([failed, passed], [restJob(failed, 1), { ...restJob(passed, 2), ...change }]) })))
      .toMatchObject({ allowed: false, reason: 'unreadable-ci' });
  });

  it('unavailable job evidence fails closed instead of trusting check-feed attempt fields', () => {
    expect(gate(args => readReviewChecks({ ...args,
      run: rerunReader([failed, { ...passed, run_id: 700, run_attempt: 2 }], []) })))
      .toMatchObject({ allowed: false, reason: 'unreadable-ci' });
  });

  it('foreign-repository job URLs fail closed before any job lookup', () => {
    const calls = [];
    const check = { ...failed, details_url: failed.details_url.replace('owner/repo', 'other/repo') };
    expect(gate(args => readReviewChecks({ ...args, run: rerunReader([check, passed], [], calls) })))
      .toMatchObject({ allowed: false, reason: 'unreadable-ci' });
    expect(calls.some(path => path.includes('/actions/jobs/'))).toBe(false);
  });

  it('oversized rerun lineage stops at 20 job reads and reports operator fallback', () => {
    const checks = Array.from({ length: 21 }, (_, index) => restCheck(index + 1));
    const calls = [];
    expect(gate(args => readReviewChecks({ ...args,
      run: rerunReader(checks, checks.map((check, index) => restJob(check, index + 1)), calls) })))
      .toMatchObject({ allowed: false, reason: 'unreadable-ci', error: expect.stringContaining('inspect Actions reruns') });
    expect(calls.filter(path => path.includes('/actions/jobs/'))).toHaveLength(20);
  });

  it('attempt inventories share the 20-read lineage budget with individual jobs', () => {
    const checks = Array.from({ length: 11 }, (_, index) => restCheck(index + 1));
    const calls = [];
    expect(gate(args => readReviewChecks({ ...args,
      run: rerunReader(checks, checks.map((check, index) => restJob(check, index + 1)), calls) })))
      .toMatchObject({ allowed: false, reason: 'unreadable-ci', error: expect.stringContaining('inspect Actions reruns') });
    expect(calls.filter(path => path.includes('/actions/'))).toHaveLength(20);
  });
});
