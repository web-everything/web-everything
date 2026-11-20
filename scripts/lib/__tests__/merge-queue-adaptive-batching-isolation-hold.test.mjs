// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STANDARD_BATCHING_SETTINGS, initialBatchingState, admitEnqueue,
} from '../merge-queue-adaptive-batching.mjs';
import { redTeamLabelHoldReason, sendBackReason } from '../drain-queue-safety.mjs';

const nowMs = 30 * 60_000;
const settings = { ...STANDARD_BATCHING_SETTINGS, enabled: true };
const readSuspect = () => JSON.parse(readFileSync(
  new URL('./fixtures/drain-priority-label-gh-7155.json', import.meta.url), 'utf8'));
const isolation = () => ({ ...initialBatchingState(), isolate: [7155], isolateSinceMs: { 7155: 0 } });

// Acceptance 2b (drain-priority-label-prep): tests-only regression capture.
// Required baseline result: pending-suspect release cases FAIL on current code;
// eligible/unreadable controls PASS. Implementing the fix, marking these cases
// as expected failures, or weakening admission assertions is outside this task.
// Proposed pure-core input: pass-local, tri-state eligibility.
// true = eligible, false = known ineligible, missing/null = unreadable (keep hold).
// The current core ignores this input; the release assertions must fail until
// admission consumes it. These fixtures assume all other drain gates passed.
function eligibilityFor(suspect) {
  expect(suspect).toMatchObject({ number: 7155, isDraft: false, mergeStateStatus: 'CLEAN' });
  expect(sendBackReason(suspect.labels)).toBeNull();
  return new Map([[suspect.number, redTeamLabelHoldReason(suspect.labels) === null]]);
}

function decide(state, num, enqueueEligibility) {
  return admitEnqueue({ state, num, nowMs, settings, inQueue: new Set(), enqueueEligibility });
}

describe('isolation hold', () => {
  it.each([7183, 7193])('releases ready #%s while #7155 is red-team:pending in this pass', num => {
    const suspect = readSuspect();
    expect(suspect.labels).toContainEqual({ name: 'red-team:clear' });
    suspect.labels = suspect.labels.map(label => label.name === 'red-team:clear'
      ? { ...label, name: 'red-team:pending' } : label);
    expect(redTeamLabelHoldReason(suspect.labels)).toBe('state is red-team:pending');
    const enqueueEligibility = eligibilityFor(suspect);
    expect(enqueueEligibility.get(7155)).toBe(false);
    const state = isolation();
    const before = structuredClone(state);

    const result = decide(state, num, enqueueEligibility);

    expect(result).toMatchObject({ admit: true, reason: null });
    // Releasing unrelated work must not erase the suspect's recovery obligation.
    expect(result.state.isolate).toEqual([7155]);
    expect(result.state.isolateSinceMs).toEqual(before.isolateSinceMs);
    expect(state).toEqual(before);
    expect(enqueueEligibility).toEqual(new Map([[7155, false]]));
    // On a later pass with fresh eligible evidence the suspect is isolated again.
    expect(decide(state, num, eligibilityFor(readSuspect())))
      .toMatchObject({ admit: false, reason: 'isolating culprit among #7155' });
  });

  it.each([7183, 7193])('keeps ready #%s held while #7155 is enqueue-eligible in this pass', num => {
    const enqueueEligibility = eligibilityFor(readSuspect());
    expect(enqueueEligibility.get(7155)).toBe(true);
    const state = isolation();
    const before = structuredClone(state);

    expect(decide(state, num, enqueueEligibility))
      .toMatchObject({ admit: false, groupId: null, reason: 'isolating culprit among #7155' });
    const suspect = decide(state, 7155, enqueueEligibility);
    expect(suspect.admit).toBe(true);
    expect(suspect.state.groups).toContainEqual(expect.objectContaining({ prs: [7155], mode: 'isolate' }));
    expect(state).toEqual(before);
  });

  it.each([
    ['unreadable suspect', new Map([[7155, null]])],
    ['missing suspect', new Map()],
    ['unavailable pass facts', undefined],
  ])('fails closed and keeps today\'s isolation hold with %s', (_name, enqueueEligibility) => {
    const state = isolation();
    const before = structuredClone(state);
    for (const num of [7183, 7193]) {
      expect(decide(state, num, enqueueEligibility))
        .toMatchObject({ admit: false, groupId: null, reason: 'isolating culprit among #7155' });
    }
    expect(state).toEqual(before);
  });
});
