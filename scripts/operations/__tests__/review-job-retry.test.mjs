import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createReviewJobIo, dispatchReviewJob, runReviewJobCli, writeJobRecord } from '../review-job.mjs';
import { readReviewJobRetry, writeReviewJobRetry, rearmReviewJobRetry, settleReviewJobRetry } from '../review-job-retry.mjs';
import { tryReadCompletion } from '../completion-store.mjs';
import { writeReviewJobDone, writeReviewJobStarted } from '../review-job-envelope.mjs';
import { laneGitHardeningEnv, scrubGitRepoEnv } from '../../lib/lane-git-hardening.mjs';

const head = 'a'.repeat(40), repo = 'plateauapp/plateau-app', pr = 229;
const roots = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
  function lane({ originFails = false, fallbackFails = false, fetched = head, originRepo = repo, env = {} } = {}) {
    const exec = vi.fn((file, args) => {
      if (file === 'gh') return JSON.stringify({ headRefOid: head });
      if (args[0] === 'config') return '';
      if (args[0] === 'remote') return `git@github.com:${originRepo}.git`;
      if (args.includes('fetch')) {
        if ((args[5].startsWith('git@') && originFails) || (args[5].startsWith('https:') && fallbackFails)) throw Error('transport failed');
        return '';
      }
      if (args[0] === 'rev-parse') return fetched;
      throw Error('unexpected command');
    });
    return { exec, prepare: () => createReviewJobIo({ exec, env }).prepareLane({ pr, repo, lanePath: '/lane' }) };
  }
  it('uses the explicit SSH repository URL first and retains every hardening pin', () => {
    const env = { GIT_REF_PARANOIA: '0', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'lane-owned-command' };
    const f = lane({ env }); expect(f.prepare()).toEqual({ head });
    const calls = f.exec.mock.calls.filter(([file]) => file === 'git');
    expect(calls.filter(([, args]) => args.includes('fetch')).map(([, args]) => args)).toEqual([
      ['-c', 'protocol.ext.allow=never', 'fetch', '--upload-pack=git-upload-pack', '--no-tags', `git@github.com:${repo}.git`, `refs/pull/${pr}/head`],
    ]);
    for (const [, args, options] of calls) {
      // The scrub must see the actual lane config; fetch retains the standard hardening semantics.
      expect(options.env).toEqual(laneGitHardeningEnv(args[0] === 'config' ? scrubGitRepoEnv(env) : env));
    }
  });
  it('uses equally restricted HTTPS only after SSH transport fails, still checks FETCH_HEAD', () => {
    const f = lane({ originFails: true }); expect(f.prepare()).toEqual({ head });
    expect(f.exec.mock.calls.filter(([, args]) => args.includes('fetch')).map(([, args]) => args))
      .toEqual([`git@github.com:${repo}.git`, `https://github.com/${repo}.git`].map(url =>
        ['-c', 'protocol.ext.allow=never', 'fetch', '--upload-pack=git-upload-pack', '--no-tags', url, `refs/pull/${pr}/head`]));
    for (const [, , options] of f.exec.mock.calls.filter(([, args]) => args.includes('fetch'))) {
      expect(options.env).toEqual(laneGitHardeningEnv({}));
    }
    expect(() => lane({ originFails: true, fetched: 'b'.repeat(40) }).prepare()).toThrow(/head changed/);
    expect(() => lane({ originFails: true, fallbackFails: true }).prepare()).toThrow(/transport failed/);
  });
  it('refuses a lane from another repository before either fetch', () => {
    const f = lane({ originRepo: 'web-everything/web-everything' });
    expect(f.prepare).toThrow(/repository mismatch/);
    expect(f.exec.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });
  it('refuses an invalid repository argument before executing commands', () => {
    const exec = vi.fn();
    expect(() => createReviewJobIo({ exec }).prepareLane({ pr, repo: 'ext::lane-command', lanePath: '/lane' })).toThrow(/invalid review repository/);
    expect(exec).not.toHaveBeenCalled();
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
      { dir: f.options.dir, isAlive: () => false, io: { checkoutExists: () => true, liveHead: () => head } });
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

describe('pending ownership across re-arm and production PID probes', () => {
  const slug = 'review-pa-229';
  const retryPath = f => join(f.options.dir, '.retry', `${slug}.json`);
  const rearm = f => runReviewJobCli(['rearm', `--pr=${pr}`, `--repo=${repo}`, `--expected-head=${head}`],
    { dir: f.options.dir, io: { checkoutExists: () => true, liveHead: () => head } });
  function pending(claim = 'missing') {
    const f = fixture(); f.dispatch();
    const path = join(f.options.dir, `${slug}.json`);
    if (claim === 'missing') rmSync(path); else if (claim === 'corrupt') writeFileSync(path, '{broken');
    return f;
  }
  function rawProbe(outcome) {
    const original = process.kill.bind(process);
    return vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== 4001 || signal !== 0) return original(pid, signal);
      if (outcome === 'live') return true;
      throw Object.assign(Error('raw signal-zero probe'), { code: outcome === 'unknown' ? undefined : outcome });
    });
  }
  it.each(['EPERM', 'EACCES', 'EIO', 'unknown'])('default dispatch settlement retains pending on raw %s instead of synthesizing death', code => {
    const f = pending(), bytes = readFileSync(retryPath(f));
    rawProbe(code); f.options.isAlive = undefined;
    expect(f.dispatch().skipped).toMatch(/pending PID live or unknown/);
    expect(f.options.retryTerminal).not.toHaveBeenCalled(); expect(f.options.spawnJob).toHaveBeenCalledTimes(1);
    expect(readFileSync(retryPath(f)).equals(bytes)).toBe(true);
  });
  it.each(['before CI', 'during CI'])('default dispatch retains a claim with raw EACCES observed %s', timing => {
    const f = fixture(); rawProbe('EACCES'); f.options.isAlive = undefined;
    const claim = () => writeJobRecord({ slug, repo, pr, pid: 4001 }, f.options.dir);
    if (timing === 'before CI') claim();
    else f.options.ciGate = () => { claim(); return { allowed: true, headSha: head }; };
    expect(f.dispatch().skipped).toBe('live-job');
    expect(f.options.spawnJob).not.toHaveBeenCalled(); expect(f.options.retryTerminal).not.toHaveBeenCalled();
    expect(existsSync(retryPath(f))).toBe(false);
  });
  it.each(['missing', 'corrupt'].flatMap(claim => ['live', 'EPERM', 'EACCES', 'unknown'].map(probe => ({ claim, probe }))))(
    're-arm refuses a $probe pending PID despite a $claim claim, keeping dispatch blocked', ({ claim, probe }) => {
      const f = pending(claim), bytes = readFileSync(retryPath(f));
      rawProbe(probe);
      expect(() => rearm(f)).toThrow(/cannot re-arm: pending PID live or unknown/);
      f.options.isAlive = undefined;
      expect(f.dispatch().skipped).toMatch(/pending PID live or unknown/);
      expect(f.options.spawnJob).toHaveBeenCalledTimes(1); expect(f.options.retryTerminal).not.toHaveBeenCalled();
      expect(readFileSync(retryPath(f)).equals(bytes)).toBe(true);
    });
  it('standalone settlement and re-arm defaults also refuse raw EACCES', () => {
    const f = pending(), bytes = readFileSync(retryPath(f)); rawProbe('EACCES');
    expect(settleReviewJobRetry({ slug, repo, head, dir: f.options.dir, completion: null, cap: 3,
      terminal: f.options.retryTerminal }).skipped).toMatch(/pending PID live or unknown/);
    expect(() => rearmReviewJobRetry({ slug, repo, head, dir: f.options.dir })).toThrow(/pending PID live or unknown/);
    expect(f.options.retryTerminal).not.toHaveBeenCalled(); expect(readFileSync(retryPath(f)).equals(bytes)).toBe(true);
  });
  it.each(['missing', 'corrupt'])('re-arm releases pending only after raw ESRCH with a %s claim', claim => {
    const f = pending(claim); rawProbe('ESRCH');
    expect(rearm(f)).toMatchObject({ attempts: 0, parked: false });
    expect(readReviewJobRetry(slug, f.options.dir).pending).toBeUndefined();
    expect(f.dispatch().jobPid).toBe(4002);
  });
  it('default settlement synthesizes the terminal record only after raw ESRCH', () => {
    const f = pending(); rawProbe('ESRCH'); f.options.isAlive = undefined;
    expect(f.dispatch().jobPid).toBe(4002);
    expect(f.options.retryTerminal).toHaveBeenCalledOnce();
  });
  it('re-arm retains a readable claim when its signal-zero probe is unknown', () => {
    const f = pending('intact'), bytes = readFileSync(retryPath(f)); rawProbe('EACCES');
    expect(() => rearm(f)).toThrow(/cannot re-arm: claim PID live or unknown/);
    expect(readFileSync(retryPath(f)).equals(bytes)).toBe(true);
  });
  it.each(['corrupt', 'invalid-pending', 'wrong-repo'])('re-arm refuses %s retry state instead of erasing hidden pending ownership', kind => {
    const f = pending(), state = readReviewJobRetry(slug, f.options.dir);
    if (kind === 'invalid-pending') delete state.pending.baseline;
    if (kind === 'wrong-repo') state.repo = 'web-everything/web-everything';
    const bytes = kind === 'corrupt' ? '{"pending":{"pid":4001},' : JSON.stringify(state);
    writeFileSync(retryPath(f), bytes);
    expect(() => rearm(f)).toThrow(kind === 'wrong-repo' ? /repository mismatch/ : /retry evidence unreadable/);
    expect(readFileSync(retryPath(f), 'utf8')).toBe(bytes); expect(f.options.spawnJob).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 2 ** 31])('re-arm refuses a missing/oversized pending PID (%s) before a liveness probe', pid => {
    const f = pending(), state = readReviewJobRetry(slug, f.options.dir);
    state.pending.pid = pid; writeReviewJobRetry(state, f.options.dir);
    const bytes = readFileSync(retryPath(f)), isAlive = vi.fn(() => false);
    expect(() => runReviewJobCli(['rearm', `--pr=${pr}`, `--repo=${repo}`, `--expected-head=${head}`],
      { dir: f.options.dir, isAlive, io: { checkoutExists: () => true, liveHead: () => head } })).toThrow(/pending PID live or unknown/);
    expect(isAlive).not.toHaveBeenCalled(); expect(readFileSync(retryPath(f)).equals(bytes)).toBe(true);
  });
});
