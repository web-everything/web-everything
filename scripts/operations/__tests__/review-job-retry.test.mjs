import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReviewJobIo, dispatchReviewJob, runReviewJobCli } from '../review-job.mjs';
import { readReviewJobRetry } from '../review-job-retry.mjs';
import { laneGitHardeningEnv } from '../../lib/lane-git-hardening.mjs';

const head = 'a'.repeat(40), repo = 'plateauapp/plateau-app', pr = 229;
const roots = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'review-retry-')); roots.push(dir);
  let completion = null, now = Date.now(), pid = 4000, currentHead = head;
  const options = { repo, pr, root: '/daemon', dir, checkoutExists: () => true,
    checkStaleness: () => ({ fresh: true, behind: 0 }), isAlive: () => false, resolveSettingsEnv: () => ({}),
    ciGate: () => ({ allowed: true, headSha: currentHead }), readCompletion: () => completion,
    spawnJob: vi.fn(() => ++pid), publishNeedsYou: vi.fn(),
    retryTerminal: vi.fn(({ classified, pid: jobPid }) => { completion = { ...classified, pid: jobPid, status: 'done', updatedAt: new Date(now).toISOString() }; }),
    ...overrides };
  const dispatch = () => dispatchReviewJob({ ...options, now: ++now });
  const finish = outcome => { completion = { pid, status: 'done', outcome, updatedAt: new Date(++now).toISOString() }; };
  return { options, dispatch, finish, move: () => { currentHead = 'b'.repeat(40); },
    completion: value => { completion = value; } };
}

describe('private review lane fetch', () => {
  function lane({ originFails = false, fallbackFails = false, fetched = head, originRepo = repo } = {}) {
    const exec = vi.fn((file, args) => {
      if (file === 'gh') return JSON.stringify({ headRefOid: head });
      if (args[0] === 'remote') return `git@github.com:${originRepo}.git`;
      if (args[0] === 'fetch') {
        if ((args[2] === 'origin' && originFails) || (args[2] !== 'origin' && fallbackFails)) throw Error('transport failed');
        return '';
      }
      if (args[0] === 'rev-parse') return fetched;
      throw Error('unexpected command');
    });
    return { exec, prepare: () => createReviewJobIo({ exec, env: {} }).prepareLane({ pr, repo, lanePath: '/lane' }) };
  }
  it('uses the SSH origin first and retains every hardening pin', () => {
    const f = lane(); expect(f.prepare()).toEqual({ head });
    const calls = f.exec.mock.calls.filter(([file]) => file === 'git');
    expect(calls.filter(([, args]) => args[0] === 'fetch').map(([, args]) => args[2])).toEqual(['origin']);
    for (const [, , options] of calls) expect(options.env).toEqual(laneGitHardeningEnv({}));
  });
  it('uses HTTPS only after origin transport fails, still checks FETCH_HEAD', () => {
    const f = lane({ originFails: true }); expect(f.prepare()).toEqual({ head });
    expect(f.exec.mock.calls.filter(([, args]) => args[0] === 'fetch').map(([, args]) => args[2]))
      .toEqual(['origin', `https://github.com/${repo}.git`]);
    expect(() => lane({ originFails: true, fetched: 'b'.repeat(40) }).prepare()).toThrow(/head changed/);
    expect(() => lane({ originFails: true, fallbackFails: true }).prepare()).toThrow(/transport failed/);
  });
  it('refuses a lane from another repository before either fetch', () => {
    const f = lane({ originRepo: 'web-everything/web-everything' });
    expect(f.prepare).toThrow(/repository mismatch/);
    expect(f.exec.mock.calls.some(([, args]) => args[0] === 'fetch')).toBe(false);
  });
});

