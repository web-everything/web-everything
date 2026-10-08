/**
 * Card xccgzu5 — the fix daemon consumes the session watchdog's fixer-stuck events. Live 2026-10-08: ci-heal-4453 sat
 * idle for an hour on a verify for a commit it had already pushed, holding the fix claim and a reserved ci-heal slot,
 * while `[high] fixer-stuck pr:we#4453` stayed open because nothing read the event log.
 */
import { describe, expect, it, vi } from 'vitest';
import { planFixerStuckReclaim, runFixerStuckReclaimPass, formatFixerStuckReclaimLines, RECLAIM_ACK_BY } from '../fixer-stuck-reclaim.mjs';
import { runTickAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

const NOW = Date.parse('2026-10-08T15:40:00Z');
const SID = '5536e97f-1795-4eb5-9bd1-be2de08cebdc';
const PUSHED = '299805a8e8b296093ca432a54f119fca437dc1ca';
// The exact event the watchdog wrote for #4453.
const EVENT = {
  type: 'session-watchdog.fixer-stuck', v: 1, key: `we#4453|${SID}|stalled|2a2d454d13be533b1bd72519d1984bfb8a704c1d`,
  at: '2026-10-08T15:06:53.789Z', repo: 'we', pr: 4453, claimKind: 'fixing',
  session: { name: 'ci-heal-4453', id: '5536e97f', sessionId: SID }, classification: 'stalled', reason: 'idle',
  headSha: '2a2d454d13be533b1bd72519d1984bfb8a704c1d', ask: 'escalate-fixer',
};
const CLAIM = { owner: 'fixer:ci-heal-4453', meta: { kind: 'fixing', repo: 'we', pr: 4453, who: 'ci-heal-4453', sessionId: SID } };
const AWAIT = { v: 1, sessionId: SID, who: 'ci-heal-4453', pr: 4453, sha: PUSHED, requestedAt: '2026-10-08T15:11:32.206Z', kind: 'ci-heal' };
const base = {
  events: [EVENT], acked: new Set(), claims: [CLAIM], nowMs: NOW,
  awaitFor: () => AWAIT, prHeadFor: () => PUSHED, lastActivityMsFor: () => Date.parse('2026-10-08T14:31:02Z'),
};

describe('planFixerStuckReclaim', () => {
  it('reclaims #4453: stalled, still holding the claim, waiting on a verify for a commit that is already the PR head', () => {
    const [row] = planFixerStuckReclaim(base);
    expect(row.decision).toBe('reclaim');
    expect(row.reason).toMatch(/already the PR head/);
  });

  it('holds while the await-verify harness owns a verify for an UNPUSHED commit', () => {
    const [row] = planFixerStuckReclaim({ ...base, prHeadFor: () => '2a2d454d13be533b1bd72519d1984bfb8a704c1d' });
    expect(row.decision).toBe('hold');
    expect(row.reason).toMatch(/unpushed/);
  });

  it('holds a stalled session that came back to life', () => {
    const [row] = planFixerStuckReclaim({ ...base, lastActivityMsFor: () => NOW - 5 * 60_000 });
    expect(row.decision).toBe('hold');
  });

  it('acks a superseded event (claim gone or held by another session) and skips acked keys', () => {
    expect(planFixerStuckReclaim({ ...base, claims: [] })[0].decision).toBe('ack');
    expect(planFixerStuckReclaim({ ...base, claims: [{ meta: { ...CLAIM.meta, sessionId: 'other' } }] })[0].decision).toBe('ack');
    expect(planFixerStuckReclaim({ ...base, acked: new Set([EVENT.key]) })).toEqual([]);
  });

  it('gives a waiting-loop event a grace period before reclaiming', () => {
    const loop = { ...EVENT, key: 'k2', classification: 'waiting-loop', at: new Date(NOW - 5 * 60_000).toISOString() };
    expect(planFixerStuckReclaim({ ...base, events: [loop], awaitFor: () => null })[0].decision).toBe('hold');
    const old = { ...loop, at: new Date(NOW - 20 * 60_000).toISOString() };
    expect(planFixerStuckReclaim({ ...base, events: [old], awaitFor: () => null })[0].decision).toBe('reclaim');
  });
});

describe('runFixerStuckReclaimPass', () => {
  const io = (over = {}) => {
    const acks = [];
    const calls = { stop: vi.fn(() => ({ stopped: true })), endFix: vi.fn(async () => ({ ok: true })), release: vi.fn(() => ({ released: [{ kind: 'ci-heal' }] })), clear: vi.fn(() => true) };
    return {
      acks, calls,
      opts: {
        env: {}, nowMs: NOW, readEvents: () => [EVENT], readAcked: () => new Set(), appendAck: (a) => acks.push(a),
        listClaims: () => [CLAIM], awaitFor: () => AWAIT, clearAwait: calls.clear, prHeadFor: () => PUSHED,
        lastActivityMsFor: () => Date.parse('2026-10-08T14:31:02Z'), stopSession: calls.stop, endFix: calls.endFix, releaseDispatch: calls.release, ...over,
      },
    };
  };

  it('stops the session, fix-ends its claim as that session, releases its dispatch claim, clears the await record, acks', async () => {
    const { opts, calls, acks } = io();
    const r = await runFixerStuckReclaimPass(opts);
    expect(r.rows[0].result).toBe('reclaimed');
    expect(calls.stop).toHaveBeenCalledWith({ handle: '5536e97f' });
    expect(calls.endFix).toHaveBeenCalledWith(expect.objectContaining({ repo: 'we', pr: 4453, who: 'ci-heal-4453', sessionId: SID }));
    expect(calls.release).toHaveBeenCalledWith({ repo: 'we', pr: 4453, who: 'ci-heal-4453' });
    expect(calls.clear).toHaveBeenCalled();
    expect(acks).toEqual([expect.objectContaining({ key: EVENT.key, by: RECLAIM_ACK_BY, action: 'reclaimed' })]);
    expect(formatFixerStuckReclaimLines(r)[0]).toMatch(/PR #4453 ci-heal-4453 — reclaim → reclaimed/);
  });

  it('kill switch WE_FIXER_STUCK_RECLAIM=0 reports only', async () => {
    const { opts, calls, acks } = io({ env: { WE_FIXER_STUCK_RECLAIM: '0' } });
    const r = await runFixerStuckReclaimPass(opts);
    expect(r.rows[0].result).toMatch(/report-only/);
    expect(calls.stop).not.toHaveBeenCalled();
    expect(acks).toEqual([]);
  });

  it('does not ack when fix-end was refused, so the next tick retries', async () => {
    const { opts, acks } = io({ endFix: async () => ({ ok: false, reason: 'not-holder' }) });
    const r = await runFixerStuckReclaimPass(opts);
    expect(r.rows[0].result).toBe('reclaim-incomplete');
    expect(acks).toEqual([]);
  });
});

describe('runTickAllRepos wiring', () => {
  it('runs the stuck-fixer reclaim before the ci-heal dispatch half, and returns its rows', async () => {
    const order = [];
    const empty = () => ({ dispatched: [], refusals: [] });
    const result = await runTickAllRepos({
      repos: ['web-everything/web-everything'],
      authGateOverride: () => ({ paused: false, reason: null }),
      awaitVerifyTick: async () => { order.push('await'); return { rows: [] }; },
      stuckFixerTick: async () => { order.push('reclaim'); return { rows: [{ pr: 4453, decision: 'reclaim', result: 'reclaimed' }] }; },
      fixTick: () => { order.push('fix'); return empty(); },
      ciHealTick: () => { order.push('ci-heal'); return empty(); },
      hungCiTick: empty, mainRedRebaseTick: empty, missingRunTick: empty, promoteDraftTick: empty,
      notesTick: () => ({ notes: [], refusals: [] }), notesDryRun: true,
    });
    expect(order.slice(0, 3)).toEqual(['await', 'reclaim', 'fix']);
    expect(order).toContain('ci-heal');
    expect(result.stuckFixers.rows[0].result).toBe('reclaimed');
  });
});
