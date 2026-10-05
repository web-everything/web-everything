import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchTimeoutRetry, timeoutGithubEffects } from '../ci-heal-pr-dispatch.mjs';
import { readTimeoutBudget } from '../../conveyor/timeout-retry-state.mjs';

// Dispatch-level coverage of the infra-cancelled re-run path (PR #4024 review): the planner tests pin WHEN a re-run
// is planned; these pin what the dispatch then DOES — which endpoint, which cap, which job states it will touch, and
// that an infra re-run never files a flaky-test follow-up card.
const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);
const infraEvidence = (over = {}) => ({ eligible: true, infraCancelled: true, cap: 6, repo, pr: 4023, head, signature: 'infra',
  jobs: [{ run: 10, job: 20, attempt: 1 }], ...over });
const timeoutEvidence = (over = {}) => ({ eligible: true, repo, pr: 4023, head, signature: 'timeout',
  failures: [{ path: 'scripts/x.test.mjs', name: 'a', kind: 'test-timeout' }], jobs: [{ run: 10, job: 20, attempt: 1 }], ...over });
const observe = (conclusion) => (e, j) => ({ repo: e.repo, head: e.head, runHead: e.head, open: true, run: j.run, job: j.job,
  jobRun: j.run, attempt: j.attempt, jobAttempt: j.attempt, status: 'completed', conclusion });

async function harness(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'infra-rerun-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('infra-cancelled dispatch', () => {
  it('re-runs the WHOLE run via rerun-failed-jobs for infra evidence, and the single job for an ordinary timeout', () => {
    const calls = [];
    const effects = timeoutGithubEffects({ exec: (_cmd, args) => { calls.push(args.at(-1)); return 'HTTP/2.0 201 Created\n\n'; } });
    expect(effects.request(infraEvidence(), infraEvidence().jobs[0])).toEqual({ status: 'confirmed' });
    expect(effects.request(timeoutEvidence(), timeoutEvidence().jobs[0])).toEqual({ status: 'confirmed' });
    expect(calls).toEqual([`repos/${repo}/actions/runs/10/rerun-failed-jobs`, `repos/${repo}/actions/jobs/20/rerun`]);
  });

  it('spends up to the infra cap (6) of confirmed re-runs, then refuses; an ordinary timeout stops at 2', async () => harness(async (dir) => {
    const request = vi.fn(() => ({ status: 'confirmed' }));
    const opts = { dir, repo, effects: { observe: observe('cancelled'), request }, fileFollowup: vi.fn(async () => {}) };
    const results = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      results.push(await dispatchTimeoutRetry(infraEvidence({ jobs: [{ run: 10, job: 20, attempt }] }), opts));
    }
    expect(results.map((r) => r.status)).toEqual(['requested', 'requested', 'requested', 'requested', 'requested', 'requested', 'refused', 'refused']);
    expect(results[6]).toMatchObject({ reason: 'timeout-retries-exhausted' });
    expect(request).toHaveBeenCalledTimes(6);
    expect(readTimeoutBudget({ repo, pr: 4023, head, dir })).toMatchObject({ confirmed: 6, pending: false });
  }));

  it('an ordinary (non-infra) timeout is still capped at 2 confirmed re-runs', async () => harness(async (dir) => {
    const request = vi.fn(() => ({ status: 'confirmed' }));
    const opts = { dir, repo, effects: { observe: observe('failure'), request }, fileFollowup: vi.fn(async () => {}) };
    const statuses = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      statuses.push((await dispatchTimeoutRetry(timeoutEvidence({ jobs: [{ run: 10, job: 20, attempt }] }), opts)).status);
    }
    expect(statuses).toEqual(['requested', 'requested', 'refused', 'refused']);
    expect(request).toHaveBeenCalledTimes(2);
  }));

  it('files NO flaky-test follow-up card for infra re-runs (at 2 or at the cap), but still files one for ordinary timeouts at 2', async () => harness(async (dir) => {
    const infraFile = vi.fn(async () => {});
    const infraOpts = { dir, repo, effects: { observe: observe('cancelled'), request: () => ({ status: 'confirmed' }) }, fileFollowup: infraFile };
    for (let attempt = 1; attempt <= 7; attempt++) await dispatchTimeoutRetry(infraEvidence({ jobs: [{ run: 10, job: 20, attempt }] }), infraOpts);
    expect(infraFile).not.toHaveBeenCalled();

    mkdirSync(join(dir, 'backlog'), { recursive: true }); // the follow-up planner reads the (empty) backlog for the next card number
    const timeoutFile = vi.fn(async () => {});
    const timeoutOpts = { dir, repo, root: dir, effects: { observe: observe('failure'), request: () => ({ status: 'confirmed' }) }, fileFollowup: timeoutFile };
    for (let attempt = 1; attempt <= 2; attempt++) await dispatchTimeoutRetry(timeoutEvidence({ pr: 4024, jobs: [{ run: 10, job: 20, attempt }] }), timeoutOpts);
    expect(timeoutFile).toHaveBeenCalledTimes(1);
  }));

  it('refuses to re-run an infra job that has since succeeded / been skipped, but re-runs one that is still cancelled', async () => harness(async (dir) => {
    for (const [i, conclusion] of ['success', 'skipped', 'neutral'].entries()) {
      const request = vi.fn(() => ({ status: 'confirmed' }));
      const result = await dispatchTimeoutRetry(infraEvidence({ pr: 5000 + i, signature: conclusion }),
        { dir, repo, effects: { observe: observe(conclusion), request } });
      expect(result).toMatchObject({ status: 'refused', reason: 'job-no-longer-failed-at-evidenced-attempt' });
      expect(request).not.toHaveBeenCalled();
    }
    const request = vi.fn(() => ({ status: 'confirmed' }));
    expect(await dispatchTimeoutRetry(infraEvidence({ pr: 6000 }), { dir, repo, effects: { observe: observe('cancelled'), request } }))
      .toMatchObject({ status: 'requested', run: 10, job: 20 });
    expect(request).toHaveBeenCalledTimes(1);
  }));

  it('an ordinary timeout is NOT re-run when its job concluded cancelled (only `failure` is evidence of a flake)', async () => harness(async (dir) => {
    const request = vi.fn(() => ({ status: 'confirmed' }));
    expect(await dispatchTimeoutRetry(timeoutEvidence(), { dir, repo, effects: { observe: observe('cancelled'), request } }))
      .toMatchObject({ reason: 'job-no-longer-failed-at-evidenced-attempt' });
    expect(request).not.toHaveBeenCalled();
  }));

  it('rejected and refused infra re-runs are counted per head, so the planner can stop re-planning them', async () => harness(async (dir) => {
    const e = infraEvidence();
    // API-rejected request (4xx).
    await dispatchTimeoutRetry(e, { dir, repo, effects: { observe: observe('cancelled'), request: () => ({ status: 'rejected' }) } });
    // Refused because the job is no longer failed at the evidenced attempt.
    await dispatchTimeoutRetry({ ...e, jobs: [{ run: 10, job: 20, attempt: 2 }] }, { dir, repo, effects: { observe: observe('success'), request: vi.fn() } });
    expect(readTimeoutBudget({ repo, pr: 4023, head, dir })).toEqual({ confirmed: 0, rejected: 2, pending: false });
  }));
});
