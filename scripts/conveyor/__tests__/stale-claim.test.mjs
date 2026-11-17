/**
 * @file scripts/conveyor/__tests__/stale-claim.test.mjs
 * @description Table-driven proof of the stale fix-claim pass core (`stale-claim.mjs`): owner state x push age ->
 *   release decision; act mode calls the (mocked) release then rearm; report mode and an alive owner never release.
 */
import { describe, it, expect, vi } from 'vitest';
import { claimRepoSlug, readLastPush, runControl } from '../stale-claim-io.mjs';
import { classifyOwner, decideStaleClaim, resolveStaleClaimSettings, runStalePass, STALE_CLAIM_EVENT } from '../stale-claim.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const settings = mode => ({ mode, pushQuietMinutes: 30, idleMinutes: 30 });
const claim = (over = {}) => ({ owner: 'host:1', pid: null, meta: { repo: 'we', pr: 6999, kind: 'fix', who: 'fix-6999', claimedAt: new Date(NOW - 90 * MIN).toISOString(), ...over } });
const agent = over => ({ name: 'fix-6999', pid: 4242, status: 'idle', state: 'working', ...over });
const ago = min => ({ atMs: NOW - min * MIN, open: true });

describe('classifyOwner', () => {
  const base = { claim: claim(), nowMs: NOW, idleMinutes: 30, pidAlive: () => true };
  it.each([
    ['agents unreadable', { agents: null }, 'unknown'],
    ['no session, no pid', { agents: [] }, 'dead'],
    ['no session, claim pid alive', { agents: [], claim: { ...claim(), pid: 9 } }, 'active'],
    ['state done', { agents: [agent({ state: 'done' })] }, 'done'],
    ['state stopped', { agents: [agent({ state: 'stopped' })] }, 'done'],
    ['pid dead', { agents: [agent()], pidAlive: () => false }, 'dead'],
    ['busy', { agents: [agent({ status: 'busy' })] }, 'active'],
    ['idle, no activity info', { agents: [agent()] }, 'idle-unknown'],
    ['idle, quiet 10 min', { agents: [agent()], activityMs: () => NOW - 10 * MIN }, 'idle-recent'],
    ['idle, quiet 45 min', { agents: [agent()], activityMs: () => NOW - 45 * MIN }, 'idle-finished'],
  ])('%s -> %s', (_n, input, state) => {
    expect(classifyOwner({ ...base, ...input }).state).toBe(state);
  });
});

describe('decideStaleClaim', () => {
  const decide = (state, push, kind = 'fix') => decideStaleClaim({ claim: claim({ kind }), owner: { state }, push, nowMs: NOW, settings: settings('act') });
  it.each([
    ['done', ago(60), 'release'],
    ['dead', ago(31), 'release'],
    ['idle-finished', ago(120), 'release'],
    ['done', ago(29), 'keep'],
    ['dead', ago(5), 'keep'],
    ['active', ago(600), 'keep'],
    ['idle-recent', ago(600), 'keep'],
    ['idle-unknown', ago(600), 'keep'],
    ['unknown', ago(600), 'keep'],
    ['done', null, 'keep'],
    ['done', { atMs: NOW - 99 * MIN, open: false }, 'keep'],
  ])('owner %s, push %j -> %s', (state, push, action) => {
    expect(decide(state, push).action).toBe(action);
  });
  it('ci-heal and review are in scope; other kinds are not', () => {
    expect(decide('done', ago(60), 'ci-heal').action).toBe('release');
    expect(decide('done', ago(60), 'review').action).toBe('release');
    expect(decide('done', ago(60), 'build').reason).toBe('kind-out-of-scope');
  });
});

describe('resolveStaleClaimSettings', () => {
  it('defaults to report mode and 30 minute windows', () => {
    expect(resolveStaleClaimSettings({ env: {} })).toEqual({ mode: 'report', pushQuietMinutes: 30, idleMinutes: 30 });
  });
  it('env beats platform beats tool; a bad mode falls back to report', () => {
    expect(resolveStaleClaimSettings({ tool: { mode: 'report' }, platform: { mode: 'act' }, env: {} }).mode).toBe('act');
    expect(resolveStaleClaimSettings({ platform: { mode: 'act' }, env: { WE_STALE_CLAIM_MODE: 'report' } }).mode).toBe('report');
    expect(resolveStaleClaimSettings({ env: { WE_STALE_CLAIM_MODE: 'destroy' } }).mode).toBe('report');
  });
});

