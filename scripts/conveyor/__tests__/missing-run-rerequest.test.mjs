import { describe, it, expect, vi } from 'vitest';
import { rerequestMissingCheck, resolveMissingRunRerequestSettings } from '../missing-run-rerequest.mjs';
import { sweepMissingRunRecovery } from '../ci-red-recovery-watch.mjs';
import { reviewCiGate } from '../../lib/review-ci-gate.mjs';

const repo = 'web-everything/web-everything';
const sha = 'a'.repeat(40);
const now = Date.parse('2026-10-18T12:00:00Z');
const d = { prNumber: 5514, headSha: sha, check: 'standards', workflow: 'ci.yml' };
function fixture() {
  const comments = [];
  let head = sha;
  const exec = vi.fn((_cmd, args) => {
    if (args[0] === 'api' && args[1].endsWith('/runs?head_sha=' + sha + '&per_page=100'))
      return JSON.stringify([{ workflow_runs: [{ id: 123, head_sha: sha, path: '.github/workflows/ci.yml', status: 'completed', event: 'pull_request' }] }]);
    if (args[0] === 'api' && args[1].endsWith('/pulls/5514'))
      return JSON.stringify({ state: 'open', head: { sha: head, repo: { full_name: repo } }, base: { ref: 'main' } });
    if (args[0] === 'run' && args[1] === 'rerun') return '';
    throw new Error('unexpected request');
  });
  const post = vi.fn((_pr, body) => { comments.push({ body, author: { login: 'chalbert' } }); return true; });
  return { comments, exec, post, move: () => { head = 'b'.repeat(40); },
    options: { repo, now, exec, readComments: () => comments, postComment: post } };
}
describe('missing required check re-request', () => {
  it('reruns only the matching workflow on the live head, reserving an attempt first; never passes the check', () => {
    const f = fixture();
    const result = rerequestMissingCheck(d, f.options);
    expect(result).toMatchObject({ ok: true, action: 'missing-check-rerun' });
    expect(f.exec.mock.calls.filter(([, a]) => a[0] === 'run').map(([, a]) => a)).toEqual([
      ['run', 'rerun', '123', '--repo', repo],
    ]);
    expect(f.exec.mock.calls[0][1]).toEqual(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, '--paginate', '--slurp']);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post.mock.invocationCallOrder[0]).toBeLessThan(f.exec.mock.invocationCallOrder.at(-1));
    expect(reviewCiGate({ headSha: sha, requiredChecks: ['test', 'standards'], checks: [{ name: 'test', status: 'completed', conclusion: 'success' }] }))
      .toMatchObject({ allowed: false, affected: [{ name: 'standards', reason: 'missing' }] });
  });
  it('durably enforces cooldown and per-head cap across invocations', () => {
    const f = fixture();
    expect(rerequestMissingCheck(d, f.options).ok).toBe(true);
    expect(rerequestMissingCheck(d, { ...f.options, now: now + 14 * 60000 }).deferred).toBe(true);
    expect(rerequestMissingCheck(d, { ...f.options, now: now + 15 * 60000 }).ok).toBe(true);
    expect(rerequestMissingCheck(d, { ...f.options, now: now + 30 * 60000 })).toMatchObject({ deferred: true, reason: 'attempt-cap' });
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it('defers when the head moves between planning and acting', () => {
    const f = fixture(); f.move();
    expect(rerequestMissingCheck(d, f.options).deferred).toBe(true);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([, a]) => a[0] === 'run')).toBe(false);
  });
  it('does not act without a durable reservation or on unreadable comments', () => {
    const f = fixture();
    expect(rerequestMissingCheck(d, { ...f.options, postComment: () => false }).deferred).toBe(true);
    expect(rerequestMissingCheck(d, { ...f.options, readComments: () => null }).deferred).toBe(true);
    expect(f.exec.mock.calls.some(([, a]) => a[0] === 'run')).toBe(false);
  });
  it('a stale partial rollup in review receives one standards re-request instead of a push', () => {
    const f = fixture(); const trigger = vi.fn();
    const result = sweepMissingRunRecovery({ repo, apply: true, now, mainRuns: [], readPush: () => null,
      readOpenPrs: () => [{ number: 5514, headRefOid: sha, headRefName: 'lane/example', baseRefName: 'main', mergeable: 'MERGEABLE',
        labels: [{ name: 'review:human' }, { name: 'status:awaiting-review' }],
        statusCheckRollup: ['test', 'test-shard (1)', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })) }],
      readRequiredContexts: () => ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'], readAttributedRequiredChecks: () => null,
      readHeadCommittedAt: () => '2026-10-18T10:00:00Z', readComments: () => [], trigger,
      rerequest: (candidate, options) => rerequestMissingCheck(candidate, { ...f.options, ...options, exec: f.exec, readComments: () => f.comments, postComment: f.post }),
    });
    expect(result.applied).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, check: 'standards' })]));
    expect(trigger).not.toHaveBeenCalled();
  });
  it('allows a positive configured cooldown and reports the settings source', () => {
    expect(resolveMissingRunRerequestSettings({ env: {}, settings: { missingRunRerequest: { cooldownMinutes: 5 } } }))
      .toMatchObject({ value: { cooldownMinutes: 5 }, sources: { cooldownMinutes: 'tool' } });
  });
  it('reserves failed submissions so repeated errors stop at the cap', () => {
    const f = fixture(); const exec = (...args) => {
      if (args[1][0] === 'run') throw new Error('private child error');
      return f.exec(...args);
    };
    expect(rerequestMissingCheck(d, { ...f.options, exec })).toMatchObject({ ok: false, deferred: false });
    expect(rerequestMissingCheck(d, { ...f.options, exec, now: now + 60000 }).reason).toBe('cooldown');
    expect(rerequestMissingCheck(d, { ...f.options, exec, now: now + 15 * 60000 }).ok).toBe(false);
    expect(rerequestMissingCheck(d, { ...f.options, exec, now: now + 30 * 60000 }).reason).toBe('attempt-cap');
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it.each(['no-run', 'wrong-head', 'active', 'wrong-workflow', 'push-event'])('never reruns an unsuitable workflow: %s', kind => {
    const f = fixture();
    const exec = (cmd, args, opts) => args[1]?.includes('/runs?') ? JSON.stringify([{ workflow_runs: kind === 'no-run' ? [] : [{
      id: 123, head_sha: kind === 'wrong-head' ? 'b'.repeat(40) : sha,
      path: kind === 'wrong-workflow' ? '.github/workflows/other.yml' : '.github/workflows/ci.yml',
      status: kind === 'active' ? 'in_progress' : 'completed', event: kind === 'push-event' ? 'push' : 'pull_request',
    }] }]) : f.exec(cmd, args, opts);
    expect(rerequestMissingCheck(d, { ...f.options, exec }).deferred).toBe(true);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([, a]) => a[0] === 'run')).toBe(false);
  });
  it('rechecks the head after reserving, before submitting the rerun', () => {
    const f = fixture();
    expect(rerequestMissingCheck(d, { ...f.options, postComment: (pr, body) => { f.post(pr, body); f.move(); return true; } }).deferred).toBe(true);
    expect(f.exec.mock.calls.some(([, a]) => a[0] === 'run')).toBe(false);
  });
  it('disabled requests do no IO', () => {
    const f = fixture();
    expect(rerequestMissingCheck(d, { ...f.options, policy: { enabled: 'off' } }).reason).toBe('disabled');
    expect(f.exec).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });
  it('budgets are isolated by repo, PR, head and check, and ignore untrusted markers', () => {
    const f = fixture();
    rerequestMissingCheck(d, f.options);
    const reservation = f.comments[0];
    const record = JSON.parse(reservation.body.split('\n')[1]);
    f.comments.length = 0;
    for (const [key, value] of Object.entries({ repo: 'other/repo', pr: 5511, head: 'b'.repeat(40), check: 'test' })) {
      f.comments.push({ ...reservation, body: reservation.body.split('\n')[0] + '\n' + JSON.stringify({ ...record, [key]: value }) });
    }
    f.comments.push({ ...reservation, author: { login: 'untrusted-user' } });
    expect(rerequestMissingCheck(d, f.options).ok).toBe(true);
  });
  it('the real comment writer reserves through the PR thread before rerunning', () => {
    const f = fixture();
    const exec = vi.fn((cmd, args, opts) => args[0] === 'api' && args[1].endsWith('/issues/5514/comments') ? '{}' : f.exec(cmd, args, opts));
    const { postComment, ...options } = f.options;
    expect(rerequestMissingCheck(d, { ...options, exec }).ok).toBe(true);
    const write = exec.mock.calls.find(([, args]) => args[1].endsWith('/issues/5514/comments'));
    expect(write[1]).toEqual(['api', `repos/${repo}/issues/5514/comments`, '-f', expect.stringContaining('body=<!-- conveyor missing-check-rerequest -->')]);
    expect(exec.mock.calls.at(-1)[1]).toEqual(['run', 'rerun', '123', '--repo', repo]);
  });
  it('resolves env over file over defaults, with sources', () => {
    expect(resolveMissingRunRerequestSettings({ env: {}, settings: {} })).toMatchObject({ value: { enabled: 'on', cooldownMinutes: 15, maxAttemptsPerHead: 2 }, sources: { enabled: 'standard' } });
    expect(resolveMissingRunRerequestSettings({ env: { WE_MISSING_RUN_REREQUEST: 'off', WE_MISSING_RUN_COOLDOWN_MINUTES: '20' }, settings: { missingRunRerequest: { enabled: 'on', cooldownMinutes: 30 } } }))
      .toMatchObject({ value: { enabled: 'off', cooldownMinutes: 20 }, sources: { enabled: 'env', cooldownMinutes: 'env' } });
  });
});
