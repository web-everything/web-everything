// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import {
  STANDARD_BATCHING_SETTINGS, resolveBatchingSettings, formatBatchingSettings,
  batchingStatePath, currentMode, admitEnqueue, observeQueue, intermediateRunsToCancel,
} from '../merge-queue-adaptive-batching.mjs';

const minute = 60_000;
const settings = (overrides = {}) => ({ ...STANDARD_BATCHING_SETTINGS, enabled: true, ...overrides });
const empty = () => ({ groups: [], isolate: [], failures: [], culprits: [], strictUntilMs: null });
const group = (overrides = {}) => ({ id: 'g1', prs: [1, 2], openedAtMs: 0, closedAtMs: 0, mode: 'grouped', status: 'queued', ...overrides });
const admit = (state, num, nowMs = 0, opts = {}) => admitEnqueue({ state, num, nowMs, settings: settings(), inQueue: new Set(), ...opts });
const observe = (state, opts = {}) => observeQueue({ state, inQueue: new Set(), merged: new Set(), nowMs: minute, settings: settings(), ...opts });

describe('recovery liveness and bounds regressions', () => {
  it.each(['before', 'during'])('releases closed isolation members %s admission', (when) => {
    const failed = observe({ ...empty(), groups: [group({ seen: [1, 2] })] }).state;
    const state = when === 'during' ? admit(failed, 1, minute).state : failed;
    const result = observe(state, { closed: new Set([1, 2]) });
    expect(result.state.isolate).toEqual([]);
    expect(admit(result.state, 4, minute).admit).toBe(true);
  });
  it.each(['merged', 'closed', 'singleton', 'expiry'])('every recovery member exits through %s', exit => {
    let state = observe({ ...empty(), groups: [group({ seen: [1, 2] })] }).state;
    for (const num of [1, 2]) {
      if (exit === 'singleton') {
        state = admit(state, num, minute).state;
        state.groups.find(g => g.mode === 'isolate' && g.prs.includes(num)).seen = [num];
      }
      state = observe(state, {
        merged: new Set(exit === 'merged' ? [num] : []),
        closed: new Set(exit === 'closed' ? [num] : []),
        nowMs: exit === 'expiry' ? 62 * minute : minute,
      }).state;
    }
    expect(state.isolate).toEqual([]);
    expect(admit(state, 4, 62 * minute).admit).toBe(true);
  });
  it('prunes failed history after the failure window', () => {
    const state = { ...empty(), groups: Array.from({ length: 100 }, (_, i) => group({ id: `old-${i}`, status: 'failed' })) };
    expect(observe(state, { nowMs: 121 * minute }).state.groups).toEqual([]);
  });
  it('does not infer native group tips from admission order, queue positions, or split refs', () => {
    const runs = [1, 2, 3].map(id => ({ id, event: 'merge_group', status: 'in_progress', head_branch: `gh-readonly-queue/main/pr-${id}-abc` }));
    for (const entries of [[3, 1, 2], [1, 2, 3]]) {
      expect(intermediateRunsToCancel({ groups: [group({ prs: [1, 2, 3] })], entries: entries.map((num, position) => ({ num, position })), runs, groupingStrategy: 'HEADGREEN', settings: settings() })).toEqual([]);
    }
  });
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

describe('batching settings', () => {
  it('resolves every key independently and formats every value and source', () => {
    const s = resolveBatchingSettings({
      env: { WE_MQ_BATCHING_ENABLED: 'false', WE_MQ_BATCHING_GROUP_SIZE: '5' },
      settings: { mergeQueueBatching: { enabled: true, groupSize: 2, failureThreshold: 7 } },
      platform: { mergeQueueBatching: { groupSize: 4, failureThreshold: 6, strictModeMinutes: 10 } },
    });
    expect(s).toMatchObject({ enabled: false, groupSize: 5, failureThreshold: 7, strictModeMinutes: 10, groupFormMinutes: 5 });
    expect(s.sources).toMatchObject({ enabled: 'env', groupSize: 'env', failureThreshold: 'repo', strictModeMinutes: 'platform', groupFormMinutes: 'standard' });
    expect(s.invalid).toEqual([]);
    for (const key of Object.keys(STANDARD_BATCHING_SETTINGS)) expect(formatBatchingSettings(s)).toContain(`${key}=${s[key]} (${s.sources[key]})`);
    expect(formatBatchingSettings(s)).not.toContain('\n');
  });
  it.each(['0', 'false', '1', 'true'])('accepts enabled env %s', (value) => {
    expect(resolveBatchingSettings({ env: { WE_MQ_BATCHING_ENABLED: value }, settings: {}, platform: {} }).enabled).toBe(['1', 'true'].includes(value));
  });
  it('ignores invalid values at every layer, including shadowed ones', () => {
    const s = resolveBatchingSettings({ env: { WE_MQ_BATCHING_GROUP_SIZE: '2.5', WE_MQ_BATCHING_ENABLED: 'yes' }, settings: { mergeQueueBatching: { groupSize: 0, enabled: 'true' } }, platform: { mergeQueueBatching: { groupSize: 6, enabled: true } } });
    expect(s.groupSize).toBe(3);
    expect(s.enabled).toBe(true);
    expect(s.invalid.sort()).toEqual(['env.enabled', 'env.groupSize', 'platform.groupSize', 'repo.enabled', 'repo.groupSize']);
  });
  it.each([
    ['groupSize', 'GROUP_SIZE', 1, 0], ['groupFormMinutes', 'GROUP_FORM_MINUTES', 0, -1],
    ['maxGroupsInFlight', 'MAX_GROUPS_IN_FLIGHT', 1, 0], ['failureThreshold', 'FAILURE_THRESHOLD', 1, 0],
    ['failureWindowMinutes', 'FAILURE_WINDOW_MINUTES', 1, 0], ['strictModeMinutes', 'STRICT_MODE_MINUTES', 1, 0],
    ['isolateTimeoutMinutes', 'ISOLATE_TIMEOUT_MINUTES', 1, 0],
    ['rulesetId', 'RULESET_ID', 42, 1.5], ['cancelIntermediateRuns', 'CANCEL_INTERMEDIATE_RUNS', 'on', 'yes'],
  ])('validates %s for numeric/string env and typed repo values', (key, suffix, valid, invalid) => {
    expect(resolveBatchingSettings({ env: { [`WE_MQ_BATCHING_${suffix}`]: String(valid) }, settings: {}, platform: {} })[key]).toBe(valid);
    expect(resolveBatchingSettings({ env: {}, settings: { mergeQueueBatching: { [key]: invalid } }, platform: {} }).invalid).toEqual([`repo.${key}`]);
    expect(resolveBatchingSettings({ env: { [`WE_MQ_BATCHING_${suffix}`]: '' }, settings: {}, platform: {} }).invalid).toEqual([`env.${key}`]);
  });
  it('uses standard defaults under test and the feature file declares only repo overrides', () => {
    expect(resolveBatchingSettings({ env: { VITEST: 'true' }, platform: {} })).toMatchObject(STANDARD_BATCHING_SETTINGS);
    expect(resolveBatchingSettings({ env: { WE_UNDER_TEST: '1' }, platform: {} })).toMatchObject(STANDARD_BATCHING_SETTINGS);
    const declared = JSON.parse(readFileSync(new URL('../../settings/merge-queue-batching.json', import.meta.url), 'utf8'));
    expect(declared.mergeQueueBatching).toEqual({ enabled: true, groupSize: 3, maxGroupsInFlight: 8 });
    expect(resolveBatchingSettings({ env: {}, settings: declared, platform: {} }).sources.enabled).toBe('repo');
    expect(batchingStatePath({ WE_COORDINATION_ROOT: 'batching-test' })).toBe(join(resolve('batching-test'), 'drain-merge-queue-batching.json'));
  });
});

describe('pure admission', () => {
  it('prioritizes off, strict, isolate, then grouped', () => {
    const state = { ...empty(), isolate: [1], strictUntilMs: 100 };
    expect(currentMode(state, 0, settings({ enabled: false }))).toBe('off');
    expect(currentMode(state, 0, settings())).toBe('strict');
    expect(currentMode(state, 100, settings())).toBe('isolate');
    expect(currentMode(empty(), 100, settings())).toBe('grouped');
    expect(admit(freeze(state), 2, 0, { settings: settings({ enabled: false }) })).toMatchObject({ admit: true, mode: 'off', state });
  });
  it('joins, closes when full, and defers at the group cap without mutation', () => {
    const first = admit(freeze(empty()), 1);
    expect(first.state.groups[0]).toMatchObject({ prs: [1], status: 'forming', closedAtMs: null });
    const second = admit(freeze(first.state), 2);
    const third = admit(freeze(second.state), 3);
    expect(third.state.groups[0]).toMatchObject({ prs: [1, 2, 3], status: 'queued', closedAtMs: 0 });
    expect(admit(third.state, 4)).toMatchObject({ admit: false, reason: 'queue holds 1 group(s) (max 1)' });
    expect(first.state.groups[0].prs).toEqual([1]);
    expect(third.groupId).toBe(first.groupId);
  });
  it('joins at the time boundary, closes after expiry, and opens another group with capacity', () => {
    const first = admit(empty(), 1);
    expect(admit(first.state, 2, 5 * minute).admit).toBe(true);
    const expired = admit(first.state, 2, 5 * minute + 1);
    expect(expired.admit).toBe(false);
    expect(expired.state.groups[0]).toMatchObject({ status: 'queued', closedAtMs: 5 * minute + 1 });
    const next = admit(first.state, 2, 6 * minute, { settings: settings({ maxGroupsInFlight: 2 }) });
    expect(next.admit).toBe(true);
    expect(next.state.groups).toHaveLength(2);
    expect(next.groupId).not.toBe(first.groupId);
  });
  it('isolates one PR at a time and defers unrelated PRs', () => {
    const state = freeze({ ...empty(), isolate: [1, 2] });
    expect(admit(state, 3)).toMatchObject({ admit: false, reason: 'isolating culprit among #1,#2' });
    expect(admit(state, 2, 0, { inQueue: new Set([1]) }).admit).toBe(false);
    expect(admit(state, 1).state.groups[0]).toMatchObject({ prs: [1], mode: 'isolate', status: 'queued' });
    expect(admit(state, 1, 0, { inQueue: new Set([1]) }).state.groups).toEqual([]);
  });
  it('strict creates singleton groups up to maxGroupsInFlight', () => {
    const state = { ...empty(), strictUntilMs: minute };
    const first = admit(state, 1, 0, { settings: settings({ maxGroupsInFlight: 2 }) });
    const second = admit(first.state, 2, 0, { settings: settings({ maxGroupsInFlight: 2 }) });
    expect(second.state.groups.map(g => [g.mode, g.prs, g.status])).toEqual([['strict', [1], 'queued'], ['strict', [2], 'queued']]);
    expect(admit(second.state, 3, 0, { settings: settings({ maxGroupsInFlight: 2 }) }).admit).toBe(false);
  });
  it('does not append duplicate admissions on a retry', () => {
    const first = admit(empty(), 1);
    expect(admit(first.state, 1).state).toEqual(first.state);
  });
  it('defers re-enqueue of a seen PR that left the queue until observation records the exit', () => {
    const grouped = freeze({ ...empty(), groups: [group({ seen: [1, 2] })] });
    expect(admit(grouped, 1, 0, { inQueue: new Set([2]) })).toMatchObject({ admit: false, groupId: null, reason: '#1 left the queue; observe its exit before re-enqueue' });
    expect(admit(grouped, 2, 0, { inQueue: new Set([2]) })).toMatchObject({ admit: true, groupId: 'g1' });
    const isolated = freeze({ ...empty(), isolate: [1], groups: [group({ mode: 'isolate', prs: [1], seen: [1] })] });
    expect(admit(isolated, 1)).toMatchObject({ admit: false, mode: 'isolate', groupId: null });
    expect(admit(isolated, 1, 0, { inQueue: new Set([1]) })).toMatchObject({ admit: true, groupId: 'g1' });
    // A pending member is not re-enqueued into a group with an unobserved exit.
    const pending = freeze({ ...empty(), groups: [group({ seen: [1] })] });
    expect(admit(pending, 2)).toMatchObject({ admit: false, reason: '#1 left the queue; observe its exit before re-enqueue' });
  });
  it('never joins a forming group whose seen member left the queue', () => {
    const forming = freeze({ ...empty(), groups: [group({ status: 'forming', prs: [1], seen: [1] })] });
    expect(admit(forming, 3, 0, { inQueue: new Set([1]) })).toMatchObject({ admit: true, groupId: 'g1' });
    const stale = admit(forming, 3);
    expect(stale).toMatchObject({ admit: false, reason: 'queue holds 1 group(s) (max 1)' });
    expect(stale.state.groups[0]).toMatchObject({ prs: [1], status: 'queued' });
  });
  it('supports groupSize one and zero forming time without holding terminal groups', () => {
    const state = { ...empty(), groups: [group({ status: 'done' }), group({ id: 'failed', status: 'failed' })] };
    expect(admit(state, 3, 0, { settings: settings({ groupSize: 1 }) }).state.groups.at(-1))
      .toMatchObject({ prs: [3], status: 'queued', closedAtMs: 0 });
    const first = admit(empty(), 1, 0, { settings: settings({ groupFormMinutes: 0 }) });
    expect(admit(first.state, 2, 1, { settings: settings({ groupFormMinutes: 0 }) }).admit).toBe(false);
  });
  it('uses unique deterministic IDs when the same PR returns at the same timestamp', () => {
    const first = admit(empty(), 1);
    const state = { ...first.state, groups: first.state.groups.map(g => ({ ...g, status: 'failed' })) };
    expect(admit(state, 1).groupId).not.toBe(first.groupId);
    expect(admit(state, 1).groupId).toBe(admit(state, 1).groupId);
  });
});

describe('pure observation', () => {
  it('drops an abandoned admission after its grace without failure or isolation, completing an empty group', () => {
    const admitted = admit(empty(), 1);
    expect(admitted.admit).toBe(true);
    expect(admitted.state.groups[0].seen ?? []).toEqual([]);
    const result = observe(freeze(admitted.state), { nowMs: 6 * minute });
    expect(result.state.groups[0]).toMatchObject({ prs: [], seen: [], status: 'done', closedAtMs: 6 * minute });
    expect(result.state.failures).toEqual([]);
    expect(result.state.isolate).toEqual([]);
    expect(result.state.culprits).toEqual([]);
    expect(result.events).toEqual([]);
    expect(admit(result.state, 1, minute).admit).toBe(true);
  });
  it('records queue membership and treats a seen PR missing from both queue and merges as ejected', () => {
    const admitted = admit(empty(), 1);
    const queued = observe(freeze(admitted.state), { inQueue: new Set([1]) });
    expect(queued.state.groups[0].seen).toEqual([1]);
    expect(queued.state.failures).toEqual([]);
    const ejected = observe(freeze(queued.state), { nowMs: 2 * minute });
    expect(ejected.state.groups[0]).toMatchObject({ prs: [1], seen: [1], status: 'failed' });
    expect(ejected.state.failures).toEqual([{ atMs: 2 * minute, groupId: admitted.groupId, prs: [1] }]);
    expect(ejected.events).toEqual([{ type: 'culprit', num: 1 }]);
  });
  it('marks merged groups done and releases good isolate PRs', () => {
    const state = freeze({ ...empty(), groups: [group({ mode: 'isolate', prs: [1] })], isolate: [1, 2] });
    const result = observe(state, { merged: new Set([1]) });
    expect(result.state.groups[0].status).toBe('done');
    expect(result.state.isolate).toEqual([2]);
    expect(result.events).toEqual([]);
  });
  it('allows terminal failed groups to become done without recounting their failure', () => {
    const result = observe({ ...empty(), groups: [group({ status: 'failed' })] }, { merged: new Set([1, 2]) });
    expect(result.state.groups[0].status).toBe('done');
    expect(result.state.failures).toEqual([]);
  });
  it('keeps a partially merged stack active when the rest remains queued', () => {
    const state = freeze({ ...empty(), groups: [group({ seen: [1, 2] })] });
    const result = observe(state, { merged: new Set([1]), inQueue: new Set([2]) });
    expect(result.state).toEqual(state);
    expect(result.events).toEqual([]);
  });
  it('prunes expired failures before evaluating K on a new failure', () => {
    const state = { ...empty(), groups: [group({ prs: [1], seen: [1] })], failures: [{ atMs: 0 }, { atMs: 0 }] };
    const result = observe(state, { nowMs: 121 * minute });
    expect(result.state.failures).toHaveLength(1);
    expect(result.state.strictUntilMs).toBeNull();
    expect(result.events).toEqual([{ type: 'culprit', num: 1 }]);
  });
  it('fails a grouped stack, dequeues remaining members, and isolates only unmerged PRs once', () => {
    const result = observe(freeze({ ...empty(), groups: [group({ prs: [1, 2, 3], seen: [1, 2, 3] })] }), { inQueue: new Set([2]), merged: new Set([3]) });
    expect(result.state.groups[0].status).toBe('failed');
    expect(result.state.failures).toEqual([{ atMs: minute, groupId: 'g1', prs: [1, 2, 3] }]);
    expect(result.events).toEqual([{ type: 'dequeue', nums: [2] }, { type: 'isolate', nums: [1, 2] }]);
    expect(result.state.isolate).toEqual([1, 2]);
    expect(observe(result.state).state.failures).toHaveLength(1);
    expect(observe(result.state).events).toEqual([]);
  });
  it.each(['isolate', 'strict', 'grouped'])('identifies an ejected singleton in %s mode as culprit', (mode) => {
    const result = observe({ ...empty(), groups: [group({ mode, prs: [1], seen: [1] })], isolate: [1, 2] });
    expect(result.events).toEqual([{ type: 'culprit', num: 1 }]);
    expect(result.state.culprits).toEqual([{ num: 1, atMs: minute }]);
    expect(result.state.isolate).toEqual([2]);
  });
  it('enters strict at K recent failures without extending an existing episode', () => {
    const state = { ...empty(), groups: [group({ prs: [1], seen: [1] })], failures: [{ atMs: 0, groupId: 'old1', prs: [7] }, { atMs: 0, groupId: 'old2', prs: [8] }] };
    const result = observe(state);
    expect(result.events).toContainEqual({ type: 'strict-on', untilMs: 61 * minute });
    expect(result.state.strictUntilMs).toBe(61 * minute);
    const next = observe({ ...result.state, groups: [...result.state.groups, group({ id: 'new', prs: [2], seen: [2] })] }, { nowMs: 2 * minute });
    expect(next.state.failures).toHaveLength(4);
    expect(next.events.some(e => e.type === 'strict-on')).toBe(false);
    expect(next.state.strictUntilMs).toBe(61 * minute);
  });
  it('expires strict once, prunes old terminal groups, and retains active groups', () => {
    const nowMs = 25 * 60 * minute;
    const state = { ...empty(), strictUntilMs: nowMs, failures: [{ atMs: nowMs - 121 * minute }, { atMs: nowMs - 120 * minute }], groups: [group({ status: 'done' }), group({ id: 'recent', status: 'done', closedAtMs: nowMs }), group({ id: 'active', prs: [3] }), group({ id: 'failed', status: 'failed' })] };
    const result = observe(freeze(state), { nowMs, inQueue: new Set([3]) });
    expect(result.events).toEqual([{ type: 'strict-off' }]);
    expect(result.state.strictUntilMs).toBeNull();
    expect(result.state.failures).toHaveLength(1);
    expect(result.state.groups.map(g => g.id)).toEqual(['recent', 'active']);
    expect(observe(result.state, { nowMs, inQueue: new Set([3]) }).events).toEqual([]);
  });
});

describe('intermediate cancellation selection', () => {
  const runs = [
    { id: 10, event: 'merge_group', status: 'in_progress', head_branch: 'gh-readonly-queue/main/pr-1-abc' },
    { id: 11, event: 'merge_group', status: 'completed', head_branch: 'gh-readonly-queue/main/pr-2-def' },
    { id: 12, event: 'merge_group', status: 'queued', head_branch: 'gh-readonly-queue/main/pr-3-ghi' },
    { id: 13, event: 'push', status: 'in_progress', head_branch: 'gh-readonly-queue/main/pr-2-jkl' },
    { id: 14, event: 'merge_group', status: 'in_progress', head_branch: 'gh-readonly-queue/other/pr-2-jkl' },
    { id: 15, event: 'merge_group', status: 'in_progress', head_branch: 'gh-readonly-queue/main/pr-10-jkl' },
  ];
  const select = (opts = {}) => intermediateRunsToCancel({ nativeGroups: [{ prs: [1, 2, 3], tip: 3 }], runs, groupingStrategy: 'HEADGREEN', settings: settings(), ...opts });
  it('auto cancels only non-last running merge_group refs under HEADGREEN', () => {
    expect(select()).toEqual([{ id: 10, num: 1, reason: 'headgreen-intermediate' }]);
    expect(select({ groupingStrategy: 'ALLGREEN' })).toEqual([]);
    expect(select({ groupingStrategy: null })).toEqual([]);
    expect(select({ settings: settings({ cancelIntermediateRuns: 'off' }) })).toEqual([]);
    expect(select({ groupingStrategy: 'ALLGREEN', settings: settings({ cancelIntermediateRuns: 'on' }) })).toHaveLength(1);
  });
  it('requires the native tip run and proven native membership', () => {
    expect(select({ runs: runs.filter(r => r.id !== 12) })).toEqual([]);
    expect(select({ nativeGroups: [] })).toEqual([]);
    expect(select({ nativeGroups: [{ prs: [1, 2], tip: 3 }] })).toEqual([]);
    expect(select({ nativeGroups: [{ prs: [1, 2], tip: 2 }, { prs: [3], tip: 3 }] })).toHaveLength(1);
    expect(select({ nativeGroups: [{ prs: [3, 1, 2], tip: 2 }] }).map(r => r.id)).toEqual([10, 12]);
  });
});

// C/D: injectable IO, drain seam, and deterministic replay.
import { createAdaptiveBatching, readQueueFacts, readGroupingStrategy, replayBatching } from '../merge-queue-adaptive-batching.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';

function ioHarness({ state = empty(), queue = [], dryRun = false, failQueue = false, strategy = 'HEADGREEN', runs = [], dequeue = () => {} } = {}) {
  let stored = structuredClone(state);
  const calls = [], logs = [], writes = [], renames = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('graphql')) {
      if (args.some(a => a.includes('dequeuePullRequest'))) {
        dequeue(Number(args.find(a => a.startsWith('id=pr-')).slice(6)));
        return JSON.stringify({ data: { dequeuePullRequest: { mergeQueueEntry: { id: 'e' } } } });
      }
      if (failQueue) throw new Error('queue unavailable');
      return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: queue.map(num => ({ id: `entry-${num}`, pullRequest: { id: `pr-${num}`, number: num } })) } } } } });
    }
    if (args[0] === 'pr') return JSON.stringify({ state: 'OPEN' });
    if (args.some(a => a.includes('/rulesets/'))) return JSON.stringify({ rules: [{ type: 'merge_queue', parameters: { grouping_strategy: strategy } }] });
    if (args.some(a => a.includes('/actions/runs?'))) return JSON.stringify({ workflow_runs: runs });
    if (args.includes('POST')) return '';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const shell = createAdaptiveBatching({ repo: 'owner/repo', exec, statePath: 'test-state.json', withLock: (_path, fn) => fn(), settings: resolveBatchingSettings({ env: {}, settings: { mergeQueueBatching: { enabled: true } }, platform: {} }), dryRun,
    nowMs: () => minute, readFile: () => JSON.stringify(stored), writeFile: (path, value) => { writes.push(path); stored = JSON.parse(value); }, rename: (from, to) => renames.push([from, to]), mkdir: () => {}, log: line => logs.push(line) });
  return { shell, exec, calls, logs, writes, renames, state: () => stored };
}