describe('runStalePass', () => {
  const mk = (mode, { owner = agent({ state: 'done' }), push = ago(90), release, rearm } = {}) => {
    const deps = {
      pidAlive: () => true, activityMs: () => NOW - 120 * MIN, lastPush: async () => push,
      release: release ?? vi.fn(async () => ({ released: true })), rearm: rearm ?? vi.fn(async () => ({ ok: true })),
      record: vi.fn(), emit: vi.fn(),
    };
    return { deps, run: () => runStalePass({ claims: [claim()], agents: [owner], settings: settings(mode), nowMs: NOW, deps }) };
  };

  it('report mode records would-release and never calls release, rearm or emit', async () => {
    const { deps, run } = mk('report');
    const { rows } = await run();
    expect(rows[0]).toMatchObject({ outcome: 'would-release', pr: 6999, kind: 'fix', ownerState: 'done', pushAgeMin: 90, claimAgeMin: 90 });
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.rearm).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
    expect(deps.record).toHaveBeenCalledTimes(1);
  });

  it('act mode releases, then rearms, then emits the typed event', async () => {
    const { deps, run } = mk('act');
    const { rows } = await run();
    expect(rows[0].outcome).toBe('released');
    expect(deps.release).toHaveBeenCalledOnce();
    expect(deps.rearm).toHaveBeenCalledOnce();
    expect(deps.release.mock.invocationCallOrder[0]).toBeLessThan(deps.rearm.mock.invocationCallOrder[0]);
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: STALE_CLAIM_EVENT, pr: 6999,
      detail: expect.objectContaining({ pr: 6999, kind: 'fix', owner: 'host:1', ownerState: 'done', claimAgeMin: 90, pushAgeMin: 90, rearmed: true }),
    }));
  });

  it.each([
    ['an alive and active owner', { owner: agent({ status: 'busy' }) }],
    ['a push in the last 30 minutes', { push: ago(10) }],
    ['an unknown push time', { push: null }],
  ])('act mode never releases %s', async (_n, opts) => {
    const { deps, run } = mk('act', opts);
    const { rows } = await run();
    expect(rows[0].outcome).toBe('kept');
    expect(deps.release).not.toHaveBeenCalled();
    expect(deps.rearm).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('an unreadable agent listing never releases', async () => {
    const { deps } = mk('act');
    const { rows } = await runStalePass({ claims: [claim()], agents: null, settings: settings('act'), nowMs: NOW, deps });
    expect(rows[0]).toMatchObject({ outcome: 'kept', reason: 'owner-unknown' });
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('a refused release skips rearm and emits nothing', async () => {
    const { deps, run } = mk('act', { release: vi.fn(async () => ({ released: false, reason: 'refusing LIVE claim' })) });
    const { rows } = await run();
    expect(rows[0]).toMatchObject({ outcome: 'release-failed', detail: 'refusing LIVE claim' });
    expect(deps.rearm).not.toHaveBeenCalled();
    expect(deps.emit).not.toHaveBeenCalled();
  });

  it('a failed rearm is reported but the release is still logged as an event', async () => {
    const { deps, run } = mk('act', { rearm: vi.fn(async () => ({ ok: false, reason: 'noop' })) });
    const { rows } = await run();
    expect(rows[0]).toMatchObject({ outcome: 'released-rearm-failed', detail: 'noop' });
    expect(deps.emit).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.objectContaining({ rearmed: false }) }));
  });

  it('a throwing release is contained to its claim', async () => {
    const { run } = mk('act', { release: vi.fn(async () => { throw new Error('boom'); }) });
    const { rows } = await run();
    expect(rows[0]).toMatchObject({ outcome: 'release-failed', detail: 'boom' });
  });
});

describe('owner matching', () => {
  it('a live same-named session beats an older terminal row', () => {
    const agents = [agent({ state: 'done', sessionId: 'old' }), agent({ status: 'busy', sessionId: 'new' })];
    expect(classifyOwner({ claim: claim(), agents, nowMs: NOW, idleMinutes: 30, pidAlive: () => true }).state).toBe('active');
  });
  it('an exact sessionId match is authoritative over a same-named row', () => {
    const agents = [agent({ state: 'done', sessionId: 'mine' }), agent({ status: 'busy', sessionId: 'other' })];
    const c = claim({ sessionId: 'mine' });
    expect(classifyOwner({ claim: c, agents, nowMs: NOW, idleMinutes: 30, pidAlive: () => true }).state).toBe('done');
  });
});

describe('act mode records before releasing', () => {
  it('a record failure blocks the release', async () => {
    const deps = { pidAlive: () => true, activityMs: () => null, lastPush: async () => ago(90), release: vi.fn(), rearm: vi.fn(), emit: vi.fn(),
      record: vi.fn(async () => { throw new Error('disk full'); }) };
    const { rows } = await runStalePass({ claims: [claim()], agents: [agent({ state: 'done' })], settings: settings('act'), nowMs: NOW, deps });
    expect(rows[0]).toMatchObject({ outcome: 'record-failed', detail: 'disk full' });
    expect(deps.release).not.toHaveBeenCalled();
  });
});

describe('io adapters', () => {
  it('runControl invokes the real run.mjs operator controls with the claim kind', async () => {
    const run = vi.fn(async () => ({ stdout: '' }));
    await runControl('clear-claim', claim({ kind: 'ci-heal' }), 'why', { run, root: '/r', slugOf: c => claimRepoSlug(c, { we: { slug: 'o/we' } }) });
    expect(run).toHaveBeenCalledWith('node', expect.arrayContaining(['scripts/operations/run.mjs', 'clear-claim', '--repo=o/we', '--pr=6999', '--kind=ci-heal']), expect.objectContaining({ cwd: '/r' }));
    const failing = vi.fn(async () => { throw Object.assign(new Error('x'), { stderr: 'refusing LIVE claim' }); });
    expect(await runControl('rearm', claim(), 'why', { run: failing, root: '/r' })).toEqual({ ok: false, reason: 'refusing LIVE claim' });
  });
  it('readLastPush takes the later of the head commit and a force push', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ state: 'OPEN', commits: [{ committedDate: '2026-11-17T08:00:00Z' }] }) })
      .mockResolvedValueOnce({ stdout: '2026-11-17T11:50:00Z\n' });
    expect(await readLastPush(claim(), { run })).toEqual({ atMs: Date.parse('2026-11-17T11:50:00Z'), open: true });
  });
  it('readLastPush rejects when a read fails (unknown push never releases)', async () => {
    await expect(readLastPush(claim(), { run: vi.fn().mockRejectedValue(new Error('gh down')) })).rejects.toThrow('gh down');
  });
});
