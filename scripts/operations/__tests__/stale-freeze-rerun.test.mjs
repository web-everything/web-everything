import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchTimeoutRetry, timeoutGithubEffects, flushTimeoutFollowups } from '../ci-heal-pr-dispatch.mjs';
import { timeoutKey } from '../../conveyor/timeout-retry-state.mjs';
import { executeOwedCiReruns } from '../../conveyor/owed-ci-rerun-executor.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const head = 'a'.repeat(40), repo = 'owner/repo';
const green = { status: 'completed', conclusion: 'success', completed_at: '2026-11-18T11:00:00Z' };
const evidence = { eligible: true, repo, pr: 7266, head, run: 42, staleFreeze: true,
  completedAt: '2026-11-18T10:00:00Z', signature: 'stale-main-freeze:42', jobs: [{ run: 42, job: 123, attempt: 1 }] };
const observed = { repo, head, runHead: head, open: true, run: 42, job: 123, jobRun: 42,
  attempt: 1, jobAttempt: 1, jobName: 'merge-gate', status: 'completed', conclusion: 'failure' };
const fixture = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'stale-freeze-')); dirs.push(dir);
  return { repo, dir, effects: { observe: vi.fn(() => observed), request: vi.fn(() => ({ status: 'confirmed' })) },
    readMainCi: vi.fn(() => green), fileFollowup: vi.fn() };
};

describe('stale freeze rerun durable budget', () => {
  it.each(['merge-gate', 'another-job'])('observes the API job name %s through the real adapter and dispatcher', async name => {
    const opts = fixture();
    const exec = vi.fn((_command, args) => {
      if (args.includes('POST')) return 'HTTP/2.0 201 Created';
      const responses = {
        [`repos/${repo}/pulls/${evidence.pr}`]: { head: { sha: head }, state: 'open' },
        [`repos/${repo}/actions/jobs/123`]: { id: 123, name, run_id: 42, run_attempt: 1,
          status: 'completed', conclusion: 'failure' },
        [`repos/${repo}/actions/runs/42`]: { id: 42, head_sha: head, run_attempt: 1, repository: { full_name: repo } },
      };
      if (!responses[args[1]]) throw new Error(`unexpected API path: ${args[1]}`);
      return JSON.stringify(responses[args[1]]);
    });
    opts.effects = timeoutGithubEffects({ exec });
    expect(opts.effects.observe(evidence, evidence.jobs[0])).toEqual({ ...observed, jobName: name });
    const ordinary = { ...evidence, staleFreeze: false };
    expect(opts.effects.observe(ordinary, evidence.jobs[0])).not.toHaveProperty('jobName');
    const result = await dispatchTimeoutRetry(evidence, opts);
    expect(result.status).toBe(name === 'merge-gate' ? 'requested' : 'refused');
    expect(exec.mock.calls.filter(([, args]) => args.includes('POST'))).toHaveLength(name === 'merge-gate' ? 1 : 0);
    if (name !== 'merge-gate') expect(result.reason).toBe('stale-head-or-job');
  });
  it.each(['confirmed', 'rejected', 'ambiguous'])('reserves once per head+run across restart and newer attempts after %s', async status => {
    const opts = fixture(); opts.effects.request.mockReturnValue({ status });
    await dispatchTimeoutRetry(evidence, opts);
    const next = { ...evidence, jobs: [{ run: 42, job: 124, attempt: 2 }] };
    const again = await dispatchTimeoutRetry(next, { ...opts, effects: { ...opts.effects } });
    expect(again.reason).toMatch(/stale-freeze-rerun-spent.*inspect/);
    expect(opts.effects.request).toHaveBeenCalledTimes(1);
    expect(opts.fileFollowup).not.toHaveBeenCalled();
  });
  it.each([
    ['red', () => ({ ...green, conclusion: 'failure' })],
    ['pending', () => ({ ...green, status: 'in_progress' })],
    ['unreadable', () => { throw Error('offline'); }],
  ])('rechecks main immediately before requesting and refuses %s', async (_name, readMainCi) => {
    const opts = fixture();
    const out = await dispatchTimeoutRetry(evidence, { ...opts, readMainCi });
    expect(out.status).toBe('refused'); expect(opts.effects.request).not.toHaveBeenCalled();
    expect((await dispatchTimeoutRetry(evidence, opts)).status).toBe('requested');
  });
  it.each([
    ['wrong head', { head: 'b'.repeat(40) }], ['wrong job', { job: 999 }],
    ['wrong name', { jobName: 'test' }], ['pending job', { status: 'in_progress' }],
    ['new attempt', { attempt: 2 }], ['closed PR', { open: false }],
  ])('refuses %s without a rerun', async (_name, changes) => {
    const opts = fixture(); opts.effects.observe.mockReturnValue({ ...observed, ...changes });
    expect((await dispatchTimeoutRetry(evidence, opts)).status).toBe('refused');
    expect(opts.effects.request).not.toHaveBeenCalled();
  });
  it('refuses corrupt persisted state and does not send a request', async () => {
    const opts = fixture(); writeFileSync(join(opts.dir, `${timeoutKey(evidence)}.json`), 'corrupt');
    await expect(dispatchTimeoutRetry(evidence, opts)).rejects.toThrow();
    expect(opts.effects.request).not.toHaveBeenCalled();
  });
  it('does not reset old persisted reservations on the same run', async () => {
    const opts = fixture();
    writeFileSync(join(opts.dir, `${timeoutKey(evidence)}.json`), JSON.stringify({ version: 1, evidence,
      requests: [{ target: { run: 42, job: 111, attempt: 1 }, status: 'pending' }] }));
    expect((await dispatchTimeoutRetry(evidence, opts)).reason).toMatch(/spent.*inspect/);
    expect(opts.effects.request).not.toHaveBeenCalled();
  });
  it('shares reservations across concurrent callers', async () => {
    const opts = fixture();
    const results = await Promise.all([dispatchTimeoutRetry(evidence, opts), dispatchTimeoutRetry(evidence, opts)]);
    expect(results.filter(r => r.status === 'requested')).toHaveLength(1);
    expect(opts.effects.request).toHaveBeenCalledTimes(1);
  });
  it('a new run on the same head has its own single reservation', async () => {
    const opts = fixture();
    await dispatchTimeoutRetry(evidence, opts);
    const next = { ...evidence, run: 43, signature: 'stale-main-freeze:43', jobs: [{ run: 43, job: 124, attempt: 1 }] };
    opts.effects.observe.mockReturnValue({ ...observed, run: 43, jobRun: 43, job: 124 });
    expect((await dispatchTimeoutRetry(next, opts)).status).toBe('requested');
    expect((await dispatchTimeoutRetry(next, opts)).reason).toMatch(/spent/);
    expect(opts.effects.request).toHaveBeenCalledTimes(2);
  });
  it('uses the existing throttled job rerun endpoint and records before sending', async () => {
    const opts = fixture();
    const exec = vi.fn(() => {
      const state = JSON.parse(readFileSync(join(opts.dir, `${timeoutKey(evidence)}.json`), 'utf8'));
      expect(state.requests.at(-1).status).toBe('pending');
      return 'HTTP/2.0 201 Created';
    });
    opts.effects.request = timeoutGithubEffects({ exec }).request;
    expect((await dispatchTimeoutRetry(evidence, opts)).status).toBe('requested');
    expect(exec.mock.calls[0].slice(0, 2)).toEqual(['gh', ['api', '--include', '--method', 'POST', 'repos/owner/repo/actions/runs/' + evidence.run + '/rerun-failed-jobs']]);
  });
});

