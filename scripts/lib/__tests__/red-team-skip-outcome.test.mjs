// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyRedTeamSkip, settleRedTeamSkip } from '../red-team-skip-outcome.mjs';
import { parseRedTeamComment, redTeamForHead, redTeamMarker } from '../red-team-gate.mjs';
import { redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { writeJsonAtomic } from '../atomic-json-file.mjs';

vi.mock('../atomic-json-file.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, writeJsonAtomic: vi.fn(actual.writeJsonAtomic) };
});

const repo = 'web-everything/web-everything', pr = 5872, head = 'a'.repeat(40);
const policy = { status: 'skipped', policy: 'card-only', reason: 'red team skipped: card-only' };
const visibleReason = 'Red team not required on this head: card-only diff (policy redTeam.skipCardOnly)';
const nonPolicyCases = [
  ['no diff', { status: 'skipped', reason: 'the review printed no diff' }],
  ['no pinned head', { status: 'skipped', reason: 'the review printed no pinned head commit (netBasis.rev)' }],
  ['provider unavailable', { status: 'skipped', reason: 'provider unavailable' }],
  ['budget unavailable', { status: 'skipped', reason: 'daily-cap: no call launched' }],
  ['missing input', { status: 'skipped', reason: 'missing input' }],
  ['disabled', { status: 'disabled', policy: 'card-only', reason: 'disabled' }],
  ['error', { status: 'error', policy: 'card-only', reason: 'provider error' }],
  ['not-owed', { status: 'not-owed' }],
  ['not-owed with policy', { status: 'not-owed', policy: 'card-only' }],
  ['unknown shape', { unexpected: true }],
  ['null', null],
  ['undefined', undefined],
  ['string', 'card-only'],
  ['array', []],
  ['policy missing', { status: 'skipped', reason: 'policy field missing' }],
  ['reason string card-only WITHOUT policy field', { status: 'skipped', reason: 'red team skipped: card-only' }],
  ['unknown policy', { status: 'skipped', policy: 'other', reason: 'card-only' }],
  ['malformed policy', { status: 'skipped', policy: ['card-only'], reason: 'card-only' }],
];

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'red-team-skip-outcome-'));
  roots.push(root);
  const env = { WE_SHARED_RUNS_DIR: join(root, 'runs') };
  vi.stubEnv('WE_SHARED_RUNS_DIR', env.WE_SHARED_RUNS_DIR);
  const comments = [];
  const io = { env, log: vi.fn(),
    postComment: vi.fn(({ body }) => { comments.push({ body, author: { login: 'web-everything' } }); }),
    publishNeedsYou: vi.fn(),
  };
  const markerDir = join(redTeamStatusDir(env), 'skip-published');
  const markers = () => existsSync(markerDir) ? readdirSync(markerDir) : [];
  function settle(redTeam, overrides = {}) {
    return settleRedTeamSkip({ redTeam: arguments.length === 0 ? policy : redTeam, repo, pr, head, readHead: head, comments, io, ...overrides });
  }
  return { io, comments, settle, markers, markerDir };
}

describe('classifyRedTeamSkip — structured policy only, fail closed', () => {
  it('classifies an explicit card-only skipped policy independently of its reason string', () => {
    expect(classifyRedTeamSkip(policy)).toMatchObject({ kind: 'policy' });
    expect(classifyRedTeamSkip({ ...policy, reason: 'different wording' })).toMatchObject({ kind: 'policy' });
  });
  it.each(nonPolicyCases)('%s is non-policy', (_name, redTeam) => {
    const result = classifyRedTeamSkip(redTeam);
    expect(result).toMatchObject({ kind: 'non-policy', reason: expect.any(String) });
    expect(result.reason.length).toBeGreaterThan(0);
    if (redTeam?.reason) expect(result.reason).toBe(redTeam.reason);
  });
});

