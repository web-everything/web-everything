/**
 * @file scripts/conveyor/health-smells/__tests__/notify-list.test.mjs
 * @description The ONE declared place for "which signs notify even in shadow mode" — the PREVIOUSLY approved
 *   set (five signs, approved by earlier operator decisions, from the old scattered `notifyEvenInShadow: true`
 *   field) UNION the Sun 2026-09-27 ~7:40 AM ET operator decision's eight ADDED signs (two of which,
 *   `dispatch-refused-stale-clone` and `duplicate-live-sessions`, were already in the previous set). Pins the
 *   exact approved union, that every id in it names a real registered smell (no typo drift), that this is an
 *   ADDITION (no previously-approved sign was demoted), and that `planActions` actually reads THIS list by
 *   default (not a stale copy).
 */
import { describe, it, expect } from 'vitest';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';
import { SMELLS } from '../index.mjs';
import {
  emptyHealthState, stepEpisodes, planActions,
} from '../../health-watch-core.mjs';

// Approved by an earlier operator decision (the old scattered `notifyEvenInShadow: true` field) — never demoted.
const PREVIOUSLY_APPROVED = [
  'claude-auth-expired',
  'daemon-held-on-last-good',
  'dispatch-permission-stall',
  'machine-overload',
  'bg-isolation-stall',
  'dispatch-refused-stale-clone',
  'duplicate-live-sessions',
];

// Added by the Sun 2026-09-27 ~7:40 AM ET operator decision.
const ADDED_2026_09_27 = [
  'drain-failing-repeatedly',
  'dispatch-refused-stale-clone', // already in PREVIOUSLY_APPROVED — the union has 13 entries, not 15
  'lane-starvation',
  'gh-call-failures',
  'gh-graphql-budget',
  'duplicate-live-sessions',      // already in PREVIOUSLY_APPROVED
  'pr-no-owner',
  'daemon-silent',
];

const ADDED_2026_09_30 = ['repeated-pr-attempts'];
const ADDED_2026_10_01 = ['draft-not-promoted', 'red-pr-unattended'];
const ADDED_2026_10_04 = ['ruling-needed-waiting'];
const APPROVED = [...new Set([...PREVIOUSLY_APPROVED, ...ADDED_2026_09_27, ...ADDED_2026_09_30, ...ADDED_2026_10_01, ...ADDED_2026_10_04])];

describe('NOTIFY_EVEN_IN_SHADOW', () => {
  it('is exactly the union of the approved operator decisions — 17 entries', () => {
    expect(APPROVED).toHaveLength(17);
    expect([...NOTIFY_EVEN_IN_SHADOW].sort()).toEqual([...APPROVED].sort());
  });

  it('demotes nothing — every previously-approved sign is still in the list', () => {
    for (const id of PREVIOUSLY_APPROVED) expect(NOTIFY_EVEN_IN_SHADOW.has(id)).toBe(true);
  });

  it('every listed id names a real, currently-registered smell (no typo/stale drift)', () => {
    const registered = new Set(SMELLS.map((s) => s.id));
    for (const id of NOTIFY_EVEN_IN_SHADOW) expect(registered.has(id)).toBe(true);
  });

  it('every other registered smell is NOT in the list (record-only by default)', () => {
    const others = SMELLS.map((s) => s.id).filter((id) => !NOTIFY_EVEN_IN_SHADOW.has(id));
    expect(others.length).toBe(SMELLS.length - APPROVED.length);
    for (const id of others) expect(NOTIFY_EVEN_IN_SHADOW.has(id)).toBe(false);
  });

  it('`planActions` defaults to reading THIS Set — an approved id is never suppressed in shadow mode', () => {
    for (const id of NOTIFY_EVEN_IN_SHADOW) {
      const smell = { id, openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert' };
      const r = stepEpisodes(emptyHealthState(), [{ smell, results: [{ subject: 'x', breach: true }] }], 0);
      const plan = planActions(r.transitions, { [id]: smell }, { mode: 'shadow' });
      const notify = plan.find((p) => p.kind === 'notify' && p.key === `${id}::x`);
      expect(notify.suppressed).toBeNull();
    }
  });

  it('a smell NOT in the list stays suppressed in shadow mode by default', () => {
    const smell = { id: 'not-on-the-list', openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert' };
    const r = stepEpisodes(emptyHealthState(), [{ smell, results: [{ subject: 'x', breach: true }] }], 0);
    const plan = planActions(r.transitions, { 'not-on-the-list': smell }, { mode: 'shadow' });
    expect(plan.find((p) => p.kind === 'notify' && p.key === 'not-on-the-list::x').suppressed).toBe('shadow mode');
  });
});
