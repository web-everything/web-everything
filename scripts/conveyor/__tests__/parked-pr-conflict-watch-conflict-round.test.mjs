// The watch's own resolved-conflict re-arm counts against the conflict cap, never an ordinary review round
// (operator brief 2026-10-21; live #5777: watch re-arm + fix re-arm = two ordinary rounds for one conflict).
import { describe, it, expect, vi } from 'vitest';
import { isWatcherConflictBounce, defaultPostConflictRearm } from '../parked-pr-conflict-watch.mjs';
import { BOUNCE_PREFIX, MECHANICAL_BOUNCE_LEAD } from '../mechanical-round-cap.mjs';

const trusted = body => ({ author: { login: 'chalbert' }, body });
const mechanical = trusted(`${BOUNCE_PREFIX}\n\nRecorded by parked-pr-conflict-watch (a mechanical reconciliation pass) via the parked-PR conflict watch (#xw0odtv, dispatched per #xu2krte).\n\n${MECHANICAL_BOUNCE_LEAD}\n\nconflicts with main`);
const reviewer = trusted(`${BOUNCE_PREFIX}\n\nRecorded by agent (unattended review-loop) via the declared \`review-pr\` operation (#3035).\n\nreal finding`);
const human = trusted('🔁 human review — changes requested\n\nRecorded by operator.\n\nplease change');

describe('isWatcherConflictBounce', () => {
  it('true only when the latest bounce is the watch\'s own mechanical one', () => {
    expect(isWatcherConflictBounce([reviewer, mechanical])).toBe(true);
    expect(isWatcherConflictBounce([mechanical, reviewer])).toBe(false);
    expect(isWatcherConflictBounce([mechanical, human])).toBe(false);
    expect(isWatcherConflictBounce([{ ...mechanical, author: { login: 'stranger' } }])).toBe(false);
    expect(isWatcherConflictBounce([])).toBe(false);
    expect(isWatcherConflictBounce(null)).toBe(false);
  });
  it('the rearm argv adds --round=conflict only for the watch\'s own bounce', () => {
    const exec = vi.fn();
    defaultPostConflictRearm({ pr: { number: 9 }, repo: 'o/r', exec, conflictRound: true });
    defaultPostConflictRearm({ pr: { number: 9 }, repo: 'o/r', exec });
    expect(exec.mock.calls[0][1]).toContain('--round=conflict');
    expect(exec.mock.calls[1][1]).not.toContain('--round=conflict');
  });
});