describe('job-mode retry parking', () => {
  it.each(['blocked-on-infra', 'crash', 'no done', 'unknown'])('bounds %s to three starts on one head and ONE escalation across repeated ticks', outcome => {
    const f = fixture();
    for (let n = 0; n < 3; n++) {
      expect(f.dispatch().jobPid).toBeGreaterThan(0);
      if (outcome === 'no done') f.completion(null); else f.finish(outcome);
    }
    for (let n = 0; n < 8; n++) expect(f.dispatch().skipped).toBe('review-job-parked');
    expect(f.options.spawnJob).toHaveBeenCalledTimes(3);
    expect(f.options.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.options.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({ head, command: expect.stringContaining('--expected-head=') }));
    if (outcome === 'no done') expect(f.options.retryTerminal).toHaveBeenCalledTimes(3);
  });
  it('migrates an exhausted historical infraStreak fail closed instead of starting job 22', () => {
    const f = fixture(); f.completion({ status: 'done', outcome: 'blocked-on-infra', infraStreak: 21 });
    expect(f.dispatch().skipped).toBe('review-job-parked');
    expect(f.options.spawnJob).not.toHaveBeenCalled();
    f.move(); expect(f.dispatch().jobPid).toBeGreaterThan(0);
  });
  it('a new head or explicit pinned re-arm starts a fresh budget; raising the cap alone does not', () => {
    const f = fixture({ env: { WE_REVIEW_JOB_FAILURE_CAP: '1' } });
    f.dispatch(); f.finish('blocked-on-infra'); expect(f.dispatch().skipped).toBe('review-job-parked');
    f.options.env.WE_REVIEW_JOB_FAILURE_CAP = '10'; expect(f.dispatch().skipped).toBe('review-job-parked');
    expect(() => runReviewJobCli(['rearm', `--pr=${pr}`, `--repo=${repo}`, `--expected-head=${head}`],
      { dir: f.options.dir, io: { checkoutExists: () => true, liveHead: () => 'b'.repeat(40) } })).toThrow(/head changed/);
    runReviewJobCli(['rearm', `--pr=${pr}`, `--repo=${repo}`, `--expected-head=${head}`],
      { dir: f.options.dir, io: { checkoutExists: () => true, liveHead: () => head } });
    expect(f.dispatch().jobPid).toBeGreaterThan(0);
    f.finish('blocked-on-infra'); f.move(); expect(f.dispatch().jobPid).toBeGreaterThan(0);
    expect(readReviewJobRetry('review-pa-229', f.options.dir).attempts).toBe(1);
  });
  it('healthy web-everything reviews reset the failure budget and retain normal job dispatch', () => {
    const f = fixture({ repo: 'web-everything/web-everything', pr: 10 });
    for (const outcome of ['auto-cleared', 'bounced', 'parked', 'carried', 'auto-cleared']) {
      expect(f.dispatch()).toMatchObject({ mode: 'job', sessionSlug: 'review-10', jobPid: expect.any(Number) }); f.finish(outcome);
    }
    expect(f.options.spawnJob).toHaveBeenCalledTimes(5); expect(f.options.publishNeedsYou).not.toHaveBeenCalled();
  });
  it('does not accept a stale clean completion as success for a crashed attempt', () => {
    const f = fixture({ env: { WE_REVIEW_JOB_FAILURE_CAP: '1' } });
    f.completion({ status: 'done', outcome: 'auto-cleared', updatedAt: new Date().toISOString() });
    f.dispatch(); expect(f.dispatch().skipped).toBe('review-job-parked');
    expect(f.options.retryTerminal).toHaveBeenCalledOnce();
  });
  it('refuses unreadable head and corrupt persisted evidence; operator can explicitly repair the latter', () => {
    const f = fixture({ ciGate: () => ({ allowed: true }) });
    expect(f.dispatch().skipped).toBe('review-job-head-unreadable'); expect(f.options.spawnJob).not.toHaveBeenCalled();
    f.options.ciGate = () => ({ allowed: true, headSha: head });
    mkdirSync(join(f.options.dir, '.retry'), { recursive: true });
    writeFileSync(join(f.options.dir, '.retry', 'review-pa-229.json'), '{broken');
    expect(f.dispatch).toThrow(/evidence unreadable/); expect(f.options.spawnJob).not.toHaveBeenCalled();
  });
});
