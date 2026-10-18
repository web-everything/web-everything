import { describe, it, expect, vi } from 'vitest';
import { rerequestMissingCheck, resolveMissingRunRerequestSettings, workflowProducesCheck } from '../missing-run-rerequest.mjs';
import { sweepMissingRunRecovery } from '../ci-red-recovery-watch.mjs';
import { attemptMissingCheckBaseRepair } from '../parked-pr-conflict-watch.mjs';
import { buildConflictFindingBody, defaultPostConflictFinding } from '../../lib/conflict-finding.mjs';
import { readFileSync } from 'node:fs';
import { reviewCiGate } from '../../lib/review-ci-gate.mjs';

const repo = 'web-everything/web-everything';
const sha = 'a'.repeat(40);
const now = Date.parse('2026-10-18T12:00:00Z');
const d = { headRefName: 'lane/example', prNumber: 5514, headSha: sha, check: 'standards', workflow: 'ci.yml' };
function fixture() {
  const comments = [];
  let head = sha;
  const exec = vi.fn((_cmd, args) => {
    if (args[0] === 'api' && args[1].includes('/contents/.github/workflows/'))
      return JSON.stringify({ encoding: 'base64', content: Buffer.from('jobs:\n  standards:\n    runs-on: ubuntu-latest\n').toString('base64') });
    if (args[0] === 'api' && args[1].endsWith('/runs?head_sha=' + sha + '&per_page=100'))
      return JSON.stringify([{ workflow_runs: [{ id: 123, head_sha: sha, path: '.github/workflows/ci.yml', status: 'completed', event: 'pull_request' }] }]);
    if (args[0] === 'api' && args[1].endsWith('/pulls/5514'))
      return JSON.stringify({ state: 'open', mergeable: true, head: { sha: head, ref: 'lane/example', repo: { full_name: repo } }, base: { ref: 'main' } });
    if (args[0] === 'run' && args[1] === 'rerun') return '';
    throw new Error('unexpected request');
  });
  const post = vi.fn((_pr, body) => { comments.push({ body, author: { login: 'chalbert' } }); return true; });
  return { comments, exec, post, move: () => { head = 'b'.repeat(40); },
    options: { repo, now, exec, checkClaim: () => null, readComments: () => comments, postComment: post } };
}
describe('missing required check re-request', () => {
  it('reruns only the matching workflow on the live head, reserving an attempt first; never passes the check', () => {
    const f = fixture();
    const result = rerequestMissingCheck(d, f.options);
    expect(result).toMatchObject({ ok: true, action: 'missing-check-rerun' });
    expect(f.exec.mock.calls.filter(([, a]) => a[0] === 'run').map(([, a]) => a)).toEqual([
      ['run', 'rerun', '123', '--repo', repo],
    ]);
    expect(f.exec.mock.calls.find(([, a]) => a[1]?.includes('/runs?'))[1]).toEqual(['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, '--paginate', '--slurp']);
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
  it.each([true, false])('a stale partial rollup routes standards recovery without a push (job exists: %s)', produces => {
    const f = fixture(); const trigger = vi.fn(); const repairBase = vi.fn(() => ({ ok: true, owner: 'fixer' }));
    const exec = (cmd, args, opts) => !produces && args[1]?.includes('/contents/')
      ? JSON.stringify({ encoding: 'base64', content: Buffer.from('jobs:\n  test:\n    runs-on: ubuntu-latest\n').toString('base64') }) : f.exec(cmd, args, opts);
    const result = sweepMissingRunRecovery({ repo, apply: true, now, mainRuns: [], readPush: () => null,
      readOpenPrs: () => [{ number: 5514, headRefOid: sha, headRefName: 'lane/example', baseRefName: 'main', mergeable: 'MERGEABLE',
        labels: [{ name: 'review:human' }, { name: 'status:awaiting-review' }],
        statusCheckRollup: ['test', 'test-shard (1)', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })) }],
      readRequiredContexts: () => ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'], readAttributedRequiredChecks: () => null,
      readHeadCommittedAt: () => '2026-10-18T10:00:00Z', readComments: () => [], trigger,
      rerequest: (candidate, options) => rerequestMissingCheck(candidate, { ...f.options, ...options, exec, repairBase, readComments: () => f.comments, postComment: f.post }),
    });
    expect(result.applied).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true, check: 'standards' })]));
    expect(trigger).not.toHaveBeenCalled();
    expect(repairBase).toHaveBeenCalledTimes(produces ? 0 : 1);
    expect(f.exec.mock.calls.filter(([, a]) => a[0] === 'run')).toHaveLength(produces ? 1 : 0);
  });
  it('routes a proven absent job to base repair, never reruns, and durably caps failures per head', () => {
    const f = fixture(); const repairBase = vi.fn(() => ({ ok: false, deferred: true, reason: 'owner unavailable' }));
    const exec = (cmd, args, opts) => args[1]?.includes('/contents/')
      ? JSON.stringify({ encoding: 'base64', content: Buffer.from('jobs:\n  test:\n    runs-on: ubuntu-latest\n').toString('base64') }) : f.exec(cmd, args, opts);
    const options = { ...f.options, exec, repairBase };
    expect(rerequestMissingCheck(d, options)).toMatchObject({ action: 'missing-check-base-repair', deferred: true });
    expect(repairBase).toHaveBeenCalledWith(expect.objectContaining({ check: 'standards', headSha: sha }), expect.objectContaining({ repo, pr: expect.objectContaining({ headRefName: 'lane/example' }) }));
    expect(rerequestMissingCheck(d, { ...options, now: now + 15 * 60000 }).deferred).toBe(true);
    expect(rerequestMissingCheck(d, { ...options, now: now + 30 * 60000 }).reason).toBe('attempt-cap');
    expect(repairBase).toHaveBeenCalledTimes(2);
    expect(f.exec.mock.calls.some(([, a]) => a[0] === 'run' || a[1]?.includes('/runs?'))).toBe(false);
    expect(f.comments[0].body).toContain('missing-check-base-repair');
  });
  it.each([null, 'jobs: [', 'jobs: {}', 'jobs:\n  reusable:\n    uses: owner/repo/.github/workflows/ci.yml@main', 'jobs:\n  matrix:\n    name: ${{ matrix.check }}'])('defers unknown workflow production without reserving or rerunning: %s', workflow => {
    const f = fixture(); const repairBase = vi.fn();
    const exec = (cmd, args, opts) => {
      if (!args[1]?.includes('/contents/')) return f.exec(cmd, args, opts);
      if (workflow === null) throw new Error('unavailable');
      return JSON.stringify({ encoding: 'base64', content: Buffer.from(workflow).toString('base64') });
    };
    expect(rerequestMissingCheck(d, { ...f.options, exec, repairBase })).toMatchObject({ deferred: true });
    expect(f.post).not.toHaveBeenCalled(); expect(repairBase).not.toHaveBeenCalled();
    expect(f.exec.mock.calls.some(([, a]) => a[0] === 'run')).toBe(false);
  });
  it('base owner resolves card/decision PRs and sends code PRs through the conflict finding path', () => {
    const attemptCardRebase = vi.fn(() => ({ action: 'rebased', newCommit: 'b'.repeat(40) }));
    const postFinding = vi.fn(); const attemptMechanicalRebase = vi.fn();
    const pr = { number: 5514, headRefName: 'lane/example', baseRefName: 'main' };
    expect(attemptMissingCheckBaseRepair(d, { repo, pr, listPrFiles: () => [{ path: 'backlog/123-decision.md' }], attemptCardRebase, postFinding, attemptMechanicalRebase })).toMatchObject({ ok: true, owner: 'card-conflict-resolver' });
    expect(attemptCardRebase).toHaveBeenCalledOnce();
    expect(attemptMissingCheckBaseRepair(d, { repo, pr, listPrFiles: () => [{ path: 'scripts/code.mjs' }], attemptCardRebase, postFinding, attemptMechanicalRebase })).toMatchObject({ ok: true, owner: 'fixer' });
    expect(postFinding).toHaveBeenCalledWith(expect.objectContaining({ baseRepair: expect.objectContaining({ check: 'standards' }) }));
    expect(attemptMechanicalRebase).not.toHaveBeenCalled();
  });
  it('recognizes explicit job names and rules out unrelated matrix names', () => {
    expect(workflowProducesCheck('jobs:\n  gate:\n    name: standards\n', 'standards')).toBe(true);
    expect(workflowProducesCheck('jobs:\n  standards:\n    name: renamed\n', 'standards')).toBe(false);
    expect(workflowProducesCheck('jobs:\n  shard:\n    name: test-shard (${{ matrix.shard }})\n    strategy:\n      matrix:\n        shard: [1, 2]\n', 'standards')).toBe(false);
  });
  it.each(['moved', 'reservation-failed', 'moved-after-reservation', 'fork', 'stack'])('absent-job handoff respects the live target and reservation: %s', kind => {
    const f = fixture(); const repairBase = vi.fn();
    const exec = (cmd, args, opts) => {
      if (args[1]?.includes('/contents/')) return JSON.stringify({ encoding: 'base64', content: Buffer.from('jobs:\n  test: {}\n').toString('base64') });
      const value = f.exec(cmd, args, opts);
      if (args[1]?.endsWith('/pulls/5514')) {
        const pr = JSON.parse(value);
        if (kind === 'fork') pr.head.repo.full_name = 'other/repo';
        if (kind === 'stack') pr.base.ref = 'lane/parent';
        return JSON.stringify(pr);
      }
      return value;
    };
    if (kind === 'moved') f.move();
    const postComment = (pr, body) => {
      if (kind === 'reservation-failed') return false;
      f.post(pr, body);
      if (kind === 'moved-after-reservation') f.move();
      return true;
    };
    expect(rerequestMissingCheck(d, { ...f.options, exec, postComment, repairBase })).toMatchObject({ deferred: true });
    expect(repairBase).not.toHaveBeenCalled();
  });
  it('unknown file lists and card resolver failures defer to a later bounded attempt', () => {
    const pr = { number: 5514, headRefName: 'lane/example', baseRefName: 'main' };
    const postFinding = vi.fn();
    for (const files of [null, [], [{}]]) expect(attemptMissingCheckBaseRepair(d, { repo, pr, listPrFiles: () => files, postFinding })).toMatchObject({ deferred: true });
    expect(attemptMissingCheckBaseRepair(d, { repo, pr, listPrFiles: () => ['backlog/123.md'], postFinding,
      attemptCardRebase: () => ({ action: 'skip', reason: 'unresolved content conflict' }) })).toMatchObject({ deferred: true });
    expect(postFinding).not.toHaveBeenCalled();
  });
  it('the existing finding transport carries the base-fix brief to the fixer', () => {
    const baseRepair = { check: 'standards', workflow: 'ci.yml', headSha: sha };
    const pr = { number: 5514, headRefName: 'lane/example' };
    const body = buildConflictFindingBody(pr, { baseRepair });
    expect(body).toContain('no job producing it'); expect(body).toContain('fast-forward');
    expect(body).not.toContain('mergeable: CONFLICTING');
    const exec = vi.fn((_cmd, argv) => {
      expect(argv[0]).toContain('reconcile-finding.mjs');
      expect(readFileSync(argv.find(a => a.startsWith('--body-file=')).slice(12), 'utf8')).toBe(body);
    });
    defaultPostConflictFinding({ pr, repo, baseRepair, exec });
    expect(exec).toHaveBeenCalledOnce();
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
  it('shared recovery counts other checks and ignores untrusted markers', () => {
    const f = fixture();
    rerequestMissingCheck(d, f.options);
    const reservation = f.comments[0];
    const record = JSON.parse(reservation.body.split('\n')[1]);
    f.comments.length = 0;
    for (const [key, value] of Object.entries({ repo: 'other/repo', pr: 5511, head: 'b'.repeat(40), check: 'test' })) {
      f.comments.push({ ...reservation, body: reservation.body.split('\n')[0] + '\n' + JSON.stringify({ ...record, [key]: value }) });
    }
    f.comments.push({ ...reservation, author: { login: 'untrusted-user' } });
    expect(rerequestMissingCheck(d, f.options)).toMatchObject({ deferred: true, reason: 'attempt-cap' });
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

describe('missing-check recovery retains main eligibility and shared budgets', () => {
  it.each([true, false])('refuses live ineligible PRs before reservation or %s-path mutation', produces => {
    for (const patch of [p => { p.mergeable = null; }, p => { p.mergeable = false; },
      p => { p.head.ref = 'feature/example'; }, p => { p.base.ref = 'stack'; }]) {
      const f = fixture(), repairBase = vi.fn();
      const exec = (cmd, args, opts) => {
        if (!produces && args[1]?.includes('/contents/')) return JSON.stringify({ encoding: 'base64', content: Buffer.from('jobs:\n  test: {}\n').toString('base64') });
        const raw = f.exec(cmd, args, opts);
        if (!args[1]?.endsWith('/pulls/5514')) return raw;
        const pr = JSON.parse(raw); patch(pr); return JSON.stringify(pr);
      };
      expect(rerequestMissingCheck(d, { ...f.options, exec, repairBase })).toMatchObject({ deferred: true });
      expect(f.post).not.toHaveBeenCalled(); expect(repairBase).not.toHaveBeenCalled();
      expect(f.exec.mock.calls.some(([, a]) => a[0] === 'run')).toBe(false);
    }
  });
  it.each([1, 2])('checks live claims at preflight %s', heldOn => {
    const f = fixture(); let calls = 0;
    expect(rerequestMissingCheck(d, { ...f.options, checkClaim: () => ++calls >= heldOn ? { message: 'claimed' } : null }))
      .toMatchObject({ deferred: true });
    expect(f.exec.mock.calls.some(([, a]) => a[0] === 'run')).toBe(false);
    expect(f.post).toHaveBeenCalledTimes(heldOn - 1);
  });
  it('an exhausted legacy SHA budget prevents targeted recovery before any IO', async () => {
    const { buildMissingRunComment } = await import('../main-red-recovery.mjs');
    const f = fixture();
    f.comments.push(...Array.from({ length: 2 }, () => ({ author: { login: 'chalbert' },
      body: buildMissingRunComment({ headSha: sha, headRefName: d.headRefName }) })));
    expect(rerequestMissingCheck(d, { ...f.options, maxRetriesPerSha: 2 })).toMatchObject({ reason: 'attempt-cap' });
    expect(f.exec).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled();
  });
  it('the PR cap includes legacy attempts on earlier heads', async () => {
    const { buildMissingRunComment } = await import('../main-red-recovery.mjs');
    const f = fixture();
    f.comments.push({ author: { login: 'chalbert' }, body: buildMissingRunComment({ headSha: 'b'.repeat(40) }) });
    expect(rerequestMissingCheck(d, { ...f.options, maxRetriesPerPr: 1 })).toMatchObject({ reason: 'attempt-cap' });
    expect(f.exec).not.toHaveBeenCalled();
  });
});
