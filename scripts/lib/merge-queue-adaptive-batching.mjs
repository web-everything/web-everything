/** Drain-side enqueue policy. Settings loading is separate from the pure, clock-injected core.
 * The GitHub IO shell and drain integration are intentionally deferred to a later implementation. */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { readDeclaredSettings } from './settings-files.mjs';
import { PLATFORM_PREFERENCES_PATH } from './merge-delivery-policy.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { withPathLock } from '../readiness/with-lock.mjs';

export const STANDARD_BATCHING_SETTINGS = Object.freeze({
  enabled: false,
  groupSize: 3,
  groupFormMinutes: 5,
  maxGroupsInFlight: 1,
  failureThreshold: 3,
  failureWindowMinutes: 120,
  strictModeMinutes: 60,
  isolateTimeoutMinutes: 60,
  soleSurvivorCulprit: true,
  cancelIntermediateRuns: 'auto',
  rulesetId: 24883772,
});

const ENV_KEYS = Object.freeze({
  enabled: 'WE_MQ_BATCHING_ENABLED',
  groupSize: 'WE_MQ_BATCHING_GROUP_SIZE',
  groupFormMinutes: 'WE_MQ_BATCHING_GROUP_FORM_MINUTES',
  maxGroupsInFlight: 'WE_MQ_BATCHING_MAX_GROUPS_IN_FLIGHT',
  failureThreshold: 'WE_MQ_BATCHING_FAILURE_THRESHOLD',
  failureWindowMinutes: 'WE_MQ_BATCHING_FAILURE_WINDOW_MINUTES',
  strictModeMinutes: 'WE_MQ_BATCHING_STRICT_MODE_MINUTES',
  isolateTimeoutMinutes: 'WE_MQ_BATCHING_ISOLATE_TIMEOUT_MINUTES',
  soleSurvivorCulprit: 'WE_MQ_BATCHING_SOLE_SURVIVOR_CULPRIT',
  cancelIntermediateRuns: 'WE_MQ_BATCHING_CANCEL_INTERMEDIATE_RUNS',
  rulesetId: 'WE_MQ_BATCHING_RULESET_ID',
});
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const ADMISSION_GRACE_MS = 5 * MINUTE_MS;
const active = (g) => g.status === 'forming' || g.status === 'queued';

/** Settings IO only: a missing/unreadable platform file contributes no overrides. */
function readPlatformSettings() {
  try { return JSON.parse(readFileSync(PLATFORM_PREFERENCES_PATH, 'utf8')); }
  catch { return {}; }
}

function envValue(key, value) {
  if (key === 'enabled' || key === 'soleSurvivorCulprit') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    return value;
  }
  if (key === 'cancelIntermediateRuns') return value;
  // Reject empty strings, fractions, exponents and boolean coercion.
  return typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
}

function validValue(key, value) {
  if (key === 'enabled' || key === 'soleSurvivorCulprit') return typeof value === 'boolean';
  if (key === 'cancelIntermediateRuns') return ['auto', 'on', 'off'].includes(value);
  if (!Number.isSafeInteger(value)) return false;
  if (key === 'rulesetId') return true;
  if (key === 'groupSize') return value >= 1 && value <= 5;
  return value >= (key === 'groupFormMinutes' ? 0 : 1);
}

/** Resolve per-key env > repo > platform > standard. Inject full settings objects
 * with a mergeQueueBatching block; only omitted objects are loaded from disk.
 * Under VITEST/WE_UNDER_TEST an omitted repo layer is empty. No caller input is mutated.
 * @returns {object} Effective values, sources for every key, and invalid layer.key entries.
 */
export function resolveBatchingSettings({ env = process.env, settings, platform } = {}) {
  const repo = settings === undefined
    ? (env.VITEST || env.WE_UNDER_TEST ? {} : readDeclaredSettings().settings)
    : settings;
  const platformSettings = platform === undefined ? readPlatformSettings() : platform;
  const values = { ...STANDARD_BATCHING_SETTINGS };
  const sources = Object.fromEntries(Object.keys(values).map(key => [key, 'standard']));
  const invalid = [];
  const envSettings = {};
  for (const [key, name] of Object.entries(ENV_KEYS)) {
    if (env[name] !== undefined) envSettings[key] = envValue(key, env[name]);
  }
  for (const [layer, block] of [
    ['platform', platformSettings?.mergeQueueBatching],
    ['repo', repo?.mergeQueueBatching],
    ['env', envSettings],
  ]) {
    for (const key of Object.keys(values)) {
      if (!block || !Object.hasOwn(block, key)) continue;
      if (!validValue(key, block[key])) { invalid.push(`${layer}.${key}`); continue; }
      values[key] = block[key];
      sources[key] = layer;
    }
  }
  return { ...values, sources, invalid };
}