describe('batching IO shell and drain hook', () => {
  it('retries only outstanding recovery dequeues after a transient failure and restart', () => {
    const queue = [2, 3], attempts = [];
    const dequeue = num => {
      attempts.push(num);
      if (num === 2 && attempts.filter(n => n === 2).length === 1) throw new Error('HTTP 502');
      queue.splice(queue.indexOf(num), 1);
    };
    const h = ioHarness({ state: { ...empty(), groups: [group({ prs: [1, 2, 3], seen: [1, 2, 3] })] }, queue, dequeue });
    expect(h.shell.observe({}).dequeued).toEqual([3]);
    expect(h.shell.gate(1).admit).toBe(false);
    const restarted = ioHarness({ state: h.state(), queue, dequeue });
    expect(restarted.shell.observe({}).dequeued).toEqual([2]);
    expect(attempts).toEqual([2, 3, 2]);
    expect(restarted.state().failures).toHaveLength(1);
    expect(restarted.shell.gate(1).admit).toBe(true);
  });
  it('ignores confirmation retired by recovery but tracks a fresh isolation admission', () => {
    const queue = [1];
    const h = ioHarness({ state: { ...empty(), groups: [group({ status: 'forming', prs: [1], seen: [1] })] }, queue,
      dequeue: num => queue.splice(queue.indexOf(num), 1) });
    expect(h.shell.gate(2).admit).toBe(true);
    queue.splice(0, queue.length, 2); // #1 ejected; #2's enqueue succeeded, confirmation is delayed
    expect(h.shell.observe({}).dequeued).toEqual([2]);
    h.shell.confirm(2);
    expect(h.shell.observe({}).events).toEqual([]);
    expect(h.state().culprits).toEqual([]);
    expect(h.state().isolate).toEqual([1, 2]);
    expect(h.shell.gate(2).admit).toBe(true);
    h.shell.confirm(2);
    expect(h.shell.observe({}).events).toContainEqual({ type: 'culprit', num: 2 });
  });
  it('records an ejection before the drain can re-enqueue the ejected PR into its old group', () => {
    const queue = [2];
    const h = ioHarness({ state: { ...empty(), groups: [group({ seen: [1, 2] })] }, queue,
      dequeue: num => queue.splice(queue.indexOf(num), 1) });
    // Drain order: enqueue (gate → enqueue → confirm), then observe.
    const gate = h.shell.gate(1);
    if (gate.admit) { queue.push(1); h.shell.confirm(1, gate.groupId); }
    expect(gate).toMatchObject({ admit: false });
    const observed = h.shell.observe({});
    expect(observed.events).toContainEqual({ type: 'isolate', nums: [1, 2] });
    expect(observed.dequeued).toEqual([2]);
    expect(h.state().failures).toHaveLength(1);
    expect(h.state().isolate).toEqual([1, 2]);
    expect(h.shell.gate(1)).toMatchObject({ admit: true, mode: 'isolate' });
  });
  it('records an exit that happens between gate and a fresh enqueue', () => {
    const queue = [1, 2];
    const h = ioHarness({ state: { ...empty(), groups: [group({ seen: [1, 2] })] }, queue,
      dequeue: num => queue.splice(queue.indexOf(num), 1) });
    const gate = h.shell.gate(1);
    expect(gate).toMatchObject({ admit: true, groupId: 'g1' });
    // #1 is ejected, then the drain's enqueue re-adds it (not `already`).
    h.shell.confirm(1, gate.groupId, { already: false });
    expect(h.state().failures).toHaveLength(1);
    expect(h.state().isolate).toEqual([1, 2]);
    expect(h.shell.observe({}).dequeued).toEqual([1, 2]);
    // A PR already in the queue (`already`) is not an exit.
    const steady = ioHarness({ state: { ...empty(), groups: [group({ seen: [1, 2] })] }, queue: [1, 2] });
    steady.shell.confirm(1, 'g1', { already: true });
    expect(steady.state().failures).toEqual([]);
  });
  it('records a culprit and dequeues a singleton that re-enters between gate and enqueue', () => {
    const h = ioHarness({ state: { ...empty(), groups: [group({ prs: [1], seen: [1] })] }, queue: [1] });
    h.shell.confirm(1, 'g1', { already: false });
    expect(h.state().culprits).toEqual([{ num: 1, atMs: minute }]);
    expect(h.state().pendingDequeues).toEqual([1]);
  });
  it('defers a seen PR when the queue is unreadable, failing open for others', () => {
    const h = ioHarness({ state: { ...empty(), groups: [group({ seen: [1] })] }, failQueue: true });
    expect(h.shell.gate(1)).toMatchObject({ admit: false });
    expect(h.shell.gate(3).admit).toBe(true);
    expect(h.writes).toEqual([]);
  });
  it('treats a merge queue beyond one page as unreadable rather than as ejections', () => {
    const exec = () => JSON.stringify({ data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: true }, nodes: [] } } } } });
    expect(readQueueFacts({ repo: 'o/r', exec })).toMatchObject({ error: 'merge queue has more than 100 entries' });
  });
  it('does not let an old confirmation mark a replacement reservation seen', () => {
    const queue = [2];
    const h = ioHarness({ state: { ...empty(), groups: [group({ prs: [1, 2], seen: [1] })] }, queue,
      dequeue: num => queue.splice(queue.indexOf(num), 1) });
    h.shell.observe({});
    const fresh = h.shell.gate(2);
    expect(fresh.groupId).not.toBe('g1');
    h.shell.confirm(2, 'g1');
    expect(h.state().groups.find(g => g.id === fresh.groupId).seen ?? []).toEqual([]);
    expect(h.shell.observe({}).events).toEqual([]);
    expect(h.state().culprits).toEqual([]);
  });
  it('dequeues an enqueue that finishes after recovery observed its reservation', () => {
    const queue = [1];
    const h = ioHarness({ state: { ...empty(), groups: [group({ prs: [1], seen: [1], status: 'forming' })] }, queue,
      dequeue: num => queue.splice(queue.indexOf(num), 1) });
    const admission = h.shell.gate(2);
    queue.length = 0; // #1 ejected before #2's enqueue lands
    h.shell.observe({});
    queue.push(2);
    // Recovery catches this even if the enqueue process crashes before confirm.
    expect(h.shell.gate(1).admit).toBe(false);
    expect(h.shell.observe({}).dequeued).toEqual([2]);
    h.shell.confirm(2, admission.groupId);
    expect(h.shell.observe({}).events).toEqual([]);
    expect(h.state().culprits).toEqual([]);
  });
  it('acknowledges a stale recovery effect before a fresh enqueue reuses the PR', () => {
    const queue = [2];
    const h = ioHarness({ state: { ...empty(), groups: [group({ seen: [1, 2] })] }, queue,
      dequeue: num => queue.splice(queue.indexOf(num), 1) });
    h.shell.observe({});
    h.shell.confirm(2, 'g1');
    const fresh = h.shell.gate(2);
    queue.push(2);
    h.shell.confirm(2, fresh.groupId);
    expect(h.shell.observe({}).dequeued).toEqual([]);
    queue.length = 0;
    expect(h.shell.observe({ mergedNums: [2] }).events).toEqual([]);
    expect(h.state().culprits).toEqual([]);
  });
  it('preserves admission between gate and confirm, and expires abandoned reservations', () => {
    const h = ioHarness();
    const gate = h.shell.gate(1);
    expect(h.shell.observe({}).events).toEqual([]);
    expect(h.state().groups.find(g => g.id === gate.groupId).prs).toEqual([1]);
    h.shell.confirm(1);
    expect(h.shell.observe({}).events).toEqual([{ type: 'culprit', num: 1 }]);
    const abandoned = admit(empty(), 2).state;
    const expired = observe(abandoned, { nowMs: 6 * minute });
    expect(expired.state.groups[0].status).toBe('done');
    expect(expired.state.failures).toEqual([]);
    expect(admit(expired.state, 3, 6 * minute).admit).toBe(true);
  });
  it('restores tracking when confirmation arrives after reservation expiry', () => {
    const h = ioHarness({ state: { ...empty(), groups: [group({ status: 'done', prs: [1] })] } });
    h.shell.confirm(1);
    expect(h.state().groups.filter(g => g.status === 'queued')).toHaveLength(1);
    expect(h.shell.observe({}).events).toEqual([{ type: 'culprit', num: 1 }]);
  });
  it('defers contention without writing unlocked and retries after release', () => {
    let locked = true, writes = 0;
    const h = ioHarness();
    const shell = createAdaptiveBatching({ repo: 'owner/repo', exec: h.exec, settings: settings(), statePath: 'fixture.json',
      readFile: () => JSON.stringify(empty()), writeFile: () => { writes++; }, mkdir: () => {}, rename: () => {}, log: () => {},
      withLock: (_path, fn, opts) => {
        expect(opts.leaseMinutes).toBe(Infinity);
        if (locked) throw Object.assign(new Error('held by another process'), { code: 'ELOCKTIMEOUT' });
        return fn();
      },
    });
    expect(shell.gate(1).admit).toBe(false);
    expect(shell.observe({}).error).toBeTruthy();
    shell.confirm(1);
    expect(writes).toBe(0);
    locked = false;
    expect(shell.gate(1).admit).toBe(true);
    expect(writes).toBe(1);
  });
  it.each(['CLOSED', 'DRAFT'])('cleans up %s members through the real observation facade', terminal => {
    let stored = { ...empty(), groups: [group({ seen: [1, 2] })] };
    const h = ioHarness();
    const shell = createAdaptiveBatching({ repo: 'owner/repo', statePath: 'fixture.json', settings: settings(),
      withLock: (_path, fn) => fn(), mkdir: () => {}, rename: () => {}, nowMs: () => minute,
      readFile: () => JSON.stringify(stored), writeFile: (_path, text) => { stored = JSON.parse(text); }, log: () => {},
      exec: (cmd, args) => args[0] === 'pr' ? JSON.stringify({ state: terminal === 'CLOSED' ? 'CLOSED' : 'OPEN', isDraft: terminal === 'DRAFT' }) : h.exec(cmd, args),
    });
    expect(shell.observe({}).error).toBeUndefined();
    expect(stored.isolate).toEqual([]);
    expect(shell.gate(4).admit).toBe(true);
  });
  it('does not look up terminal failed history on every pass', () => {
    const h = ioHarness({ state: { ...empty(), groups: Array.from({ length: 100 }, (_, i) => group({ id: `failed-${i}`, prs: [100 + i], status: 'failed' })) } });
    expect(h.shell.observe({}).error).toBeUndefined();
    expect(h.calls.filter(c => c[1] === 'pr')).toEqual([]);
  });
  it.each(['gate', 'observe'])('preserves overlapping admission and %s transactions across processes', async operation => {
    const root = mkdtempSync(join(tmpdir(), 'batching-race-'));
    const statePath = join(root, 'state.json');
    const moduleUrl = new URL('../merge-queue-adaptive-batching.mjs', import.meta.url).href;
    const children = [];
    const waitFor = async file => {
      const until = Date.now() + 5000;
      while (!existsSync(file)) {
        if (Date.now() > until) throw new Error(`worker did not reach ${file}`);
        await new Promise(r => setTimeout(r, 10));
      }
    };
    const launch = (first, op) => {
      const source = `
        import { createAdaptiveBatching, STANDARD_BATCHING_SETTINGS } from ${JSON.stringify(moduleUrl)};
        import { readFileSync, writeFileSync, existsSync } from 'node:fs';
        writeFileSync(${JSON.stringify(join(root, first ? 'first-started' : 'second-started'))}, 'started');
        const shell = createAdaptiveBatching({ repo: 'owner/repo', statePath: ${JSON.stringify(statePath)},
          settings: { ...STANDARD_BATCHING_SETTINGS, enabled: true, cancelIntermediateRuns: 'off' }, log: () => {},
          exec: (_cmd, args) => args.includes('graphql') ? JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: ${first ? '[1]' : '[1, 2]'}.map(number => ({ pullRequest: { id: 'pr-' + number, number } })) } } } } }) : '{}',
          readFile: (path, encoding) => {
            const text = readFileSync(path, encoding);
            if (${first}) {
              writeFileSync(${JSON.stringify(join(root, 'loaded'))}, 'loaded');
              const deadline = Date.now() + 5000;
              while (!existsSync(${JSON.stringify(join(root, 'release'))})) {
                if (Date.now() > deadline) throw new Error('barrier timed out');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              }
            }
            return text;
          }
        });
        const result = ${op === 'gate' ? `shell.gate(${first ? 2 : 3})` : 'shell.observe({})'};
        if (result.error) throw new Error(result.error);
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      let errors = '';
      child.stderr.on('data', data => { errors += data; });
      return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(errors)));
      });
    };
    try {
      writeFileSync(statePath, JSON.stringify({ ...empty(), groups: [group({ status: 'forming', prs: [1], seen: [1], openedAtMs: Date.now() })] }));
      const first = launch(true, 'gate');
      await waitFor(join(root, 'loaded'));
      const second = launch(false, operation);
      await waitFor(join(root, 'second-started'));
      // Give the second writer time to read the stale snapshot if locking regresses.
      await new Promise(r => setTimeout(r, 100));
      writeFileSync(join(root, 'release'), 'release');
      await Promise.all([first, second]);
      const stored = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(stored.groups.flatMap(g => g.prs)).toEqual(operation === 'gate' ? [1, 2, 3] : [1, 2]);
      if (operation === 'observe') expect(stored.groups[0].seen).toEqual([1, 2]);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
  it('confirm persists seen so an ejection before the first observe still counts', () => {
    const h = ioHarness();
    const admitted = h.shell.gate(1);
    expect(admitted.admit).toBe(true);
    expect(h.state().groups[0].seen ?? []).toEqual([]);
    const callsBeforeConfirm = h.calls.length;
    const writesBeforeConfirm = h.writes.length;
    h.shell.confirm(1);
    expect(h.state().groups[0].seen).toEqual([1]);
    expect(h.writes).toHaveLength(writesBeforeConfirm + 1);
    expect(h.renames.at(-1)[1]).toBe('test-state.json');
    expect(h.calls).toHaveLength(callsBeforeConfirm);
    expect(h.shell.observe({}).events).toEqual([{ type: 'culprit', num: 1 }]);
    expect(h.state().groups[0].status).toBe('failed');
    expect(h.state().failures).toEqual([{ atMs: minute, groupId: admitted.groupId, prs: [1] }]);
  });
  it('the drain confirms only after a successful enqueue, and never after a deferred admission', () => {
    const head = 'a'.repeat(40);
    const order = [];
    let stored = { pending: [], followedUp: [] };
    const drain = createDrainMergeStrategy({
      resolved: { policy: { strategy: 'github-merge-queue', sources: {} }, note: null },
      localSlug: 'owner/repo', log: { write: () => {} },
      readRedTeamEvidence: () => ({ loopPayload: null, inFlight: false, recorded: false }),
      readFile: () => JSON.stringify(stored), writeState: (_path, state) => { stored = structuredClone(state); },
      batching: {
        gate: num => { order.push(['gate', num]); return num === 1 ? { admit: true, groupId: 'reservation-1' } : { admit: false, reason: 'group full' }; },
        confirm: (num, groupId) => order.push(['confirm', num, groupId]),
      },
      exec: (cmd, args) => {
        if (cmd === 'git') return args[0] === 'diff' ? 'scripts/x.mjs\0' : '';
        if (args[0] === 'pr' && args[1] === 'comment') return '';
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'pr-1', headRefOid: head, baseRefName: 'main', labels: ['ready-to-merge'] });
        if (args.includes('--slurp')) return '[[]]';
        if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: order.some(o => o[0] === 'enqueue'), headRefOid: head } } } });
        if (args.includes('graphql')) {
          order.push(['enqueue', 1]);
          return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'entry-1', position: 1, state: 'QUEUED' } } } });
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });
    expect(drain.enqueue({ num: 1 }, head)).toEqual({ enqueued: true, already: false });
    expect(order).toEqual([['gate', 1], ['enqueue', 1], ['confirm', 1, 'reservation-1']]);
    expect(drain.enqueue({ num: 2 }, head)).toEqual({ enqueued: false, deferred: true, reason: 'group full' });
    expect(order).toEqual([['gate', 1], ['enqueue', 1], ['confirm', 1, 'reservation-1'], ['gate', 2]]);
    expect(stored.pending.map(p => p.num)).toEqual([1]);
  });
  it('reads PR node IDs for dequeue and reads the grouping strategy without mutations', () => {
    const h = ioHarness({ queue: [2] });
    expect(readQueueFacts({ repo: 'owner/repo', exec: h.exec })).toEqual({ inQueue: new Set([2]), entries: [{ id: 'pr-2', num: 2 }] });
    expect(readGroupingStrategy({ repo: 'owner/repo', rulesetId: 42, exec: h.exec })).toBe('HEADGREEN');
    expect(h.calls.some(c => c.includes('POST'))).toBe(false);
  });
  it('fails open on queue read errors and preserves state', () => {
    const h = ioHarness({ failQueue: true });
    expect(h.shell.gate(1).admit).toBe(true);
    expect(h.writes).toEqual([]);
    expect(h.logs.join('')).toContain('⚠');
    expect(h.shell.observe({}).error).toBeTruthy();
  });
  it('persists atomically and defers before the drain stamps clearance', () => {
    const h = ioHarness({ state: { ...empty(), groups: [group({ prs: [1, 2, 3] })] }, queue: [1, 2, 3] });
    expect(h.shell.gate(4).admit).toBe(false);
    expect(h.renames).toHaveLength(1);
    expect(h.renames[0][1]).toBe('test-state.json');
    const head = 'a'.repeat(40);
    const calls = [];
    const drain = createDrainMergeStrategy({
      resolved: { policy: { strategy: 'github-merge-queue', sources: {} }, note: null },
      localSlug: 'owner/repo', log: { write: () => {} }, batching: h.shell,
      readRedTeamEvidence: () => ({ loopPayload: null, inFlight: false, recorded: false }),
      readFile: () => JSON.stringify({ pending: [], followedUp: [] }),
      exec: (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, labels: ['ready-to-merge'] });
        if (cmd === 'gh' && args[0] === 'api' && args.includes('--slurp')) return '[[]]';
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });
    expect(drain.enqueue({ num: 4 }, head)).toEqual({ enqueued: false, deferred: true, reason: 'queue holds 1 group(s) (max 1)' });
    // Live admission reads the complete thread for recorded breaks before batching, even with no owed red team.
    // Deferral still makes no enqueue or clearance mutation.
    expect(calls).toEqual([
      ['gh', ['pr', 'view', '4', '--repo', 'owner/repo', '--json', 'headRefOid,labels,reviews']],
      ['gh', ['api', '--paginate', '--slurp', 'repos/owner/repo/issues/4/comments']],
    ]);
  });
  it('dry run performs neither state writes, dequeue, nor cancel', () => {
    const h = ioHarness({ dryRun: true, state: { ...empty(), groups: [group({ seen: [1, 2] })] }, queue: [2] });
    expect(h.shell.observe({}).events).toContainEqual({ type: 'dequeue', nums: [2] });
    expect(h.calls.some(c => c.some(a => a.includes('dequeuePullRequest')) || c.includes('POST'))).toBe(false);
    expect(h.writes).toEqual([]);
    const cancel = ioHarness({ dryRun: true, state: { ...empty(), groups: [group()] }, queue: [1, 2], runs: [1, 2].map(id => ({ id, event: 'merge_group', status: 'in_progress', head_branch: `gh-readonly-queue/main/pr-${id}-abc` })) });
    expect(cancel.shell.observe({}).cancelled).toEqual([]);
    expect(cancel.calls.some(c => c.includes('POST'))).toBe(false);
  });
  it('dequeues using PR IDs and keeps tips when native boundaries are unknown under either policy', () => {
    const h = ioHarness({ state: { ...empty(), groups: [group({ seen: [1, 2] })] }, queue: [2] });
    h.shell.observe({});
    expect(h.calls.some(c => c.includes('id=pr-2') && c.some(a => a.includes('dequeuePullRequest')))).toBe(true);
    const runs = [1, 2].map(id => ({ id, event: 'merge_group', status: 'in_progress', head_branch: `gh-readonly-queue/main/pr-${id}-abc` }));
    const cancel = ioHarness({ state: { ...empty(), groups: [group()] }, queue: [1, 2], runs });
    expect(cancel.shell.observe({}).cancelled).toEqual([]);
    expect(cancel.calls.some(c => c.includes('POST'))).toBe(false);
    expect(ioHarness({ state: { ...empty(), groups: [group()] }, queue: [1, 2], runs, strategy: 'ALLGREEN' }).shell.observe({}).cancelled).toEqual([]);
  });
  it('does not call batching in direct mode and observes after obsolete cancellation in queue mode', () => {
    const order = [];
    const make = strategy => createDrainMergeStrategy({ resolved: { policy: { strategy, sources: {} }, note: null }, log: { write: () => {} }, readFile: () => JSON.stringify({ pending: [] }), batching: { gate: () => { throw new Error('unused'); }, observe: () => order.push('batching') }, cancelObsoleteRuns: () => order.push('obsolete') });
    make('drain-direct').collectQueueMerged({ merged: [], landedThisPass: new Set() });
    expect(order).toEqual([]);
    make('github-merge-queue').collectQueueMerged({ merged: [], landedThisPass: new Set() });
    expect(order).toEqual(['obsolete', 'batching']);
  });
});

const replayRun = (num, ref, at, conclusion = 'success', duration = 10) => ({ databaseId: num, name: 'CI', conclusion, status: 'completed', headBranch: `gh-readonly-queue/main/pr-${num}-${ref}`, createdAt: new Date(at * minute).toISOString(), updatedAt: new Date((at + duration) * minute).toISOString() });
describe('batching replay', () => {
  it('measures overlapping obsolete refs and last-ref success', () => {
    const result = replayBatching({ runs: [replayRun(1, 'old', 0), replayRun(1, 'new', 1), replayRun(2, 'a', 2, 'cancelled')], settings: settings(), policy: 'HEADGREEN' });
    expect(result.baseline).toMatchObject({ fullRuns: 2, mergedPrs: 1, runsPerMergedPr: 2, obsoleteOverlapping: 1, createdCancelled: 1 });
    expect(result.ciMinutes).toBe(10);
  });
  it('projects both grouping policies with exact counts and isolates the failed arrival', () => {
    const runs = [replayRun(1, 'a', 0), replayRun(2, 'bad', 1, 'failure'), replayRun(3, 'a', 2), replayRun(2, 'fixed', 50)];
    const head = replayBatching({ runs, settings: settings({ failureThreshold: 2 }), policy: 'HEADGREEN', ciMinutes: 10 });
    expect(head.projected).toMatchObject({ fullRuns: 5, createdCancelled: 2, isolationRuns: 3, mergedPrs: 3, strictModeEpisodes: 1 });
    expect(head.failures[0]).toMatchObject({ num: 2, members: [1, 2, 3], culprit: 2 });
    const all = replayBatching({ runs, settings: settings({ failureThreshold: 2 }), policy: 'ALLGREEN', ciMinutes: 10 });
    expect(all.projected.fullRuns).toBe(7);
    expect(all.projected.createdCancelled).toBe(0);
  });
  it('handles empty input, forming timeout, and repeated runs on the same failed ref once', () => {
    expect(replayBatching({ runs: [], settings: settings(), policy: 'ALLGREEN' }).projected.fullRuns).toBe(0);
    const runs = [replayRun(1, 'bad', 0, 'failure'), replayRun(1, 'bad', 1, 'failure'), replayRun(1, 'fixed', 2)];
    const result = replayBatching({ runs, settings: settings(), policy: 'ALLGREEN', ciMinutes: 1 });
    expect(result.failures).toHaveLength(1);
    expect(result.projected).toMatchObject({ fullRuns: 2, mergedPrs: 1 });
  });
});

import { main as replayMain } from '../../merge-queue-batching-replay.mjs';

describe('replay CLI', () => {
  it('filters file input by workflow and since and prints matching JSON metrics', () => {
    const output = [];
    const runs = [replayRun(1, 'a', 0), replayRun(2, 'a', 10), { ...replayRun(3, 'a', 11), name: 'Other' }];
    const result = replayMain({ argv: ['--runs-file=fixture.json', '--since=1970-01-01T00:05:00Z', '--json'], settings: settings(), readFile: () => JSON.stringify(runs), exec: () => { throw new Error('file input must not fetch'); }, print: line => output.push(line) });
    expect(JSON.parse(output[0])).toEqual(result);
    expect(result.baseline.fullRuns).toBe(1);
    expect(result.projected.HEADGREEN.fullRuns).toBe(1);
  });
  it('fetches with the documented fields and formats failure times in Eastern time', () => {
    const calls = [], output = [];
    replayMain({ argv: ['--repo=owner/repo', '--workflow=CI', '--ci-minutes=2'], settings: settings(), exec: (cmd, args) => { calls.push([cmd, ...args]); return JSON.stringify([replayRun(1, 'bad', 0, 'failure')]); }, print: line => output.push(line) });
    expect(calls[0]).toEqual(expect.arrayContaining(['gh', 'run', 'list', '--repo', 'owner/repo', '--event', 'merge_group', '-L', '1000']));
    expect(output.join('\n')).toContain('12/31/69, 7:00 PM ET');
    expect(output.join('\n')).toContain('HEADGREEN');
  });
  it('rejects invalid dates, duration, and unsupported policies', () => {
    const common = { readFile: () => '[]', print: () => {} };
    expect(() => replayMain({ ...common, argv: ['--runs-file=x', '--since=wrong'] })).toThrow('--since');
    expect(() => replayMain({ ...common, argv: ['--runs-file=x', '--ci-minutes=0'] })).toThrow('ciMinutes');
    expect(() => replayBatching({ runs: [], policy: 'OTHER' })).toThrow('policy');
  });
});

describe('IO error boundaries', () => {
  it('keeps corrupt state untouched and fails open on gate write errors', () => {
    const h = ioHarness();
    const corrupt = createAdaptiveBatching({ repo: 'owner/repo', exec: h.exec, settings: settings(), readFile: () => '{', writeFile: () => { throw new Error('must not overwrite'); }, log: () => {} });
    expect(corrupt.gate(1)).toMatchObject({ admit: true, error: expect.any(String) });
    const cannotWrite = createAdaptiveBatching({ repo: 'owner/repo', exec: h.exec, statePath: 'state.json', settings: settings(), readFile: () => JSON.stringify(empty()), mkdir: () => {}, writeFile: () => { throw new Error('disk full'); }, log: () => {} });
    expect(cannotWrite.gate(1)).toMatchObject({ admit: true, error: 'disk full' });
  });
  it('confirms merges by PR view and does not treat failed lookups as ejection', () => {
    const h = ioHarness({ state: { ...empty(), groups: [group()] } });
    const shell = exec => createAdaptiveBatching({ repo: 'owner/repo', exec, statePath: 'state.json', settings: settings(), dryRun: true, readFile: () => JSON.stringify({ ...empty(), groups: [group()] }), log: () => {} });
    const confirmed = shell((cmd, args) => args[0] === 'pr' ? JSON.stringify({ state: 'MERGED' }) : h.exec(cmd, args));
    expect(confirmed.observe({}).events).toEqual([]);
    const unknown = shell((cmd, args) => { if (args[0] === 'pr') throw new Error('lookup failed'); return h.exec(cmd, args); });
    expect(unknown.observe({})).toMatchObject({ events: [], error: 'lookup failed' });
    expect(h.calls.some(c => c.some(a => a.includes('dequeuePullRequest')))).toBe(false);
  });
  it('rejects GraphQL error envelopes rather than interpreting them as empty queues', () => {
    expect(readQueueFacts({ repo: 'owner/repo', exec: () => JSON.stringify({ errors: [{ message: 'rate limited' }] }) }).error).toBe('rate limited');
    expect(readGroupingStrategy({ repo: 'owner/repo', rulesetId: 42, exec: () => '{}' })).toBeNull();
  });
});

describe('replay arrival recovery', () => {
  it('re-admits the next run after a failure even when it uses the same ref', () => {
    const result = replayBatching({ runs: [replayRun(1, 'same', 0, 'failure'), replayRun(1, 'same', 20)], settings: settings(), policy: 'ALLGREEN', ciMinutes: 1 });
    expect(result.failures).toHaveLength(1);
    expect(result.projected).toMatchObject({ fullRuns: 2, mergedPrs: 1 });
  });
  it('recovers two distinct culprit refs causally without overlapping the same PR', () => {
    const runs = [replayRun(1, 'bad1', 0, 'failure'), replayRun(2, 'good', 1), replayRun(1, 'bad2', 2, 'failure'), replayRun(1, 'fixed', 3)];
    const result = replayBatching({ runs, settings: settings({ groupSize: 2, failureThreshold: 99 }), policy: 'HEADGREEN', ciMinutes: 1 });
    expect(result.failures.map(f => f.ref)).toEqual(['gh-readonly-queue/main/pr-1-bad1', 'gh-readonly-queue/main/pr-1-bad2']);
    expect(result.projected).toMatchObject({ fullRuns: 5, mergedPrs: 2, isolationRuns: 2, createdCancelled: 1 });
  });
});
