/**
 * Live #6732 (2026-11-14): an operator send-back, then four fix rounds. Each fixer pushed its fix, marked a verify wait
 * for a head that was already the PR head, and went idle while the verify queue ran. The watchdog called it stalled and
 * the reclaim stopped the session as "CI owns that verdict", so the harness could not resume the SAME fixer to post
 * the `## Fix evidence` comment. The reclaim now holds such a session while a send-back is still owed.
 */
import { describe, expect, it } from 'vitest';
import { planFixerStuckReclaim } from '../fixer-stuck-reclaim.mjs';

const NOW = Date.parse('2026-11-14T10:39:00Z');
const SID = '3eef58ae-4dfb-4793-9a59-feb04387a49a';
const HEAD = '14796a6ce0cd27065c62cf97788368c9473528e8';
const EVENT = { type: 'session-watchdog.fixer-stuck', v: 1, key: `we#6732|${SID}|stalled|${HEAD}`, at: '2026-11-14T10:39:07Z',
  repo: 'we', pr: 6732, claimKind: 'fixing', session: { name: 'fix-6732', id: '3eef58ae', sessionId: SID }, classification: 'stalled', reason: 'idle', headSha: HEAD };
const CLAIM = { owner: 'fixer:fix-6732', meta: { kind: 'fixing', repo: 'we', pr: 6732, who: 'fix-6732', sessionId: SID } };
const AWAIT = { v: 1, sessionId: SID, who: 'fix-6732', pr: 6732, sha: HEAD, requestedAt: '2026-11-14T09:50:00Z', kind: 'fix' };
const base = { events: [EVENT], acked: new Set(), claims: [CLAIM], nowMs: NOW, awaitFor: () => AWAIT, prHeadFor: () => HEAD,
  lastActivityMsFor: () => Date.parse('2026-11-14T10:00:00Z') };

describe('a fixer waiting on verify while an operator send-back is open', () => {
  it('is held, not reclaimed, so the verify handoff can resume it to post the evidence', () => {
    const [row] = planFixerStuckReclaim({ ...base, sendBackOwedFor: (repo, pr) => repo === 'we' && pr === 6732 });
    expect(row.decision).toBe('hold');
    expect(row.reason).toMatch(/send-back/);
    expect(row.reason).toMatch(/resume/);
  });

  it('is still reclaimed when no send-back is owed (the #4453 behaviour is unchanged)', () => {
    expect(planFixerStuckReclaim({ ...base, sendBackOwedFor: () => false })[0].decision).toBe('reclaim');
    expect(planFixerStuckReclaim(base)[0].decision).toBe('reclaim');
  });

  it('is reclaimed once the verify wait record is past its TTL (the hold is bounded)', () => {
    const old = { ...AWAIT, requestedAt: '2026-11-13T00:00:00Z' };
    expect(planFixerStuckReclaim({ ...base, awaitFor: () => old, sendBackOwedFor: () => true })[0].decision).toBe('reclaim');
  });

  it('fails closed when the send-back reader throws: the event is held, nothing is stopped', () => {
    const [row] = planFixerStuckReclaim({ ...base, sendBackOwedFor: () => { throw new Error('gh down'); } });
    expect(row.decision).toBe('hold');
  });

  it('does not extend to a non-fix wait (ci-heal keeps its CI-owns-it reclaim)', () => {
    const heal = { ...AWAIT, kind: 'ci-heal' };
    expect(planFixerStuckReclaim({ ...base, awaitFor: () => heal, sendBackOwedFor: () => true })[0].decision).toBe('reclaim');
  });
});