describe('settleRedTeamSkip', () => {
  it('policy skip posts exactly one marker comment parseable by redTeamForHead, with the visible reason; a second call posts nothing', async () => {
    const f = fixture();
    expect(await f.settle()).toMatchObject({ outcome: 'policy-clear' });
    expect(f.io.postComment.mock.calls).toEqual([[expect.objectContaining({ repo, pr, body: expect.any(String) })]]);
    const body = f.io.postComment.mock.calls[0][0].body;
    expect(body.split('\n')[0]).toBe(redTeamMarker(pr, head));
    expect(body.split('\n')).toContain(visibleReason);
    expect(parseRedTeamComment(body)).toEqual({ pr, rev: head, findings: [] });
    expect(redTeamForHead(f.comments, pr, head)).toEqual({ pr, rev: head, findings: [] });
    expect(redTeamForHead(f.comments, pr, 'b'.repeat(40))).toBeNull();
    expect(await f.settle()).toMatchObject({ outcome: 'already' });
    expect(f.io.postComment).toHaveBeenCalledTimes(1);
    expect(f.io.publishNeedsYou).not.toHaveBeenCalled();
  });

  it.each(['forged author', 'stale head', 'different PR'])('does not let a %s result suppress policy settlement', async kind => {
    const f = fixture();
    f.comments.push({ author: { login: kind === 'forged author' ? 'attacker' : 'web-everything' },
      body: redTeamMarker(kind === 'different PR' ? pr + 1 : pr, kind === 'stale head' ? 'b'.repeat(40) : head) });
    expect(await f.settle()).toMatchObject({ outcome: 'policy-clear' });
    expect(f.io.postComment).toHaveBeenCalledTimes(1);
  });

  it.each(nonPolicyCases)('NON-POLICY %s never posts a result and publishes needs-you once per head+reason', async (_name, redTeam) => {
    const f = fixture();
    const { reason } = classifyRedTeamSkip(redTeam);
    await f.settle(redTeam);
    await f.settle(redTeam);
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(redTeamForHead(f.comments, pr, head)).toBeNull();
    expect(f.io.publishNeedsYou.mock.calls).toEqual([[{ repo, pr, head, kind: `red-team-skip-${createHash('sha256').update(JSON.stringify([repo, pr, head, reason])).digest('hex').slice(0, 26)}`,
      reason: `red team skipped (${reason}); not cleared`, title: '' }]]);
    expect(f.markers()).toHaveLength(1);
    expect(f.markers()[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    // Recreate the IO facade: deduplication must survive a new invocation, not just a closure cache.
    await f.settle(redTeam, { io: { ...f.io, publishNeedsYou: f.io.publishNeedsYou } });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    await f.settle(redTeam, { head: 'b'.repeat(40) });
    await f.settle({ status: 'skipped', reason: `${reason}; changed reason` });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(3);
    expect(f.markers()).toHaveLength(3);
  });

  it('needs-you deduplication also includes repo and PR', async () => {
    const f = fixture(), redTeam = { status: 'skipped', reason: 'provider unavailable' };
    await f.settle(redTeam);
    await f.settle(redTeam, { repo: 'frontier-ui/frontierui' });
    await f.settle(redTeam, { pr: pr + 1 });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(3);
    expect(f.markers()).toHaveLength(3);
  });

  it('writes a deduplication marker through writeJsonAtomic only AFTER successful publication', async () => {
    const f = fixture();
    f.io.publishNeedsYou.mockImplementation(() => {
      expect(f.markers()).toEqual([]);
      expect(writeJsonAtomic.mock.calls).toEqual([[
        expect.stringContaining('skip-pending'),
        expect.objectContaining({ repo, pr, head, kind: expect.stringMatching(/^red-team-skip-[a-f0-9]{26}$/) }),
      ]]);
    });
    await f.settle({ status: 'skipped', reason: 'provider unavailable' });
    expect(writeJsonAtomic).toHaveBeenCalledWith(join(f.markerDir, f.markers()[0]), expect.any(Object));
  });

  it('publish failure is logged, never thrown, leaves no marker, and retries successfully', async () => {
    const f = fixture(), redTeam = { status: 'skipped', reason: 'provider unavailable' };
    f.io.publishNeedsYou.mockImplementationOnce(() => { throw Error('feed unavailable'); });
    await f.settle(redTeam); // Any exception fails this test.
    expect(f.markers()).toEqual([]);
    expect(f.io.log).toHaveBeenCalled();
    await f.settle(redTeam);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(f.markers()).toHaveLength(1);
    expect(f.io.postComment).not.toHaveBeenCalled();
  });

  it('comment post failure on policy means no clear, publishes needs-you, and deduplicates that failure', async () => {
    const f = fixture();
    f.io.postComment.mockImplementation(() => { throw Error('GitHub unavailable'); });
    const result = await f.settle();
    expect(result.outcome).not.toBe('policy-clear');
    expect(redTeamForHead(f.comments, pr, head)).toBeNull();
    expect(f.io.publishNeedsYou.mock.calls).toEqual([[{ repo, pr, head, kind: `red-team-skip-${createHash('sha256').update(JSON.stringify([repo, pr, head, 'policy-clear comment failed: GitHub unavailable'])).digest('hex').slice(0, 26)}`,
      reason: 'red team skipped (policy-clear comment failed: GitHub unavailable); not cleared', title: '' }]]);
    await f.settle();
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(planRedTeamStatusLabels({ repo, pr, head, comments: f.comments }).add).not.toBe('red-team:clear');
  });

  it('unprintable policy post error persists pending notification before publishing and retrying', () => {
    const f = fixture();
    const reason = 'policy-clear comment failed: unprintable error';
    const pendingDir = join(redTeamStatusDir(f.io.env), 'skip-pending');
    let pendingAtPublication;
    f.io.postComment.mockImplementation(() => { throw { message: { toString: null } }; });
    f.io.publishNeedsYou.mockImplementationOnce(() => {
      pendingAtPublication = readdirSync(pendingDir).map(name =>
        JSON.parse(readFileSync(join(pendingDir, name), 'utf8')));
      throw Error('feed unavailable');
    });
    expect(f.settle()).toEqual({ outcome: 'non-policy' });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.io.publishNeedsYou).toHaveBeenCalledWith(expect.objectContaining({
      repo, pr, head, reason: `red team skipped (${reason}); not cleared`,
    }));
    // Assert outside the IO callback: settlement intentionally catches publication failures.
    expect(pendingAtPublication).toEqual([f.io.publishNeedsYou.mock.calls[0][0]]);
    expect(readdirSync(pendingDir)).toHaveLength(1);
    expect(f.markers()).toEqual([]);
    expect(f.settle()).toEqual({ outcome: 'non-policy', reason });
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(readdirSync(pendingDir)).toEqual([]);
    expect(f.markers()).toHaveLength(1);
    expect(redTeamForHead(f.comments, pr, head)).toBeNull();
  });

  it('never throws when policy comment, needs-you publication, and diagnostic logging all fail', async () => {
    const f = fixture();
    f.io.postComment.mockImplementation(() => { throw Error('GitHub unavailable'); });
    f.io.publishNeedsYou.mockImplementation(() => { throw Error('feed unavailable'); });
    f.io.log.mockImplementation(() => { throw Error('log unavailable'); });
    const result = await f.settle();
    expect(result?.outcome).not.toBe('policy-clear');
    expect(redTeamForHead(f.comments, pr, head)).toBeNull();
    expect(f.markers()).toEqual([]);
  });

  it('label planner end-to-end: a policy result yields red-team:clear and a non-policy skip does not', async () => {
    const f = fixture();
    const labels = () => planRedTeamStatusLabels({ repo, pr, head, comments: f.comments, labels: ['red-team:pending'] });
    await f.settle({ status: 'skipped', reason: 'provider unavailable' });
    expect(labels().add).not.toBe('red-team:clear');
    await f.settle();
    expect(labels()).toEqual({ add: 'red-team:clear', remove: ['red-team:pending'] });
  });
});


describe('PR 5890 not-owed settlement (R100: not-owed on an accepted head is policy-clear)', () => {
  it.each([
    { status: 'not-owed' },
    { status: 'not-owed', policy: 'card-only' },
    { status: 'not-owed', reason: 'review verdict is needs-human, not accept' },
  ])('not-owed on an ACCEPTED head clears with a reasoned marker and no alert: %j', redTeam => {
    const f = fixture();
    expect(f.settle(redTeam, { accepted: true }).outcome).toBe('policy-clear');
    expect(f.io.postComment).toHaveBeenCalledOnce();
    expect(f.io.postComment.mock.calls[0][0].body).toContain('not-owed on an accepted head');
    expect(redTeamForHead(f.comments, pr, head)).not.toBeNull();
    expect(planRedTeamStatusLabels({ pr, head, comments: f.comments, evidence: {} }).add).toBe('red-team:clear');
    expect(f.io.publishNeedsYou).not.toHaveBeenCalled();
    expect(f.settle(redTeam, { accepted: true }).outcome).toBe('already');
  });
  it.each([undefined, false, 'yes', 1])('not-owed on a NON-accepted head (accepted=%j) never clears and alerts once', accepted => {
    const f = fixture();
    const redTeam = { status: 'not-owed' };
    expect(f.settle(redTeam, { accepted }).outcome).toBe('non-policy');
    expect(f.settle(redTeam, { accepted }).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(redTeamForHead(f.comments, pr, head)).toBeNull();
    expect(planRedTeamStatusLabels({ pr, head, comments: f.comments, evidence: {} }).add).not.toBe('red-team:clear');
    expect(f.io.publishNeedsYou).toHaveBeenCalledOnce();
    expect(f.io.publishNeedsYou.mock.calls[0][0]).toMatchObject({
      repo, pr, head, reason: 'red team skipped (red team reported not-owed on an accepted head); not cleared',
    });
  });
  it.each([
    { deferredByGuard: true }, { deferredByCap: true },
    { deferredByGuard: 'yes' }, { deferredByCap: {} },
  ])('deferred not-owed never clears: %j', flags => {
    const f = fixture();
    expect(f.settle({ status: 'not-owed', ...flags }, { accepted: true }).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(f.io.publishNeedsYou).toHaveBeenCalledOnce();
  });
  it.each([undefined, null, '', 'unknown', 'b'.repeat(40), {}])('not-owed with unbound read %j never clears', readHead => {
    const f = fixture();
    expect(f.settle({ status: 'not-owed' }, { readHead, accepted: true }).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(f.io.publishNeedsYou).toHaveBeenCalledOnce();
  });
});


describe('stored-review not-owed settlement context', () => {
  it('clears only the explicitly acceptance-checked recovery context once', () => {
    const f = fixture(), context = { accepted: true, storedReviewPolicyClear: true };
    expect(f.settle({ status: 'not-owed' }, context).outcome).toBe('policy-clear');
    expect(f.comments[0].body).toContain('Red team not required on this head: not owed (stored review)');
    expect(f.settle({ status: 'not-owed' }, context).outcome).toBe('already');
    expect(f.io.postComment).toHaveBeenCalledOnce();
  });
  it.each([
    { accepted: false }, { storedReviewPolicyClear: false }, { readHead: 'b'.repeat(40) },
  ])('refuses incomplete stored-review authority %j', override => {
    const f = fixture();
    expect(f.settle({ status: 'not-owed' }, {
      accepted: true, storedReviewPolicyClear: true, ...override,
    }).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
  });
  it.each(['deferredByGuard', 'deferredByCap'])('refuses a stored-review clear with %s', flag => {
    const f = fixture();
    expect(f.settle({ status: 'not-owed', [flag]: true }, {
      accepted: true, storedReviewPolicyClear: true,
    }).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
  });
});

// The overlay acceptance form and graduated stored-review form coexist. Explicit
// recovery authority must never fall back to the legacy form when malformed.
describe('not-owed settlement authority forms', () => {
  it.each([false, undefined, null, 0, 1, 'true'])('explicit malformed recovery authority %j refuses legacy fallback', storedReviewPolicyClear => {
    const f = fixture();
    expect(f.settle({ status: 'not-owed' }, { accepted: true, storedReviewPolicyClear }).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(f.io.publishNeedsYou).toHaveBeenCalledOnce();
  });
});
