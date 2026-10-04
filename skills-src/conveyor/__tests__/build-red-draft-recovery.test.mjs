import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverBuilderDrafts, runBuildDispatchTick, cliRecoverBuilderDrafts } from '../build-dispatch-daemon.mjs';
import { MAX_RESUME_ATTEMPTS } from '../../../scripts/conveyor/build-dispatch-orphan-adopt.mjs';

const nowMs = Date.parse('2026-09-30T12:00:00Z');
const candidate = {
  num: '4502', pr: 3033, laneRef: 'lane/4502-delivery', isDraft: true,
  builderAuthored: true, authorLive: false, headCommittedAt: '2026-09-30T01:06:00Z',
  authorLastSeenLiveAt: '2026-09-30T02:00:00Z', updatedAt: '2026-09-30T11:59:00Z',
  failure: { name: 'test-shard (2)', firstError: 'AssertionError: Done-when 2' },
};
function fixture(initial = { attempts: 0 }) {
  let state = initial;
  const effects = {
    readState: () => state,
    writeState: vi.fn((pr, next) => { state = next; }),
    isLive: vi.fn(() => false), reserve: vi.fn(() => ({ ok: true })), release: vi.fn(),
    dispatch: vi.fn(async () => ({ agentId: 'pid:321' })), escalate: vi.fn(),
  };
  return { effects, run: (changes = {}) => recoverBuilderDrafts({ candidates: [candidate], nowMs, effects, ...changes }) };
}

