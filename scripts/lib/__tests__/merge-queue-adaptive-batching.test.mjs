// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
    expect(declared.mergeQueueBatching).toEqual({ enabled: true, groupSize: 3 });
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
  it('drops an admitted PR whose enqueue never happened without failure or isolation, completing an empty group', () => {
    const admitted = admit(empty(), 1);
    expect(admitted.admit).toBe(true);
    expect(admitted.state.groups[0].seen ?? []).toEqual([]);
    const result = observe(freeze(admitted.state));
    expect(result.state.groups[0]).toMatchObject({ prs: [], seen: [], status: 'done', closedAtMs: minute });
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
  it('expires strict once, prunes old failures/done groups, and retains active/failed groups', () => {
    const nowMs = 25 * 60 * minute;
    const state = { ...empty(), strictUntilMs: nowMs, failures: [{ atMs: nowMs - 121 * minute }, { atMs: nowMs - 120 * minute }], groups: [group({ status: 'done' }), group({ id: 'recent', status: 'done', closedAtMs: nowMs }), group({ id: 'active', prs: [3] }), group({ id: 'failed', status: 'failed' })] };
    const result = observe(freeze(state), { nowMs, inQueue: new Set([3]) });
    expect(result.events).toEqual([{ type: 'strict-off' }]);
    expect(result.state.strictUntilMs).toBeNull();
    expect(result.state.failures).toHaveLength(1);
    expect(result.state.groups.map(g => g.id)).toEqual(['recent', 'active', 'failed']);
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
  const select = (opts = {}) => intermediateRunsToCancel({ groups: [group({ prs: [1, 2, 3] })], runs, groupingStrategy: 'HEADGREEN', settings: settings(), ...opts });
  it('auto cancels only non-last running merge_group refs under HEADGREEN', () => {
    expect(select()).toEqual([{ id: 10, num: 1, reason: 'headgreen-intermediate' }]);
    expect(select({ groupingStrategy: 'ALLGREEN' })).toEqual([]);
    expect(select({ groupingStrategy: null })).toEqual([]);
    expect(select({ settings: settings({ cancelIntermediateRuns: 'off' }) })).toEqual([]);
    expect(select({ groupingStrategy: 'ALLGREEN', settings: settings({ cancelIntermediateRuns: 'on' }) })).toHaveLength(1);
  });
  it('requires the last branch run and an active grouped stack', () => {
    expect(select({ runs: runs.filter(r => r.id !== 12) })).toEqual([]);
    expect(select({ groups: [group({ mode: 'isolate' })] })).toEqual([]);
    expect(select({ groups: [group({ status: 'failed' })] })).toEqual([]);
    expect(select({ groups: [group({ status: 'done' })] })).toEqual([]);
    expect(select({ groups: [group({ status: 'forming', prs: [1, 2, 3] })] })).toHaveLength(1);
  });
});

// C/D: injectable IO, drain seam, and deterministic replay.
import { createAdaptiveBatching, readQueueFacts, readGroupingStrategy, replayBatching } from '../merge-queue-adaptive-batching.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';

function ioHarness({ state = empty(), queue = [], dryRun = false, failQueue = false, strategy = 'HEADGREEN', runs = [] } = {}) {
  let stored = structuredClone(state);
  const calls = [], logs = [], writes = [], renames = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.includes('graphql')) {
      if (args.some(a => a.includes('dequeuePullRequest'))) return JSON.stringify({ data: { dequeuePullRequest: { mergeQueueEntry: { id: 'e' } } } });
      if (failQueue) throw new Error('queue unavailable');
      return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: queue.map(num => ({ id: `entry-${num}`, pullRequest: { id: `pr-${num}`, number: num } })) } } } } });
    }
    if (args[0] === 'pr') return JSON.stringify({ state: 'OPEN' });
    if (args.some(a => a.includes('/rulesets/'))) return JSON.stringify({ rules: [{ type: 'merge_queue', parameters: { grouping_strategy: strategy } }] });
    if (args.some(a => a.includes('/actions/runs?'))) return JSON.stringify({ workflow_runs: runs });
    if (args.includes('POST')) return '';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const shell = createAdaptiveBatching({ repo: 'owner/repo', exec, statePath: 'test-state.json', settings: resolveBatchingSettings({ env: {}, settings: { mergeQueueBatching: { enabled: true } }, platform: {} }), dryRun,
    nowMs: () => minute, readFile: () => JSON.stringify(stored), writeFile: (path, value) => { writes.push(path); stored = JSON.parse(value); }, rename: (from, to) => renames.push([from, to]), mkdir: () => {}, log: line => logs.push(line) });
  return { shell, exec, calls, logs, writes, renames, state: () => stored };
}

