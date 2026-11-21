import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchTimeoutRetry, timeoutGithubEffects } from '../ci-heal-pr-dispatch.mjs';
import { timeoutKey } from '../../conveyor/timeout-retry-state.mjs';

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
