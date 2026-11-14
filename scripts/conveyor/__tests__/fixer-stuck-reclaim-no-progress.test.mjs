import { describe, expect, it } from 'vitest';
import { planFixerStuckReclaim } from '../fixer-stuck-reclaim.mjs';
import { ESCALATION_EVENT_TYPE, escalationKey } from '../session-watchdog.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-14T23:47:00Z');
const SID = 'sid-fix-6770';
const HEAD = 'a'.repeat(40);
const EVENT = {
  type: ESCALATION_EVENT_TYPE, v: 1,
  key: escalationKey({ repo: 'we', pr: 6770, sessionId: SID, classification: 'no-progress', headSha: HEAD }),
  at: new Date(NOW - 16 * MIN).toISOString(), repo: 'we', pr: 6770, claimKind: 'fixing',
  session: { name: 'fix-6770', id: 'f6770001', sessionId: SID },
  classification: 'no-progress', reason: 'no-new-head-or-verdict', headSha: HEAD, ask: 'escalate-fixer',
};
const CLAIM = { owner: 'fixer:fix-6770', meta: {
  kind: 'fixing', repo: 'we', pr: 6770, who: 'fix-6770', sessionId: SID,
  headSha: HEAD, claimedAt: new Date(NOW - 180 * MIN).toISOString(),
} };
const BASE = {
  events: [EVENT], acked: new Set(), claims: [CLAIM], nowMs: NOW,
  awaitFor: () => null, prHeadFor: () => HEAD,
  // No-progress is not an idle classification: recent activity must not block this reclaim.
  lastActivityMsFor: () => NOW - MIN,
};

describe('fixer-stuck reclaim — no-progress uses the existing 15-minute event grace', () => {
  it('reclaims a 16m no-progress event even though the holder is active', () => {
    const rows = planFixerStuckReclaim(BASE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: EVENT.key, decision: 'reclaim', claim: CLAIM });
    expect(rows[0].reason).toMatch(/no-progress/);
  });

  it('holds a 10m no-progress event inside the grace period', () => {
    const rows = planFixerStuckReclaim({ ...BASE, events: [
      { ...EVENT, at: new Date(NOW - 10 * MIN).toISOString() },
    ] });
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('hold');
    expect(rows[0].reason).toMatch(/no-progress.*10 min.*grace 15 min/);
  });

  it('holds a 16m no-progress event while a fresh await targets an unpushed commit', () => {
    const rows = planFixerStuckReclaim({ ...BASE, awaitFor: () => ({
      v: 1, sessionId: SID, who: 'fix-6770', pr: 6770, kind: 'fix',
      sha: 'b'.repeat(40), requestedAt: new Date(NOW - MIN).toISOString(),
    }) });
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('hold');
    expect(rows[0].reason).toMatch(/unpushed/);
  });
});