describe('batching IO shell and drain hook', () => {
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
      readFile: () => JSON.stringify(stored), writeState: (_path, state) => { stored = structuredClone(state); },
      batching: {
        gate: num => { order.push(['gate', num]); return num === 1 ? { admit: true } : { admit: false, reason: 'group full' }; },
        confirm: num => order.push(['confirm', num]),
      },
      exec: (cmd, args) => {
        if (cmd === 'git') return args[0] === 'diff' ? 'scripts/x.mjs\0' : '';
        if (args[0] === 'pr' && args[1] === 'comment') return '';
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'pr-1', headRefOid: head, baseRefName: 'main' });
        if (args.includes('graphql')) {
          order.push(['enqueue', 1]);
          return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'entry-1', position: 1, state: 'QUEUED' } } } });
        }
        throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
      },
    });
    expect(drain.enqueue({ num: 1 }, head)).toEqual({ enqueued: true, already: false });
    expect(order).toEqual([['gate', 1], ['enqueue', 1], ['confirm', 1]]);
    expect(drain.enqueue({ num: 2 }, head)).toMatchObject({ enqueued: false, deferred: true });
    expect(order).toEqual([['gate', 1], ['enqueue', 1], ['confirm', 1], ['gate', 2]]);
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
    const calls = [];
    const drain = createDrainMergeStrategy({ resolved: { policy: { strategy: 'github-merge-queue', sources: {} }, note: null }, log: { write: () => {} }, batching: h.shell, exec: (...args) => calls.push(args) });
    expect(drain.enqueue({ num: 4 }, 'a'.repeat(40))).toMatchObject({ enqueued: false, deferred: true });
    expect(calls).toEqual([]);
  });
  it('dry run performs neither state writes, dequeue, nor cancel', () => {
    const h = ioHarness({ dryRun: true, state: { ...empty(), groups: [group({ seen: [1, 2] })] }, queue: [2] });
    expect(h.shell.observe({}).events).toContainEqual({ type: 'dequeue', nums: [2] });
    expect(h.calls.some(c => c.some(a => a.includes('dequeuePullRequest')) || c.includes('POST'))).toBe(false);
    expect(h.writes).toEqual([]);
    const cancel = ioHarness({ dryRun: true, state: { ...empty(), groups: [group()] }, queue: [1, 2], runs: [1, 2].map(id => ({ id, event: 'merge_group', status: 'in_progress', head_branch: `gh-readonly-queue/main/pr-${id}-abc` })) });
    expect(cancel.shell.observe({}).cancelled).toEqual([1]);
    expect(cancel.calls.some(c => c.includes('POST'))).toBe(false);
  });
  it('dequeues using PR IDs, cancels intermediates, and leaves ALLGREEN runs intact', () => {
    const h = ioHarness({ state: { ...empty(), groups: [group({ seen: [1, 2] })] }, queue: [2] });
    h.shell.observe({});
    expect(h.calls.some(c => c.includes('id=pr-2') && c.some(a => a.includes('dequeuePullRequest')))).toBe(true);
    const runs = [1, 2].map(id => ({ id, event: 'merge_group', status: 'in_progress', head_branch: `gh-readonly-queue/main/pr-${id}-abc` }));
    const cancel = ioHarness({ state: { ...empty(), groups: [group()] }, queue: [1, 2], runs });
    expect(cancel.shell.observe({}).cancelled).toEqual([1]);
    expect(cancel.calls.some(c => c.includes('POST'))).toBe(true);
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