/** One log line naming every effective value and its winning layer. */
export function formatBatchingSettings(s) {
  return `merge-queue batching settings: ${Object.keys(STANDARD_BATCHING_SETTINGS)
    .map(key => `${key}=${s[key]} (${s.sources[key]})`).join(', ')}`;
}

/** Coordination path for the future shell; resolving a path does not read or write state. */
export function batchingStatePath(env = process.env) {
  return join(resolveCoordinationRoot({ env }), 'drain-merge-queue-batching.json');
}

/** @typedef {{id:string, prs:number[], openedAtMs:number, closedAtMs:number|null,
 * mode:'grouped'|'isolate'|'strict', status:'forming'|'queued'|'done'|'failed',
 * recoveryRetired?:number[]}} BatchingGroup
 * @typedef {{groups:BatchingGroup[], isolate:number[], failures:Array<{atMs:number,groupId:string,prs:number[]}>,
 * culprits:Array<{num:number,atMs:number}>, strictUntilMs:number|null,
 * pendingDequeues?:number[]}} BatchingState
 */

// Pure policy core: no IO or ambient clock. State is JSON and every transition copies it.
/** @returns {BatchingState} A fresh initial state for persistence/replay callers. */
export function initialBatchingState() {
  return { groups: [], isolate: [], failures: [], culprits: [], strictUntilMs: null };
}

// Per-member deadlines cannot be extended by later failures. Old persisted states
// get one bounded recovery window on their first read after upgrading.
function expireIsolation(state, nowMs, settings, closed = new Set(), merged = new Set()) {
  if (!state.isolate.length && !state.isolateSinceMs) return;
  state.isolateSinceMs ??= {};
  for (const num of state.isolate) state.isolateSinceMs[num] ??= nowMs;
  state.isolate = state.isolate.filter(num => !closed.has(num) && !merged.has(num)
    && nowMs - state.isolateSinceMs[num] < (settings.isolateTimeoutMinutes ?? 60) * MINUTE_MS);
  for (const num of Object.keys(state.isolateSinceMs)) {
    if (!state.isolate.includes(Number(num))) delete state.isolateSinceMs[num];
  }
}

// Upgrade persisted singleton recovery using the caller's fresh queue snapshot.
function healSoleSurvivors(state, inQueue, nowMs, settings) {
  if (settings.soleSurvivorCulprit === false) return;
  state.isolate = state.isolate.filter(num => {
    if (inQueue.has(num) || !state.groups.some(g => g.status === 'failed'
      && g.recoveryRetired?.length === 1 && g.recoveryRetired[0] === num)) return true;
    if (!state.culprits.some(c => c.num === num)) state.culprits.push({ num, atMs: nowMs });
    if (state.isolateSinceMs) delete state.isolateSinceMs[num];
    return false;
  });
}

/** PURE: strict overrides isolation until its injected deadline passes. */
export function currentMode(state, nowMs, settings) {
  if (!settings.enabled) return 'off';
  if (state.strictUntilMs > nowMs) return 'strict';
  if (state.isolate.length) return 'isolate';
  return 'grouped';
}

function closeGroup(g, nowMs) {
  g.status = 'queued';
  g.closedAtMs = nowMs;
}

function openGroup(state, num, nowMs, mode, size) {
  const base = `${mode}-${nowMs}-${num}`;
  let id = base;
  let suffix = 1;
  while (state.groups.some(g => g.id === id)) id = `${base}-${suffix++}`;
  const g = { id, prs: [num], openedAtMs: nowMs, closedAtMs: null, mode, status: 'forming', pendingUntilMs: { [num]: nowMs + ADMISSION_GRACE_MS } };
  if (size === 1) closeGroup(g, nowMs);
  state.groups.push(g);
  return g;
}

/** PURE: decide enqueue admission and return a fresh JSON state, including on deferral.
 * A full group closes immediately; a timed-out forming group closes on the next admission.
 * Retrying an already admitted PR reuses its group rather than consuming another slot.
 * @param {{state:BatchingState,num:number,nowMs:number,settings:object,inQueue:Set<number>}} input
 * @returns {{admit:boolean,mode:string,groupId:string|null,reason:string|null,state:BatchingState}}
 */
