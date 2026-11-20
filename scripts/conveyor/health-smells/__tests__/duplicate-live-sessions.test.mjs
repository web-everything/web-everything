/**
 * @file scripts/conveyor/health-smells/__tests__/duplicate-live-sessions.test.mjs
 * @description dup-heal-dispatch (#x0jphk5 follow-up, epic #3383) — the PURE `evaluate()` of the
 *   `duplicate-live-sessions` smell: two-or-more LIVE sessions sharing one dispatched `name` (the live
 *   incident this whole item exists to fix — `ci-heal-2784` x3, `ci-heal-2783` x3, 2026-09-26 22:16 ET). No
 *   fs/network — every probe is a plain fixture array, exactly the shape
 *   `we:scripts/conveyor/health-watch.mjs#probeAgents` already returns (same convention
 *   `dispatch-permission-stall.test.mjs` already uses).
 */
import { describe, it, expect } from 'vitest';
import duplicateLiveSessions, { findDuplicateLiveSessions, isNonTerminal } from '../duplicate-live-sessions.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';
// Static import: health-watch.mjs has a heavy module graph (multi-second transform under load). Loading it at
// collect time keeps that cost out of the per-test 5000 ms budget; probeAgents below runs on an injected exec
// (no real `claude agents` call) so the test itself is hermetic.
import { probeAgents } from '../../health-watch.mjs';

const agent = (over = {}) => ({
  name: 'ci-heal-2784', state: 'working', sessionId: 'sid-a', cwd: '/lanes/lane-1', ...over,
});

describe('isNonTerminal', () => {
  it('treats working/blocked/waiting as live', () => {
    expect(isNonTerminal(agent({ state: 'working' }))).toBe(true);
    expect(isNonTerminal(agent({ state: 'blocked' }))).toBe(true);
  });
  it('treats done/stopped/failed as terminal — never a live duplicate', () => {
    expect(isNonTerminal(agent({ state: 'done' }))).toBe(false);
    expect(isNonTerminal(agent({ state: 'stopped' }))).toBe(false);
    expect(isNonTerminal(agent({ state: 'failed' }))).toBe(false);
  });
});

describe('findDuplicateLiveSessions', () => {
  it('flags two live sessions sharing one name — the live incident shape', () => {
    const out = findDuplicateLiveSessions([
      agent({ sessionId: 'sid-a' }),
      agent({ sessionId: 'sid-b', cwd: '/lanes/lane-2' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0][0]).toBe('ci-heal-2784');
    expect(out[0][1]).toHaveLength(2);
  });

  it('THREE live copies of the same name — the exact tonight count for ci-heal-2784/ci-heal-2783', () => {
    const out = findDuplicateLiveSessions([
      agent({ sessionId: 'sid-a' }), agent({ sessionId: 'sid-b' }), agent({ sessionId: 'sid-c' }),
    ]);
    expect(out[0][1]).toHaveLength(3);
  });

  it('does not flag a single live session under a name', () => {
    expect(findDuplicateLiveSessions([agent()])).toHaveLength(0);
  });

  it('does not flag a finished sibling — a done/stopped/failed copy is history, not a live duplicate', () => {
    const out = findDuplicateLiveSessions([
      agent({ sessionId: 'sid-a', state: 'done' }),
      agent({ sessionId: 'sid-b', state: 'working' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('ignores an unnamed/malformed entry rather than throwing', () => {
    expect(findDuplicateLiveSessions([null, {}, agent()])).toHaveLength(0);
  });

  it('tolerates a missing/non-array probe rather than throwing', () => {
    expect(findDuplicateLiveSessions(null)).toEqual([]);
  });

  it('two DIFFERENT names, each with only one live session, is not a duplicate of either', () => {
    expect(findDuplicateLiveSessions([agent({ name: 'ci-heal-2784' }), agent({ name: 'fix-2783' })])).toHaveLength(0);
  });
});

describe('duplicate-live-sessions.evaluate', () => {
  it('reports one breach row per duplicated name, never stopping/killing anything itself', () => {
    const out = duplicateLiveSessions.evaluate({
      agents: [
        agent({ sessionId: 'sid-a' }), agent({ sessionId: 'sid-b' }), agent({ sessionId: 'sid-c' }),
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subject: 'ci-heal-2784', breach: true });
    expect(out[0].measure).toMatchObject({ name: 'ci-heal-2784', count: 3 });
    expect(out[0].measure.sessionIds).toEqual(['sid-a', 'sid-b', 'sid-c']);
    expect(out[0].recommendation).toMatch(/do not stop/i);
  });

  // PR #2789 review (correctness) — asserts the smell against the REAL production probe's output shape, not a
  // hand-built fixture, so a probe/smell field mismatch (sessionId/cwd dropped by the probe) is caught here.
  it('carries sessionIds/cwds through from the real health-watch probeAgents() output shape', async () => {
    const raw = [
      { name: 'ci-heal-2784', state: 'working', kind: 'background', startedAt: 't1', cwd: '/lanes/lane-1', sessionId: 'sid-a' },
      { name: 'ci-heal-2784', state: 'working', kind: 'background', startedAt: 't2', cwd: '/lanes/lane-2', sessionId: 'sid-b' },
    ];
    const agents = probeAgents({ exec: () => JSON.stringify(raw) });
    const [row] = duplicateLiveSessions.evaluate({ agents });
    expect(row.measure.sessionIds).toEqual(['sid-a', 'sid-b']);
    expect(row.measure.cwds).toEqual(['/lanes/lane-1', '/lanes/lane-2']);
    expect(row.measure.startedAts).toEqual(['t1', 't2']);
  });

  it('reports nothing when every name has at most one live session', () => {
    expect(duplicateLiveSessions.evaluate({ agents: [agent()] })).toHaveLength(0);
  });

  it('is wired to alert even in shadow mode, host-scoped, every-tick, on the agents probe', () => {
    expect(NOTIFY_EVEN_IN_SHADOW.has(duplicateLiveSessions.id)).toBe(true);
    expect(duplicateLiveSessions.scope).toBe('host');
    expect(duplicateLiveSessions.cadence).toBe('every-tick');
    expect(duplicateLiveSessions.probes).toEqual(['agents']);
    expect(duplicateLiveSessions.severity).toBe('high');
  });
});
