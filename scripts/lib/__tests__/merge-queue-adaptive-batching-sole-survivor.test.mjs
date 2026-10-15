// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STANDARD_BATCHING_SETTINGS, initialBatchingState, observeQueue, admitEnqueue,
  resolveBatchingSettings, formatBatchingSettings } from '../merge-queue-adaptive-batching.mjs';

const nowMs = 60 * 60_000;
const settings = (extra = {}) => ({ ...STANDARD_BATCHING_SETTINGS, enabled: true, ...extra });
const group = (extra = {}) => ({ id: 'failed-stack', prs: [5260, 5328], seen: [5260, 5328],
  mode: 'grouped', status: 'queued', openedAtMs: nowMs - 30 * 60_000, closedAtMs: nowMs - 25 * 60_000, ...extra });
const observe = (state, extra = {}) => observeQueue({ state, inQueue: new Set(), merged: new Set([5328]),
  nowMs, settings: settings(), ...extra });
const admit = (state, extra = {}) => admitEnqueue({ state, num: 5338, inQueue: new Set(),
  nowMs, settings: settings(), ...extra });
const persisted = () => ({ ...initialBatchingState(), isolate: [5260],
  isolateSinceMs: { 5260: nowMs - 20 * 60_000 },
  groups: [group({ status: 'failed', failedAtMs: nowMs - 20 * 60_000, recoveryRetired: [5260] })] });

describe('sole survivor culprit recovery', () => {
  it('identifies the sole unmerged member and admits unrelated work immediately', () => {
    const result = observe({ ...initialBatchingState(), groups: [group()] });
    expect(result.state.isolate).toEqual([]);
    expect(result.state.culprits).toEqual([{ num: 5260, atMs: nowMs }]);
    expect(result.events).toContainEqual({ type: 'culprit', num: 5260 });
    expect(result.state.groups[0].recoveryRetired ?? []).toEqual([]);
    expect(result.state.pendingDequeues ?? []).toEqual([]);
    expect(result.state.failures).toHaveLength(1);
    expect(admit(result.state).admit).toBe(true);
  });
  it.each(['admit', 'observe'])('heals persisted isolation during %s, once and without mutating input', operation => {
    const state = persisted();
    const result = operation === 'admit' ? admit(state) : observe(state);
    expect(result.state.isolate).toEqual([]);
    expect(result.state.isolateSinceMs).toEqual({});
    expect(result.state.culprits).toEqual([{ num: 5260, atMs: nowMs }]);
    expect(admit(result.state).admit).toBe(true);
    expect(observe(result.state).state.culprits).toHaveLength(1);
    expect(state.isolate).toEqual([5260]);
  });
  it('keeps the old isolation policy when disabled, including persisted recovery', () => {
    const legacy = settings({ soleSurvivorCulprit: false });
    const result = observe({ ...initialBatchingState(), groups: [group()] }, { settings: legacy });
    expect(result.state.isolate).toEqual([5260]);
    expect(result.state.culprits).toEqual([]);
    for (const state of [result.state, persisted()]) {
      expect(admit(state, { settings: legacy })).toMatchObject({ admit: false, reason: 'isolating culprit among #5260' });
    }
  });
  it('still isolates two unmerged members of a three-member group', () => {
    const result = observe({ ...initialBatchingState(), groups: [group({ prs: [5260, 5328, 5330], seen: [5260, 5328, 5330] })] });
    expect(result.state.isolate).toEqual([5260, 5330]);
    expect(result.state.culprits).toEqual([]);
  });
  it('retains dequeue recovery for a sole culprit still in the queue', () => {
    const result = observe({ ...initialBatchingState(), groups: [group()] },
      { merged: new Set(), closed: new Set([5328]), inQueue: new Set([5260]) });
    expect(result.state.isolate).toEqual([]);
    expect(result.events).toContainEqual({ type: 'culprit', num: 5260 });
    expect(result.events).toContainEqual({ type: 'dequeue', nums: [5260] });
    expect(result.state.groups[0].recoveryRetired).toEqual([5260]);
    expect(result.state.pendingDequeues).toEqual([5260]);
  });
  it('does not heal persisted isolation while the survivor remains queued', () => {
    const result = admit(persisted(), { inQueue: new Set([5260]) });
    expect(result.admit).toBe(false);
    expect(result.state.isolate).toEqual([5260]);
    expect(result.state.culprits).toEqual([]);
  });
});

describe('sole survivor setting', () => {
  it('defaults to true from the standard and accepts an env false override', () => {
    const defaults = resolveBatchingSettings({ env: {}, settings: {}, platform: {} });
    expect(defaults.soleSurvivorCulprit).toBe(true);
    expect(defaults.sources.soleSurvivorCulprit).toBe('standard');
    const overridden = resolveBatchingSettings({ env: { WE_MQ_BATCHING_SOLE_SURVIVOR_CULPRIT: '0' }, settings: {}, platform: {} });
    expect(overridden.soleSurvivorCulprit).toBe(false);
    expect(overridden.sources.soleSurvivorCulprit).toBe('env');
    expect(formatBatchingSettings(overridden)).toContain('soleSurvivorCulprit=false (env)');
  });
  it('cascades typed boolean values and rejects invalid values', () => {
    const result = resolveBatchingSettings({ env: { WE_MQ_BATCHING_SOLE_SURVIVOR_CULPRIT: 'yes' },
      settings: { mergeQueueBatching: { soleSurvivorCulprit: false } },
      platform: { mergeQueueBatching: { soleSurvivorCulprit: true } } });
    expect(result.soleSurvivorCulprit).toBe(false);
    expect(result.sources.soleSurvivorCulprit).toBe('repo');
    expect(result.invalid).toEqual(['env.soleSurvivorCulprit']);
  });
});
