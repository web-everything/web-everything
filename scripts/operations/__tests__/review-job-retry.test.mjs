import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReviewJobIo, dispatchReviewJob, runReviewJobCli } from '../review-job.mjs';
import { readReviewJobRetry, writeReviewJobRetry } from '../review-job-retry.mjs';
import { tryReadCompletion } from '../completion-store.mjs';
import { writeReviewJobDone, writeReviewJobStarted } from '../review-job-envelope.mjs';
import { laneGitHardeningEnv } from '../../lib/lane-git-hardening.mjs';

const head = 'a'.repeat(40), repo = 'plateauapp/plateau-app', pr = 229;
const roots = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
    f.completion({ pid: 3999, status: 'done', outcome: 'auto-cleared', updatedAt: new Date().toISOString() });
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

describe('retry evidence and synthetic completion ownership', () => {
  const slug = 'review-pa-229';
  const retryPath = f => join(f.options.dir, '.retry', `${slug}.json`);
  function diskCompletion(f, pid) {
    const dir = join(f.options.dir, 'completions');
    writeReviewJobStarted({ session: slug, pr, pid, dir });
    f.options.readCompletion = session => tryReadCompletion(session, dir);
    f.options.retryTerminal = vi.fn(input => writeReviewJobDone({ ...input, dir }));
    return join(dir, `${slug}.json`);
  }
  it.each(['corrupt', 'unreadable'])('default completion reader refuses %s evidence without erasing historical exhaustion or admitting a job', kind => {
    const f = fixture(), dir = join(f.options.dir, 'completions');
    mkdirSync(dir);
    const path = join(dir, `${slug}.json`);
    if (kind === 'corrupt') writeFileSync(path, '{"infraStreak":21,');
    else mkdirSync(path); // EISDIR is a real read error regardless of the test user's privileges.
    vi.stubEnv('OPERATION_COMPLETIONS_DIR', dir);
    f.options.readCompletion = undefined; // Exercise dispatch's production reader, not an injected refusal.
    expect(f.dispatch).toThrow(kind === 'corrupt' ? /refusing to read completion record/ : /EISDIR/);
    expect(f.options.spawnJob).not.toHaveBeenCalled(); expect(f.options.retryTerminal).not.toHaveBeenCalled();
    expect(existsSync(retryPath(f))).toBe(false);
    if (kind === 'corrupt') expect(readFileSync(path, 'utf8')).toBe('{"infraStreak":21,');
  });
  it.each([2, 3])('an unreadable completion on dispatch read %s refuses before spawn', failingRead => {
    const f = fixture();
    let reads = 0;
    f.options.readCompletion = () => { if (++reads === failingRead) throw Error('completion EACCES'); return null; };
    expect(f.dispatch).toThrow(/completion EACCES/);
    expect(f.options.spawnJob).not.toHaveBeenCalled();
  });
  it.each(['missing', 'unreadable'])('retains pending and preserves another live PID\'s started completion when the job claim is %s', claim => {
    const f = fixture(); f.dispatch();
    const pendingBytes = readFileSync(retryPath(f));
    const path = diskCompletion(f, 5000), completionBytes = readFileSync(path);
    const claimPath = join(f.options.dir, `${slug}.json`);
    if (claim === 'missing') rmSync(claimPath); else writeFileSync(claimPath, '{broken');
    f.options.isAlive = pid => pid === 5000;
    expect(f.dispatch().skipped).toMatch(/completion PID live or unknown/);
    expect(f.dispatch().skipped).toMatch(/inspect claim\/completion before re-arming/);
    expect(f.options.spawnJob).toHaveBeenCalledTimes(1); expect(f.options.retryTerminal).not.toHaveBeenCalled();
    expect(readFileSync(path).equals(completionBytes)).toBe(true);
    expect(readFileSync(retryPath(f)).equals(pendingBytes)).toBe(true);
  });
  it.each(['live', 'unknown', 'throws'])('retains the attempt when the pending PID is %s despite a missing job claim', liveness => {
    const f = fixture(); f.dispatch();
    const bytes = readFileSync(retryPath(f));
    rmSync(join(f.options.dir, `${slug}.json`));
    f.options.isAlive = () => { if (liveness === 'throws') throw Error('probe EACCES'); return liveness === 'live' ? true : null; };
    expect(f.dispatch().skipped).toMatch(/pending PID live or unknown/);
    expect(f.options.spawnJob).toHaveBeenCalledTimes(1); expect(f.options.retryTerminal).not.toHaveBeenCalled();
    expect(readFileSync(retryPath(f)).equals(bytes)).toBe(true);
  });
  it.each([undefined, 2 ** 31])('retains pending with a missing or oversized PID (%s) instead of guessing it died', pid => {
    const f = fixture(); f.dispatch();
    rmSync(join(f.options.dir, `${slug}.json`));
    const state = readReviewJobRetry(slug, f.options.dir);
    state.pending.pid = pid; writeReviewJobRetry(state, f.options.dir);
    f.options.isAlive = vi.fn(() => false);
    expect(f.dispatch().skipped).toMatch(/pending PID live or unknown/);
    expect(f.options.isAlive).not.toHaveBeenCalled(); expect(f.options.retryTerminal).not.toHaveBeenCalled();
    expect(readReviewJobRetry(slug, f.options.dir).pending).toBeDefined();
  });
  it.each(['unknown', 'throws'])('preserves a foreign completion when its PID liveness is %s', liveness => {
    const f = fixture(); f.dispatch(); rmSync(join(f.options.dir, `${slug}.json`));
    const path = diskCompletion(f, 5000), bytes = readFileSync(path);
    f.options.isAlive = pid => { if (pid !== 5000) return false; if (liveness === 'throws') throw Error('probe EACCES'); return null; };
    expect(f.dispatch().skipped).toMatch(/completion PID live or unknown/);
    expect(f.options.retryTerminal).not.toHaveBeenCalled(); expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(readReviewJobRetry(slug, f.options.dir).pending.pid).toBe(4001);
  });
  it('synthesizes the missing done only after proving both pending and foreign completion writers dead', () => {
    const f = fixture(); f.dispatch(); rmSync(join(f.options.dir, `${slug}.json`));
    const path = diskCompletion(f, 5000);
    f.options.isAlive = vi.fn(() => false);
    expect(f.dispatch().jobPid).toBe(4002);
    expect(f.options.isAlive).toHaveBeenCalledWith(4001); expect(f.options.isAlive).toHaveBeenCalledWith(5000);
    expect(f.options.retryTerminal).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ status: 'done', outcome: 'blocked-on-infra' });
  });
});
