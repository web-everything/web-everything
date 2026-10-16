/**
 * @file scripts/conveyor/__tests__/health-smells-notify-list.test.mjs
 * @description Card 5653 — `operator-hold-aged` is a member of the shadow-mode notify list, and its opening
 *   notification reaches the action plan UNSUPPRESSED in shadow mode through the health core (and stays suppressed
 *   if the list did not name it).
 */
import { describe, it, expect } from 'vitest';
import { NOTIFY_EVEN_IN_SHADOW } from '../health-smells-notify-list.mjs';
import { runHealthTick, emptyHealthState, planActions, MINUTE } from '../health-watch-core.mjs';
import smell from '../health-smells/operator-hold-aged.mjs';

const WE = 'web-everything/web-everything';
const T0 = Date.parse('2026-10-15T10:00:00Z');
const rec = (m) => `review-daemon: operator-holds ${JSON.stringify({ version: 1, repo: WE, observedAt: T0 + m * MINUTE, intervalMs: 120_000, holds: [{ prNumber: 7, kind: 'ruling-dispute' }] })}\n`;

describe('operator-hold-aged on the notify list', () => {
  it('is a member, and keeps the earlier approved members', () => {
    expect(NOTIFY_EVEN_IN_SHADOW.has('operator-hold-aged')).toBe(true);
    for (const id of ['main-ci-red', 'daemon-silent', 'builder-starved']) expect(NOTIFY_EVEN_IN_SHADOW.has(id)).toBe(true);
  });
  it('its opening notification is not suppressed in shadow mode; without list membership it would be', () => {
    let text = '';
    for (let m = 0; m <= 30; m += 2) text += rec(m);
    const r = runHealthTick(emptyHealthState(), { operatorHolds: { available: true, text } }, [smell], T0 + 30 * MINUTE, { config: { mode: 'shadow' } });
    expect(r.transitions.map((t) => t.type)).toEqual(['opened']);
    expect(r.plan).toEqual([{ kind: 'notify', key: `operator-hold-aged::${WE}#7:ruling-dispute`, suppressed: null }]);
    const unlisted = planActions(r.transitions, { [smell.id]: smell }, { mode: 'shadow', notifySet: new Set() });
    expect(unlisted).toEqual([{ kind: 'notify', key: `operator-hold-aged::${WE}#7:ruling-dispute`, suppressed: 'shadow mode' }]);
  });
});