export function admitEnqueue({ state: input, num, nowMs, settings, inQueue }) {
  const state = structuredClone(input);
  if (settings.enabled) {
    healSoleSurvivors(state, inQueue, nowMs, settings);
    expireIsolation(state, nowMs, settings);
  }
  const mode = currentMode(state, nowMs, settings);
  const result = (admit, groupId = null, reason = null) => ({ admit, mode, groupId, reason, state });
  if (mode === 'off') return result(true);
  // A fresh queue snapshot acknowledges absent recovery entries before a new
  // reservation can reuse the PR number. Never dequeue that replacement later.
  state.pendingDequeues = (state.pendingDequeues ?? []).filter(n => inQueue.has(n));
  if ((state.pendingDequeues ?? []).some(n => inQueue.has(n))
    || state.groups.some(g => g.recoveryRetired?.some(n => inQueue.has(n)
      && !state.groups.some(other => active(other) && other.prs.includes(n))))) {
    return result(false, null, 'recovery dequeues are still outstanding');
  }
  if (mode === 'isolate') {
    if (!state.isolate.includes(num)) return result(false, null, `isolating culprit among ${state.isolate.map(n => `#${n}`).join(',')}`);
    if (state.isolate.some(n => n !== num && inQueue.has(n))) return result(false, null, 'another isolate PR is in queue');
  }
  // A seen member absent from the queue may have exited. Enqueueing into its group
  // before observation would hide that exit or blame the newcomer for it.
  const unobservedExit = g => (g.seen ?? []).some(n => !inQueue.has(n));
  const existing = state.groups.find(g => active(g) && g.prs.includes(num));
  if (existing && !inQueue.has(num) && unobservedExit(existing)) {
    return result(false, null, `#${(existing.seen ?? []).find(n => !inQueue.has(n))} left the queue; observe its exit before re-enqueue`);
  }
  if (existing) return result(true, existing.id);
  // A PR already in the native queue needs no new admission/group record.
  if (inQueue.has(num)) return result(true);
  if (mode === 'isolate') return result(true, openGroup(state, num, nowMs, mode, 1).id);

  for (const g of state.groups.filter(g => g.status === 'forming')) {
    if (mode === 'grouped' && g.mode === 'grouped' && g.prs.length < settings.groupSize
      && nowMs - g.openedAtMs <= settings.groupFormMinutes * MINUTE_MS && !unobservedExit(g)) {
      g.prs.push(num);
      g.pendingUntilMs ??= {};
      g.pendingUntilMs[num] = nowMs + ADMISSION_GRACE_MS;
      if (g.prs.length === settings.groupSize) closeGroup(g, nowMs);
      return result(true, g.id);
    }
    closeGroup(g, nowMs);
  }
  const count = state.groups.filter(active).length;
  if (count >= settings.maxGroupsInFlight) return result(false, null, `queue holds ${count} group(s) (max ${settings.maxGroupsInFlight})`);
  return result(true, openGroup(state, num, nowMs, mode, mode === 'strict' ? 1 : settings.groupSize).id);
}

// Fail a group whose seen member(s) left the queue unmerged. Shared by observation
// and by a confirmation that proves an exit happened between gate and enqueue.
function recordQueueExit({ state, g, ejected, inQueue, merged, closed, nowMs, settings }) {
  const events = [];
  g.status = 'failed';
  g.failedAtMs = nowMs;
  state.failures.push({ atMs: nowMs, groupId: g.id, prs: [...g.prs] });
  if (g.mode === 'grouped' && g.prs.length > 1) {
    const nums = g.prs.filter(n => !merged.has(n) && !closed.has(n));
    const soleCulprit = settings.soleSurvivorCulprit !== false && nums.length === 1;
    if (soleCulprit) {
      const [num] = nums;
      if (!state.culprits.some(c => c.num === num)) state.culprits.push({ num, atMs: nowMs });
      state.isolate = state.isolate.filter(n => n !== num);
      if (state.isolateSinceMs) delete state.isolateSinceMs[num];
      events.push({ type: 'culprit', num });
    } else {
      state.isolate = [...new Set([...state.isolate, ...nums])];
      state.isolateSinceMs ??= {};
      for (const num of nums) state.isolateSinceMs[num] ??= nowMs;
    }
    g.recoveryRetired = soleCulprit ? nums.filter(n => inQueue.has(n)) : [...nums];
    state.pendingDequeues = [...new Set([...(state.pendingDequeues ?? []), ...nums.filter(n => inQueue.has(n))])];
    events.push({ type: 'dequeue', nums: nums.filter(n => inQueue.has(n)) });
    if (!soleCulprit) events.push({ type: 'isolate', nums });
  } else {
    for (const num of ejected) {
      state.culprits.push({ num, atMs: nowMs });
      state.isolate = state.isolate.filter(n => n !== num);
      events.push({ type: 'culprit', num });
    }
  }
  if (state.failures.length >= settings.failureThreshold && !(state.strictUntilMs > nowMs)) {
    state.strictUntilMs = nowMs + settings.strictModeMinutes * MINUTE_MS;
    events.push({ type: 'strict-on', untilMs: state.strictUntilMs });
  }
  return events;
}

/** PURE: reconcile queue membership and confirmed merges; emit effects for a future IO shell.
 * Failed groups are terminal, so a repeated snapshot cannot record another failure.
 * Done-group retention starts at completion (closedAtMs is updated on completion).
 * @param {{state:BatchingState,inQueue:Set<number>,merged:Set<number>,nowMs:number,settings:object}} input
 * @returns {{state:BatchingState,events:object[]}}
 */
export function observeQueue({ state: input, inQueue, merged, closed = new Set(), nowMs, settings }) {
  const state = structuredClone(input);
  const events = [];
  if (state.strictUntilMs !== null && state.strictUntilMs <= nowMs) {
    state.strictUntilMs = null;
    events.push({ type: 'strict-off' });
  }
  const cutoff = nowMs - settings.failureWindowMinutes * MINUTE_MS;
  state.failures = state.failures.filter(f => f.atMs >= cutoff);
  healSoleSurvivors(state, inQueue, nowMs, settings);
  expireIsolation(state, nowMs, settings, closed, merged);
  // Recovery effects survive terminal-group pruning and isolation expiry. Queue
  // absence also acknowledges a dequeue whose response/persistence was lost.
  const lateRecovery = state.groups.flatMap(g => g.recoveryRetired ?? []).filter(n =>
    !state.groups.some(other => active(other) && other.prs.includes(n)));
  const pendingDequeues = [...new Set([...(state.pendingDequeues ?? []), ...lateRecovery])]
    .filter(n => inQueue.has(n) && !merged.has(n) && !closed.has(n));
  if (state.pendingDequeues || pendingDequeues.length) state.pendingDequeues = pendingDequeues;
  if (pendingDequeues.length) events.push({ type: 'dequeue', nums: pendingDequeues });
  for (const g of state.groups) {
    if (g.status === 'done') continue;
    if (g.prs.every(n => merged.has(n))) {
      g.status = 'done';
      g.closedAtMs = nowMs;
      continue;
    }
    if (g.status === 'failed') continue;
    // Only a PR known to have ENTERED the queue (seen there, or confirmed by a successful enqueue) can be
    // ejected. An admitted PR whose enqueue never happened (refused, crashed) just leaves the group and is
    // re-admitted on a later pass — it is not a group failure.
    g.seen = [...new Set([...(g.seen ?? []), ...g.prs.filter(n => inQueue.has(n) || merged.has(n))])];
    g.prs = g.prs.filter(n => g.seen.includes(n) || (!closed.has(n) && g.pendingUntilMs?.[n] > nowMs));
    if (!g.prs.length) { g.status = 'done'; g.closedAtMs = nowMs; continue; }
    if (g.prs.every(n => merged.has(n))) { g.status = 'done'; g.closedAtMs = nowMs; continue; }
    const ejected = g.prs.filter(n => g.seen.includes(n) && !inQueue.has(n) && !merged.has(n));
    if (!ejected.length) continue;
    events.push(...recordQueueExit({ state, g, ejected, inQueue, merged, closed, nowMs, settings }));
  }
  expireIsolation(state, nowMs, settings, closed, merged);
  state.groups = state.groups.filter(g => g.status === 'failed'
    ? g.recoveryRetired?.some(n => state.pendingDequeues?.includes(n))
      || (g.failedAtMs ?? g.closedAtMs ?? g.openedAtMs) >= cutoff
    : g.status !== 'done' || (g.closedAtMs ?? g.openedAtMs) >= nowMs - DAY_MS);
  state.culprits = state.culprits.filter(c => c.atMs >= cutoff);
  return { state, events };
}

/** PURE: select active intermediate merge_group runs only when the final branch has a run.
 * No GitHub calls or cancellations occur here. ALLGREEN is preserved by auto mode.
 * @returns {Array<{id:number,num:number,reason:string}>}
 */
export function intermediateRunsToCancel({ nativeGroups = [], runs, groupingStrategy, settings }) {
  if (settings.cancelIntermediateRuns !== 'on'
    && !(settings.cancelIntermediateRuns === 'auto' && groupingStrategy === 'HEADGREEN')) return [];
  const queueRuns = runs.filter(r => r.event === 'merge_group').map(r => ({
    run: r,
    num: Number(/^gh-readonly-queue\/main\/pr-(\d+)-/.exec(r.head_branch ?? '')?.[1]),
  }));
  const selected = new Map();
  // Admission counters and queue positions do not prove native group boundaries.
  // Callers must provide authoritative membership and tip; today's queue reader
  // cannot do so, therefore the production shell conservatively keeps all runs.
  for (const g of nativeGroups) {
    if (g.prs.length < 2 || !g.prs.includes(g.tip)) continue;
    const last = g.tip;
    if (!queueRuns.some(r => r.num === last)) continue;
    for (const { run, num } of queueRuns) {
      if (run.status !== 'completed' && num !== last && g.prs.includes(num)) {
        selected.set(run.id, { id: run.id, num, reason: 'headgreen-intermediate' });
      }
    }
  }
  return [...selected.values()];
}

// IO shell: synchronous injected GitHub/filesystem calls, best-effort and fail-open.
const ioOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const errorText = e => String(e?.message ?? e).split('\n')[0];
export function graphql(exec, query, fields = []) {
  const response = JSON.parse(exec('gh', ['api', 'graphql', '-f', `query=${query}`, ...fields.flatMap(f => ['-f', f])], ioOptions));
  if (response.errors?.length) throw new Error(response.errors.map(e => e.message).join('; '));
  if (!response.data) throw new Error('missing GraphQL data');
  return response.data;
}

/** Read queue membership. `id` is the PR node ID required by dequeuePullRequest. */
export function readQueueFacts({ repo, exec = execFileSync }) {
  try {
    const [owner, name] = repo.split('/');
    const data = graphql(exec, 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){mergeQueue(branch:"main"){entries(first:100){pageInfo{hasNextPage} nodes{id state pullRequest{id number headRefName headRefOid}}}}}}', [`owner=${owner}`, `name=${name}`]);
    const nodes = data.repository?.mergeQueue?.entries?.nodes;
    if (!Array.isArray(nodes)) throw new Error('unreadable merge queue');
    // A partial page would make queued PRs look ejected.
    if (data.repository.mergeQueue.entries.pageInfo?.hasNextPage) throw new Error('merge queue has more than 100 entries');
    const entries = nodes.map(n => {
      if (!n.pullRequest?.id || !Number.isInteger(n.pullRequest.number)) throw new Error('invalid merge queue entry');
      return { id: n.pullRequest.id, num: n.pullRequest.number };
    });
    return { inQueue: new Set(entries.map(e => e.num)), entries };
  } catch (e) { return { inQueue: new Set(), entries: [], error: errorText(e) }; }
}