describe('abandoned builder draft recovery', () => {
  it('previews recovery without reserving, writing state, dispatching or escalating', async () => {
    const f = fixture();
    expect(await f.run({ dryRun: true })).toEqual([{ pr: 3033, num: '4502', action: 'resume', planned: true }]);
    for (const name of ['reserve', 'writeState', 'dispatch', 'escalate', 'release']) expect(f.effects[name]).not.toHaveBeenCalled();
  });
  it('dispatches a gate-failure fix on the SAME PR branch and persists its handle', async () => {
    const f = fixture();
    expect(await f.run()).toEqual([{ pr: 3033, num: '4502', action: 'resume' }]);
    expect(f.effects.dispatch).toHaveBeenCalledWith(candidate);
    expect(f.effects.writeState.mock.calls).toEqual([
      [3033, { attempts: 1, pending: true, pendingAt: nowMs }], [3033, { attempts: 1, handle: 'pid:321' }],
    ]);
  });
  it.each([
    { authorLive: true }, { authorLive: null }, { builderAuthored: false },
    { isDraft: false }, { failure: null }, { headCommittedAt: '2026-09-30T11:30:00Z' },
    { authorLastSeenLiveAt: '2026-09-30T11:30:00Z' },
    { headCommittedAt: 'unreadable', authorLastSeenLiveAt: undefined },
  ])('leaves ineligible evidence alone: %j', async change => {
    const f = fixture();
    expect(await f.run({ candidates: [{ ...candidate, ...change }] })).toEqual([]);
    expect(f.effects.dispatch).not.toHaveBeenCalled();
  });
  it('uses the configured inactivity threshold', async () => {
    const f = fixture();
    await f.run({ candidates: [{ ...candidate, headCommittedAt: '2026-09-30T11:30:00Z' }], staleMinutes: 20 });
    expect(f.effects.dispatch).toHaveBeenCalledOnce();
  });
  it('escalates the exhausted budget with the failing check and first error, once', async () => {
    const f = fixture({ attempts: MAX_RESUME_ATTEMPTS });
    expect(await f.run()).toEqual([{ pr: 3033, num: '4502', action: 'exhausted' }]);
    expect(f.effects.escalate).toHaveBeenCalledWith(candidate, expect.stringContaining('test-shard (2)\nFirst error: AssertionError: Done-when 2'));
    await f.run();
    expect(f.effects.escalate).toHaveBeenCalledOnce();
    expect(f.effects.dispatch).not.toHaveBeenCalled();
  });
  it('honors the freeze and a live recovery across subsequent ticks', async () => {
    const f = fixture();
    await f.run({ allowResume: false });
    expect(f.effects.dispatch).not.toHaveBeenCalled();
    await f.run();
    f.effects.isLive.mockReturnValue(true);
    await f.run();
    expect(f.effects.dispatch).toHaveBeenCalledOnce();
  });
  it('keeps an indeterminate spawn reserved and refunds an explicit refusal', async () => {
    const f = fixture();
    f.effects.dispatch.mockRejectedValueOnce(new Error('unknown spawn outcome'));
    await f.run();
    await f.run();
    expect(f.effects.dispatch).toHaveBeenCalledOnce();
    await f.run({ nowMs: nowMs + 10 * 60_000 });
    expect(f.effects.escalate).toHaveBeenCalledWith(candidate, expect.stringContaining('launch is unconfirmed'));
    const held = fixture();
    held.effects.dispatch.mockResolvedValue({ held: true, reason: 'no-lane' });
    await held.run();
    expect(held.effects.readState()).toEqual({ attempts: 0 });
  });
  it('retries a failed escalation without dispatching beyond the budget', async () => {
    const f = fixture({ attempts: MAX_RESUME_ATTEMPTS });
    f.effects.escalate.mockRejectedValueOnce(new Error('label write unavailable'));
    await f.run();
    await f.run();
    expect(f.effects.escalate).toHaveBeenCalledTimes(2);
    expect(f.effects.dispatch).not.toHaveBeenCalled();
  });
  it('runs recovery before candidate holds and previews it without mutations', async () => {
    const effects = {
      listHolds: () => [{ num: '4502', reason: 'in-flight we#3033 already delivers it' }],
      planTick: async () => ({ decisions: {} }),
      fetchOpenPrs: async () => [{ repo: 'we', prs: [{ number: 3033, headRefName: candidate.laneRef, isDraft: true }] }],
      killSwitch: () => ({ engaged: false }), recoverDrafts: vi.fn(async () => ['recovered']),
      listRunStoreInFlight: () => [], listClaims: () => [], listFixClaims: () => [],
    };
    const tick = await runBuildDispatchTick({ live: true, effects });
    expect(tick.draftRecovery).toEqual(['recovered']);
    expect(effects.recoverDrafts).toHaveBeenCalledWith(expect.objectContaining({ allowResume: true }));
    await runBuildDispatchTick({ live: false, effects });
    expect(effects.recoverDrafts).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: true }));
  });
  it('boots the real daemon and rejects --bogus-flag with exit 2', () => {
    const out = spawnSync(process.execPath, ['skills-src/conveyor/build-dispatch-daemon.mjs', '--bogus-flag'], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(2);
  });
  it('wires REST check evidence, same-branch dispatch, durable retries and the needs-human label', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'builder-draft-'));
    const row = { type: 'conveyor.dispatch-delivery-agent', handle: 'pid:99999', lastSeenLiveAt: candidate.authorLastSeenLiveAt,
      payload: { launchKind: 'build', num: '4502' }, result: { pr: 3033 }, status: 'applied' };
    let headCommittedAt = candidate.headCommittedAt;
    let authorLive = false;
    const io = {
      stateRoot: dir, store: { list: () => ['dispatch-lane-test'], read: () => ({ effects: [row] }) },
      isPidAlive: () => authorLive, listAgents: () => [],
      api: vi.fn(path => path.startsWith('pulls/')
        ? { draft: true, state: 'open', updated_at: new Date().toISOString(),
          head: { ref: candidate.laneRef, sha: 'abc', repo: { full_name: 'web-everything/web-everything' } } }
        : path === 'commits/abc' ? { commit: { committer: { date: headCommittedAt } } }
        : { check_runs: [
          { id: 1, name: 'review-gate', conclusion: 'failure' },
          { id: 2, name: 'test-shard (2)', conclusion: 'failure', details_url: 'https://github.com/web-everything/web-everything/actions/runs/123/job/456' },
        ] }),
      paged: vi.fn(() => []), gh: vi.fn(() => 'setup\n##[error]AssertionError: Done-when 2\nsummary'),
      freeLanes: () => [8], reserve: () => ({ ok: true }), release: vi.fn(),
      dispatch: vi.fn(async () => ({ agentId: 'pid:321' })),
    };
    const args = { rawOpenPrs: [{ repo: 'we', prs: [{ ...candidate, number: 3033, headRefName: candidate.laneRef, files: [{ path: 'scripts/a.mjs' }] }] }], allowResume: true };
    try {
      authorLive = true;
      expect(await cliRecoverBuilderDrafts(args, io)).toEqual([]);
      expect(io.dispatch).not.toHaveBeenCalled();
      authorLive = false;
      headCommittedAt = new Date().toISOString();
      expect(await cliRecoverBuilderDrafts(args, io)).toEqual([]);
      expect(io.dispatch).not.toHaveBeenCalled();
      headCommittedAt = candidate.headCommittedAt;
      row.lastSeenLiveAt = new Date().toISOString();
      expect(await cliRecoverBuilderDrafts(args, io)).toEqual([]);
      expect(io.dispatch).not.toHaveBeenCalled();
      row.lastSeenLiveAt = candidate.authorLastSeenLiveAt;
      for (let i = 0; i < MAX_RESUME_ATTEMPTS + 1; i++) await cliRecoverBuilderDrafts(args, io);
      expect(io.dispatch).toHaveBeenCalledTimes(MAX_RESUME_ATTEMPTS);
      expect(io.dispatch).toHaveBeenCalledWith(expect.objectContaining({ pr: 3033, itemNum: '4502', laneRef: candidate.laneRef, lane: 8, reason: 'red-ci' }));
      expect(io.gh).toHaveBeenCalledWith(['pr', 'edit', '3033', '--repo', 'web-everything/web-everything', '--add-label', 'blocked:needs-human']);
      expect(io.gh).toHaveBeenCalledWith(['pr', 'comment', '3033', '--repo', 'web-everything/web-everything', '--body', expect.stringContaining('First error: ##[error]AssertionError: Done-when 2')]);
      expect(io.api).toHaveBeenCalledWith('commits/abc');
      // A producer receipt survives a wrapper that never settled its run.
      rmSync(join(dir, 'build-red-draft-resumes'), { recursive: true, force: true });
      const receipt = { runId: 'dispatch-lane-test', entry: structuredClone(row),
        repo: 'web-everything/web-everything', pr: 3033, ref: candidate.laneRef };
      row.result = null;
      row.status = 'in-flight';
      io.dispatch.mockClear();
      expect(await cliRecoverBuilderDrafts({ ...args, dryRun: true }, { ...io, receipts: [receipt] }))
        .toEqual([{ pr: 3033, num: '4502', action: 'resume', planned: true }]);
      expect(io.dispatch).not.toHaveBeenCalled();
      // No receipt and no delivered result: even the exact same branch proves nothing.
      expect(await cliRecoverBuilderDrafts({ ...args, dryRun: true }, io)).toEqual([]);
      row.result = { pr: 3033 };
      // A manual lookalike branch stays outside the builder repair path.
      io.dispatch.mockClear();
      row.result.pr = 999;
      await cliRecoverBuilderDrafts(args, io);
      expect(io.dispatch).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // The first call cold-imports the whole dispatch IO stack, which alone exceeds vitest's 5s default.
  }, 60_000);
});