describe('stale freeze shared head cap and followup state', () => {
  it('uses new ordinary evidence when a legacy mixed head started with a stale freeze', async () => {
    const opts = fixture(); opts.root = opts.dir;
    writeFileSync(join(opts.dir, `${timeoutKey(evidence)}.json`), JSON.stringify({ version: 1, evidence,
      requests: [
        { signature: 'stale-main-freeze:40', target: { run: 40, job: 123, attempt: 1 }, status: 'confirmed' },
        { signature: 'test-timeout', target: { run: 41, job: 123, attempt: 1 }, status: 'confirmed' },
      ] }));
    const ordinary = { eligible: true, repo, pr: evidence.pr, head, signature: 'test-timeout', jobs: evidence.jobs,
      failures: [{ path: 'scripts/example.test.mjs', name: 'ordinary timeout', kind: 'test-timeout' }] };
    expect((await dispatchTimeoutRetry(ordinary, opts)).status).toBe('requested');
    expect(opts.fileFollowup).toHaveBeenCalledTimes(1);
    expect(opts.fileFollowup.mock.calls[0][0].content).toContain('ordinary timeout');
    expect(opts.fileFollowup.mock.calls[0][0].content).not.toContain('run 40');
  });
  it('does not file early when stale-freeze reruns follow an ordinary timeout, then reconciles an ambiguous ordinary retry', async () => {
    const opts = fixture(); opts.root = opts.dir;
    const ordinary = { eligible: true, repo, pr: evidence.pr, head, signature: 'test-timeout',
      failures: [{ path: 'scripts/example.test.mjs', name: 'ordinary timeout', kind: 'test-timeout' }] };
    expect((await dispatchTimeoutRetry({ ...ordinary, jobs: evidence.jobs }, opts)).status).toBe('requested');
    for (const run of [43, 44]) {
      opts.effects.observe.mockReturnValue({ ...observed, run, jobRun: run });
      expect((await dispatchTimeoutRetry({ ...evidence, run, signature: `stale-main-freeze:${run}`,
        jobs: [{ ...evidence.jobs[0], run }] }, opts)).status).toBe('requested');
    }
    await flushTimeoutFollowups(opts);
    expect(opts.fileFollowup).not.toHaveBeenCalled();
    opts.effects.observe.mockReturnValue({ ...observed, run: 45, jobRun: 45 });
    opts.effects.request.mockReturnValue({ status: 'ambiguous' });
    expect((await dispatchTimeoutRetry({ ...ordinary, jobs: [{ ...evidence.jobs[0], run: 45 }] }, opts)).reason).toBe('retry-outcome-pending');
    opts.effects.observe.mockReturnValue({ ...observed, run: 45, jobRun: 45, attempt: 2 });
    await flushTimeoutFollowups(opts);
    expect(opts.fileFollowup).toHaveBeenCalledTimes(1);
    const content = opts.fileFollowup.mock.calls[0][0].content;
    expect(content).toContain('run 42');
    expect(content).toContain('run 45');
    expect(content).not.toContain('run 43');
    expect(content).not.toContain('run 44');
  });
  it.each([false, true])('keeps ordinary retries and their followup after two stale-freeze reruns (legacy=%s)', async legacy => {
    const opts = fixture(); opts.root = opts.dir;
    for (const run of [42, 43]) {
      opts.effects.observe.mockReturnValue({ ...observed, run, jobRun: run });
      expect((await dispatchTimeoutRetry({ ...evidence, run, signature: `stale-main-freeze:${run}`,
        jobs: [{ ...evidence.jobs[0], run }] }, opts)).status).toBe('requested');
    }
    const path = join(opts.dir, `${timeoutKey(evidence)}.json`);
    if (legacy) {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      for (const request of state.requests) { delete request.staleFreeze; delete request.evidence; }
      writeFileSync(path, JSON.stringify(state));
    }
    const ordinary = { eligible: true, repo, pr: evidence.pr, head, signature: 'test-timeout',
      failures: [{ path: 'scripts/example.test.mjs', name: 'ordinary timeout', kind: 'test-timeout' }] };
    opts.fileFollowup.mockRejectedValueOnce(new Error('retry filing'));
    for (const run of [44, 45]) {
      opts.effects.observe.mockReturnValue({ ...observed, run, jobRun: run });
      expect((await dispatchTimeoutRetry({ ...ordinary, jobs: [{ ...evidence.jobs[0], run }] }, opts)).status).toBe('requested');
      expect(opts.fileFollowup).toHaveBeenCalledTimes(run === 44 ? 0 : 1);
    }
    await flushTimeoutFollowups({ ...opts, effects: { ...opts.effects } });
    expect(opts.fileFollowup).toHaveBeenCalledTimes(2);
    const payload = opts.fileFollowup.mock.calls[0][0];
    expect(opts.fileFollowup.mock.calls[1][0]).toEqual(payload);
    expect(payload.content).toContain('ordinary timeout');
    expect(payload.content).toContain('run 44');
    expect(payload.content).toContain('run 45');
    expect(payload.content).not.toContain('run 42');
    expect(payload.content).not.toContain('run 43');
    expect((await dispatchTimeoutRetry({ ...ordinary, jobs: [{ ...evidence.jobs[0], run: 46 }] }, opts)).reason).toBe('timeout-retries-exhausted');
    expect(opts.effects.request).toHaveBeenCalledTimes(4);
  });
  it.each(['rejected', 'ambiguous', 'confirmed'])('spent %s requests do not starve the eleventh PR on the next pass', async status => {
    const opts = fixture();
    opts.effects.request.mockReturnValue({ status });
    const rows = Array.from({ length: 11 }, (_, i) => ({ kind: 'ci-timeout-rerun', prNumber: 7266 + i,
      timeoutRetry: { ...evidence, pr: 7266 + i } }));
    const execute = () => executeOwedCiReruns({ rows, repo, checkStaleness: () => ({ fresh: true }),
      dispatchRetry: retry => dispatchTimeoutRetry(retry, opts) });
    expect((await execute()).skippedOverCap).toBe(1);
    expect(opts.effects.request).toHaveBeenCalledTimes(10);
    opts.effects.request.mockReturnValue({ status: 'confirmed' });
    const next = await execute();
    expect(next.requested).toEqual([7276]);
    expect(next.refused).toHaveLength(10);
    expect(next.refused.every(r => r.reason.startsWith('stale-freeze-rerun-spent;'))).toBe(true);
    expect(next.skippedOverCap).toBe(0);
    expect(opts.effects.request).toHaveBeenCalledTimes(11);
  });
  it('exhausted head caps also leave slots for later PRs, including legacy reservations', async () => {
    const opts = fixture();
    writeFileSync(join(opts.dir, `${timeoutKey(evidence)}.json`), JSON.stringify({ version: 1, evidence,
      requests: [40, 41].map(run => ({ signature: `stale-main-freeze:${run}`, target: { run, job: 123, attempt: 1 }, status: 'rejected' })) }));
    const rows = [evidence, { ...evidence, pr: 7267 }].map(timeoutRetry => ({
      kind: 'ci-timeout-rerun', prNumber: timeoutRetry.pr, timeoutRetry }));
    const out = await executeOwedCiReruns({ rows, repo, max: 1, checkStaleness: () => ({ fresh: true }),
      dispatchRetry: retry => dispatchTimeoutRetry(retry, opts) });
    expect(out.requested).toEqual([7267]);
    expect(out.refused[0].reason).toMatch(/^stale-freeze-head-cap;/);
    expect(out.skippedOverCap).toBe(0);
    expect(opts.effects.request).toHaveBeenCalledTimes(1);
  });
  it('fresh API rejections still consume the per-pass cap', async () => {
    const opts = fixture(); opts.effects.request.mockReturnValue({ status: 'rejected' });
    const rows = [evidence, { ...evidence, pr: 7267 }].map(timeoutRetry => ({
      kind: 'ci-timeout-rerun', prNumber: timeoutRetry.pr, timeoutRetry }));
    const out = await executeOwedCiReruns({ rows, repo, max: 1, checkStaleness: () => ({ fresh: true }),
      dispatchRetry: retry => dispatchTimeoutRetry(retry, opts) });
    expect(out.refused).toEqual([{ pr: 7266, reason: 'retry-api-rejected' }]);
    expect(out.skippedOverCap).toBe(1);
    expect(opts.effects.request).toHaveBeenCalledTimes(1);
  });
  it.each(['confirmed', 'rejected'])('caps %s stale-freeze reservations at two across run ids', async status => {
    const opts = fixture(); opts.effects.request.mockReturnValue({ status });
    for (const run of [42, 43]) {
      opts.effects.observe.mockReturnValue({ ...observed, run, jobRun: run });
      await dispatchTimeoutRetry({ ...evidence, run, signature: `stale-main-freeze:${run}`, jobs: [{ ...evidence.jobs[0], run }] }, opts);
    }
    expect((await dispatchTimeoutRetry({ ...evidence, run: 44, jobs: [{ ...evidence.jobs[0], run: 44 }] }, opts)).reason).toMatch(/stale-freeze-head-cap.*inspect/);
    expect(opts.effects.request).toHaveBeenCalledTimes(2);
    const state = JSON.parse(readFileSync(join(opts.dir, `${timeoutKey(evidence)}.json`), 'utf8'));
    expect(state.requests.every(r => r.staleFreeze === true)).toBe(true);
  });
  it('preserves the per-head cap for old unmarked stale-freeze reservations', async () => {
    const opts = fixture();
    writeFileSync(join(opts.dir, `${timeoutKey(evidence)}.json`), JSON.stringify({ version: 1, evidence,
      requests: [40, 41].map(run => ({ signature: `stale-main-freeze:${run}`, target: { run, job: 123, attempt: 1 }, status: 'confirmed' })) }));
    expect((await dispatchTimeoutRetry(evidence, opts)).reason).toMatch(/stale-freeze-head-cap.*inspect/);
    expect(opts.effects.request).not.toHaveBeenCalled();
  });
  it('two confirmed stale-freeze reservations survive an ordinary timeout followup flush', async () => {
    const opts = fixture();
    for (const run of [42, 43]) {
      opts.effects.observe.mockReturnValue({ ...observed, run, jobRun: run });
      expect((await dispatchTimeoutRetry({ ...evidence, run, signature: `stale-main-freeze:${run}`, jobs: [{ ...evidence.jobs[0], run }] }, opts)).status).toBe('requested');
    }
    const flushed = await flushTimeoutFollowups(opts);
    expect(flushed).toHaveLength(1);
    expect(flushed[0].reason).toBeUndefined();
    expect(opts.fileFollowup).not.toHaveBeenCalled();
  });
});