/** Read-only ruleset inspection; unknown strategy never authorizes auto cancellation. */
export function readGroupingStrategy({ repo, rulesetId, exec = execFileSync }) {
  try {
    const ruleset = JSON.parse(exec('gh', ['api', `repos/${repo}/rulesets/${rulesetId}`], ioOptions));
    const strategy = ruleset.rules?.find(r => r.type === 'merge_queue')?.parameters?.grouping_strategy;
    return ['ALLGREEN', 'HEADGREEN'].includes(strategy) ? strategy : null;
  } catch { return null; }
}

/** Best-effort IO facade. Re-reads durable state on each operation; dry runs use an
 * in-memory snapshot and perform no writes or GitHub mutations. Unknown PR states
 * abort reconciliation rather than falsely identifying an ejection.
 */
export function createAdaptiveBatching({ repo, exec = execFileSync, statePath = batchingStatePath(),
  log = line => process.stderr.write(`${line}\n`), settings = resolveBatchingSettings(), dryRun = false,
  readFile = readFileSync, writeFile = writeFileSync, rename = renameSync, mkdir = mkdirSync, nowMs = Date.now,
  withLock = withPathLock,
} = {}) {
  let previewState;
  const say = line => { try { typeof log === 'function' ? log(line) : log.write(`${line}\n`); } catch { /* logging must not stop the drain */ } };
  const warn = e => say(`merge-queue batching: ⚠ ${errorText(e)} — continuing drain pass`);
  const load = () => {
    if (dryRun && previewState) return structuredClone(previewState);
    try {
      const state = JSON.parse(readFile(statePath, 'utf8'));
      if (!['groups', 'isolate', 'failures', 'culprits'].every(k => Array.isArray(state[k]))
        || !(state.strictUntilMs === null || Number.isFinite(state.strictUntilMs))) throw new Error('unreadable batching state');
      return state;
    } catch (e) { if (e.code === 'ENOENT') return initialBatchingState(); throw e; }
  };
  const persist = state => {
    if (dryRun) { previewState = structuredClone(state); return; }
    mkdir(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    rename(tmp, statePath);
  };
  // Coordination is local to one host. Reclaim proven dead owners, never a
  // live/unknown holder merely because time passed: an expired writer can resume.
  // Contention is bounded by the primitive's 5s timeout and retries next pass.
  const transaction = fn => dryRun || !settings.enabled ? fn() : withLock(statePath, fn, { leaseMinutes: Infinity });
  const api = {
    /** Record that `num` really entered GitHub's queue (enqueue succeeded), so a fast ejection counts. */
    confirm(num, groupId, { already } = {}) {
      if (!settings.enabled) return;
      try {
        const state = load();
        const seenLive = state.groups.find(g => active(g) && g.seen?.includes(num));
        // A fresh enqueue of a PR already seen in the queue proves it left between
        // gate and enqueue. Record that exit; the code below then recovers the PR.
        const exitRecorded = already === false && !!seenLive && (groupId == null || seenLive.id === groupId);
        if (exitRecorded) {
          recordQueueExit({ state, g: seenLive, ejected: [num], inQueue: new Set(), merged: new Set(), closed: new Set(), nowMs: nowMs(), settings });
        }
        const reservation = groupId == null ? null : state.groups.find(g => g.id === groupId);
        const live = state.groups.find(g => active(g) && g.prs.includes(num));
        // An old enqueue cannot confirm a replacement reservation. If its
        // history aged out, recover the late arrival rather than invent a test.
        if (groupId != null && live && live.id !== groupId) return;
        if (groupId != null && !reservation) {
          state.pendingDequeues = [...new Set([...(state.pendingDequeues ?? []), num])];
          persist(state);
          return;
        }
        if (reservation?.status === 'failed') {
          state.pendingDequeues = [...new Set([...(state.pendingDequeues ?? []), num])];
          persist(state);
          return;
        }
        if (!state.groups.some(g => active(g) && g.prs.includes(num))) {
          // Recovery deliberately retired this reservation. A delayed enqueue
          // confirmation is not evidence of an isolated test. A fresh gate
          // creates a distinct group when it makes a new reservation.
          if (state.groups.some(g => g.recoveryRetired?.includes(num))) { if (exitRecorded) persist(state); return; }
          // An enqueue can finish after its reservation grace expired. Keep a
          // singleton record so even that late confirmation remains observable.
          openGroup(state, num, nowMs(), currentMode(state, nowMs(), settings), 1);
        }
        for (const g of state.groups) if (g.prs.includes(num) && active(g)) g.seen = [...new Set([...(g.seen ?? []), num])];
        persist(state);
      } catch (e) { warn(e); }
    },
    gate(num) {
      if (!settings.enabled) return { admit: true };
      try {
        const facts = readQueueFacts({ repo, exec });
        if (facts.error) {
          // Fail open, except for a PR seen in the queue: it may have been ejected.
          if (load().groups.some(g => active(g) && g.seen?.includes(num))) {
            warn(facts.error);
            return { admit: false, reason: `#${num} was seen in the queue; queue unreadable`, error: facts.error };
          }
          throw new Error(facts.error);
        }
        const result = admitEnqueue({ state: load(), num, nowMs: nowMs(), settings, inQueue: facts.inQueue });
        persist(result.state);
        const g = result.state.groups.find(g => g.id === result.groupId);
        say(`merge-queue batching: ${result.mode} → ${result.admit
          ? `admit #${num} into group ${result.groupId ?? 'native-queue'} (${g?.prs.length ?? 1}/${result.mode === 'grouped' ? settings.groupSize : 1})`
          : `defer #${num} (${result.reason})`}`);
        return result;
      } catch (e) { warn(e); return { admit: true, error: errorText(e) }; }
    },
    observe({ mergedNums = [] } = {}) {
      const summary = { events: [], dequeued: [], cancelled: [] };
      try {
        // Settings are resolved with sources in production; accept plain values in injected harnesses.
        say(formatBatchingSettings({ ...settings, sources: settings.sources ?? Object.fromEntries(Object.keys(STANDARD_BATCHING_SETTINGS).map(k => [k, 'injected'])) }));
        if (!settings.enabled) return summary;
        const facts = readQueueFacts({ repo, exec });
        if (facts.error) throw new Error(facts.error);
        const state = load();
        const merged = new Set(mergedNums);
        const closed = new Set();
        expireIsolation(state, nowMs(), settings);
        const missing = new Set([...state.groups.filter(active).flatMap(g => g.prs), ...state.isolate].filter(n => !facts.inQueue.has(n) && !merged.has(n)));
        for (const num of missing) {
          const pr = JSON.parse(exec('gh', ['pr', 'view', String(num), '--repo', repo, '--json', 'state,isDraft'], ioOptions));
          if (!['MERGED', 'OPEN', 'CLOSED'].includes(pr.state)) throw new Error(`unknown state for #${num}`);
          if (pr.state === 'MERGED') merged.add(num);
          if (pr.state === 'CLOSED' || pr.isDraft) closed.add(num);
        }
        const result = observeQueue({ state, inQueue: facts.inQueue, merged, closed, nowMs: nowMs(), settings });
        persist(result.state);
        summary.events = result.events;
        for (const event of result.events) {
          if (event.type === 'dequeue') {
            for (const num of event.nums) {
              try {
                say(`merge-queue batching: ${dryRun ? 'would dequeue' : 'dequeue'} #${num} for isolation`);
                if (!dryRun) {
                  const id = facts.entries.find(e => e.num === num)?.id;
                  if (!id) throw new Error(`missing queue PR ID for #${num}`);
                  const data = graphql(exec, 'mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{id}}}', [`id=${id}`]);
                  if (!data.dequeuePullRequest) throw new Error(`dequeue #${num} returned no result`);
                }
                summary.dequeued.push(num);
                if (!dryRun) {
                  result.state.pendingDequeues = result.state.pendingDequeues.filter(n => n !== num);
                  persist(result.state);
                }
              } catch (e) { warn(e); }
            }
          } else if (event.type === 'isolate') say(`merge-queue batching: isolate ${event.nums.map(n => `#${n}`).join(',')}`);
          else if (event.type === 'culprit') say(`merge-queue batching: culprit #${event.num} — existing fixer owns recovery`);
          else say(`merge-queue batching: ${event.type}${event.untilMs ? ` until ${new Date(event.untilMs).toISOString()}` : ''}`);
        }
        const strategy = readGroupingStrategy({ repo, rulesetId: settings.rulesetId, exec });
        if (settings.cancelIntermediateRuns === 'on' || (settings.cancelIntermediateRuns === 'auto' && strategy === 'HEADGREEN')) {
          const runs = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs?event=merge_group&status=in_progress&per_page=100`], ioOptions)).workflow_runs;
          if (!Array.isArray(runs)) throw new Error('unreadable workflow runs');
          for (const run of intermediateRunsToCancel({ groups: result.state.groups, runs, groupingStrategy: strategy, settings })) {
            try {
              say(`merge-queue batching: ${dryRun ? 'would cancel' : 'cancel'} run ${run.id} for #${run.num} (${run.reason})`);
              if (!dryRun) exec('gh', ['api', '--method', 'POST', `repos/${repo}/actions/runs/${run.id}/cancel`], ioOptions);
              summary.cancelled.push(run.id);
            } catch (e) { warn(e); }
          }
        }
      } catch (e) { warn(e); summary.error = errorText(e); }
      return summary;
    },
  };
  return Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (...args) => {
    try { return transaction(() => fn(...args)); }
    catch (e) {
      warn(e);
      if (name === 'gate') return { admit: false, reason: errorText(e), error: errorText(e) };
      if (name === 'observe') return { events: [], dequeued: [], cancelled: [], error: errorText(e) };
    }
  }]));
}

