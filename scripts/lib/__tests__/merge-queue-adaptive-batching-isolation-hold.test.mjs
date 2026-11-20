// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STANDARD_BATCHING_SETTINGS, initialBatchingState, admitEnqueue, createAdaptiveBatching,
} from '../merge-queue-adaptive-batching.mjs';
import { redTeamLabelHoldReason, sendBackReason } from '../drain-queue-safety.mjs';

const nowMs = 30 * 60_000;
const settings = { ...STANDARD_BATCHING_SETTINGS, enabled: true };
const readSuspect = () => JSON.parse(readFileSync(
  new URL('./fixtures/drain-priority-label-gh-7155.json', import.meta.url), 'utf8'));
const isolation = () => ({ ...initialBatchingState(), isolate: [7155], isolateSinceMs: { 7155: 0 } });

// Pass-local, tri-state eligibility: false is known ineligible; true is eligible;
// missing/null is unreadable and retains today's isolation hold.
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

// Exercise the production reader, rather than only injecting core eligibility.
describe('isolation hold live suspect reader', () => {
  it.each(['red-team:pending', 'review:pending', 'parked', 'hold'])('releases other work on live %s and holds again when it clears', label => {
    const suspect = readSuspect();
    const shell = createAdaptiveBatching({ repo: 'owner/repo', settings, dryRun: true,
      nowMs: () => nowMs, readFile: () => JSON.stringify(isolation()), log: () => {},
      exec: (_cmd, args, options) => {
        if (args.includes('graphql')) return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: [] } } } } });
        expect(args).toEqual(['pr', 'view', '7155', '--repo', 'owner/repo', '--json', 'state,isDraft,labels,mergeStateStatus']);
        expect(options).toMatchObject({ timeout: 10_000, maxBuffer: 1024 * 1024 });
        return JSON.stringify({ state: 'OPEN', ...suspect });
      } });
    suspect.labels.push({ name: label });
    expect(shell.gate(7183).admit).toBe(true);
    suspect.labels.pop();
    expect(shell.gate(7193)).toMatchObject({ admit: false, reason: 'isolating culprit among #7155' });
  });

  it.each(['throw', 'invalid JSON', 'missing labels', 'oversized output'])('keeps the hold with %s from the live reader', failure => {
    const shell = createAdaptiveBatching({ repo: 'owner/repo', settings, dryRun: true,
      nowMs: () => nowMs, readFile: () => JSON.stringify(isolation()), log: () => {},
      exec: (_cmd, args) => {
        if (args.includes('graphql')) return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: [] } } } } });
        if (failure === 'throw' || failure === 'oversized output') throw new Error(failure === 'throw' ? 'unreadable' : 'ENOBUFS');
        return failure === 'invalid JSON' ? '{' : JSON.stringify({ state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN' });
      } });
    expect(shell.gate(7183)).toMatchObject({ admit: false, reason: 'isolating culprit among #7155' });
  });
});

it('isolation hold retains the hold and asks for inspection beyond the 100-suspect read cap', () => {
  const state = { ...isolation(), isolate: Array.from({ length: 101 }, (_, i) => i + 1),
    isolateSinceMs: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i + 1, 0])) };
  const logs = [];
  let reads = 0;
  const shell = createAdaptiveBatching({ repo: 'owner/repo', settings, dryRun: true,
    nowMs: () => nowMs, readFile: () => JSON.stringify(state), log: line => logs.push(line),
    exec: (_cmd, args) => {
      if (args.includes('graphql')) return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: [] } } } } });
      reads++;
      return JSON.stringify({ state: 'OPEN', labels: [{ name: 'red-team:pending' }] });
    } });
  expect(shell.gate(7183).admit).toBe(false);
  expect(reads).toBe(100);
  expect(logs).toContainEqual(expect.stringContaining('operator must inspect remaining suspects'));
});