// Replay: pure discrete-event simulation driven only by measured arrival timestamps.
const queueNum = branch => Number(/^gh-readonly-queue\/main\/pr-(\d+)-/.exec(branch ?? '')?.[1]);
const metrics = () => ({ fullRuns: 0, mergedPrs: 0, runsPerMergedPr: 0, createdCancelled: 0, isolationRuns: 0, strictModeEpisodes: 0, failures: 0 });

/** PURE: measure historical CI and simulate enqueue policy. Failed distinct refs
 * create culprit arrivals; the next measured run becomes eligible only after that
 * culprit has failed alone. Intermediate rebuilds contribute zero full runs.
 * CI starts when a group fills or its formation deadline expires.
 */
export function replayBatching({ runs, settings = STANDARD_BATCHING_SETTINGS, policy = 'ALLGREEN', ciMinutes } = {}) {
  if (!['ALLGREEN', 'HEADGREEN'].includes(policy)) throw new Error('policy must be ALLGREEN or HEADGREEN');
  const measured = (runs ?? []).map((r, index) => ({ ...r, index, num: queueNum(r.headBranch), at: Date.parse(r.createdAt), end: Date.parse(r.updatedAt) }))
    .filter(r => r.num && Number.isFinite(r.at)).sort((a, b) => a.at - b.at || a.index - b.index);
  const durations = measured.filter(r => r.status === 'completed' && r.conclusion !== 'cancelled' && r.end > r.at).map(r => (r.end - r.at) / MINUTE_MS).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length ? (durations[middle] + durations[Math.floor((durations.length - 1) / 2)]) / 2 : 10;
  const duration = ciMinutes ?? median;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('ciMinutes must be positive');
  const baseline = { ...metrics(), obsoleteOverlapping: 0 };
  baseline.fullRuns = measured.filter(r => r.conclusion !== 'cancelled').length;
  baseline.createdCancelled = measured.length - baseline.fullRuns;
  baseline.failures = measured.filter(r => r.conclusion === 'failure').length;
  baseline.obsoleteOverlapping = measured.filter((r, i) => measured.slice(i + 1).some(next => next.num === r.num && next.headBranch !== r.headBranch && next.at < r.end)).length;
  const byNum = new Map();
  for (const r of measured) { if (!byNum.has(r.num)) byNum.set(r.num, []); byNum.get(r.num).push(r); }
  baseline.mergedPrs = [...byNum.values()].filter(rs => rs.some(r => r.headBranch === rs.at(-1).headBranch && r.conclusion === 'success')).length;
  baseline.runsPerMergedPr = baseline.mergedPrs ? baseline.fullRuns / baseline.mergedPrs : 0;

  // Each PR's sequence advances only after its current failing arrival is resolved.
  const sequences = new Map();
  const pending = [];
  for (const [num, rs] of byNum) {
    const arrivals = [];
    const seen = new Set();
    let index = 0;
    while (index < rs.length) {
      const first = rs[index];
      const failure = rs.slice(index).find(r => r.conclusion === 'failure' && !seen.has(r.headBranch));
      arrivals.push({ num, at: first.at, ref: failure?.headBranch ?? first.headBranch, culprit: !!failure, failureAt: failure?.at });
      if (!failure) break;
      seen.add(failure.headBranch);
      index = rs.findIndex(r => r.at > failure.at);
      if (index < 0) break;
    }
    sequences.set(num, arrivals);
    pending.push(arrivals.shift());
  }
  pending.sort((a, b) => a.at - b.at || a.num - b.num);
  const projected = metrics(), failures = [], merged = new Set(), inQueue = new Set(), items = new Map(), jobs = new Map();
  let state = initialBatchingState();
  let now = pending[0]?.at ?? 0;
  const simulationSettings = { ...STANDARD_BATCHING_SETTINGS, ...settings };
  const recordObservation = () => {
    const result = observeQueue({ state, inQueue, merged, nowMs: now, settings: simulationSettings });
    state = result.state;
    for (const e of result.events) {
      if (e.type === 'strict-on') projected.strictModeEpisodes++;
      if (e.type === 'dequeue') for (const num of e.nums) inQueue.delete(num);
    }
  };
  const schedule = () => {
    for (const g of state.groups.filter(active)) {
      if (g.status === 'forming' && now >= g.openedAtMs + simulationSettings.groupFormMinutes * MINUTE_MS) closeGroup(g, now);
      if (g.status !== 'queued' || jobs.has(g.id)) continue;
      const members = g.prs.map(n => items.get(n));
      const bad = members.filter(i => i?.culprit);
      const grouped = g.mode === 'grouped' && g.prs.length > 1;
      projected.fullRuns += grouped && policy === 'HEADGREEN' ? 1 : g.prs.length;
      if (grouped && policy === 'HEADGREEN') projected.createdCancelled += g.prs.length - 1;
      if (g.mode === 'isolate' || g.prs.every(n => state.isolate.includes(n))) projected.isolationRuns += g.prs.length;
      jobs.set(g.id, { end: now + duration * MINUTE_MS, bad, members: [...g.prs] });
    }
  };
  while (pending.length || jobs.size || state.isolate.length || state.groups.some(active)) {
    // Complete CI before admitting retries at the same timestamp.
    for (const [id, job] of [...jobs]) {
      if (job.end > now) continue;
      jobs.delete(id);
      const g = state.groups.find(g => g.id === id);
      if (job.bad.length) {
        projected.failures++;
        for (const bad of job.bad) inQueue.delete(bad.num);
        if (g.mode !== 'grouped' || g.prs.length === 1) {
          for (const bad of job.bad) {
            let trace = failures.find(f => f.num === bad.num && f.ref === bad.ref);
            if (!trace) { trace = { num: bad.num, ref: bad.ref, atMs: bad.failureAt, groupId: id, members: job.members, isolated: false, culprit: bad.num }; failures.push(trace); }
            trace.isolated = trace.isolated || g.mode === 'isolate' || state.isolate.includes(bad.num);
            const next = sequences.get(bad.num)?.shift();
            if (next) pending.push({ ...next, at: Math.max(next.at, now) });
            items.delete(bad.num);
          }
        } else {
          for (const bad of job.bad) failures.push({ num: bad.num, ref: bad.ref, atMs: bad.failureAt, groupId: id, members: job.members, isolated: false, culprit: bad.num });
        }
      } else {
        for (const num of job.members) { merged.add(num); inQueue.delete(num); items.delete(num); }
      }
      recordObservation();
    }
    recordObservation();
    // Re-admit isolated members ahead of new work, exactly one at a time.
    for (const num of state.isolate) {
      if (inQueue.has(num) || !items.has(num)) continue;
      const a = admitEnqueue({ state, num, nowMs: now, settings: simulationSettings, inQueue });
      state = a.state;
      if (a.admit) inQueue.add(num);
    }
    pending.sort((a, b) => a.at - b.at || a.num - b.num);
    for (const arrival of [...pending]) {
      if (arrival.at > now || inQueue.has(arrival.num) || items.has(arrival.num)) continue;
      const a = admitEnqueue({ state, num: arrival.num, nowMs: now, settings: simulationSettings, inQueue });
      state = a.state;
      if (!a.admit) continue;
      pending.splice(pending.indexOf(arrival), 1);
      // Off mode still executes individual baseline-like runs.
      if (a.mode === 'off') openGroup(state, arrival.num, now, 'strict', 1);
      merged.delete(arrival.num);
      items.set(arrival.num, arrival);
      inQueue.add(arrival.num);
    }
    recordObservation(); // admitted PRs are now in the queue: mark them seen before CI can eject them
    schedule();
    const nextTimes = [...jobs.values()].map(j => j.end);
    for (const g of state.groups.filter(g => g.status === 'forming')) nextTimes.push(g.openedAtMs + simulationSettings.groupFormMinutes * MINUTE_MS);
    for (const arrival of pending) if (arrival.at > now) nextTimes.push(arrival.at);
    if (state.strictUntilMs > now) nextTimes.push(state.strictUntilMs);
    const next = Math.min(...nextTimes.filter(t => t > now));
    if (!Number.isFinite(next)) {
      if (!pending.length && !state.groups.some(active) && !state.isolate.length) break;
      throw new Error('replay stalled: no next policy event');
    }
    now = next;
  }
  projected.mergedPrs = merged.size;
  projected.runsPerMergedPr = merged.size ? projected.fullRuns / merged.size : 0;
  return { policy, ciMinutes: duration, baseline, projected, failures };
}
