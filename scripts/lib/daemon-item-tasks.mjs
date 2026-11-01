/** Per-item exclusion, recording facts and recoverable effect execution through injected ports. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from './atomic-json-file.mjs';
import { scanStore } from './daemon-jobs-runtime.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { RESOURCE_POLICY_KINDS } from './resource-policy.mjs';
import { taskRunId, markQueued, DEFAULT_TASK_TIMEOUT_MS, validateTaskPolicy, taskFailureCharge } from './daemon-jobs.mjs';
import { validateTaskIdentity, validateTaskMetadata, TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { newJobRunRecord, isValidRunId } from '../operations/run-record.mjs';

/** Structured input only; a logical ID is never a filesystem path. */
export function taskIdentity({ kind, repo, item, seq, id = `${kind}:${repo}:${item}:${seq}` }) {
  const task = { kind, repo, item, seq, id };
  const errors = validateTaskIdentity(task);
  if (errors.length) throw new TypeError(`task identity refused: ${errors.join('; ')}`);
  return Object.freeze(task);
}

export function taskTupleLockId(identity) {
  const { kind, repo, item } = taskIdentity(identity);
  const id = `tuple-${createHash('sha256').update(JSON.stringify([kind, repo, item])).digest('hex')}`;
  if (!isValidRunId(id)) throw new TypeError('task tuple lock ID refused');
  return id;
}

const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const policyLeaf = value => positive(value); // Explicit caller budgets/age bounds must also be positive.

/** All work inside the tuple callback is synchronous. */
/** The only facts the enqueue exclusion check reads from a job record (kept small so history is cached cheaply). */
function tupleProjection(record) {
  const other = record.job.task;
  if (!other) return Object.freeze({ id: record.id, hasTask: false });
  return Object.freeze({ id: record.id, hasTask: true, kind: other.kind, repo: other.repo, item: other.item,
    invalid: validateTaskMetadata(other).length > 0 || other.kind !== record.job.kind,
    terminal: TERMINAL_JOB_STATUSES.includes(record.job.status) });
}

export function enqueueItemTask({ store, kindDef, kind = kindDef?.kind, repo, item, seq, id,
  input = {}, codeSha = null, now = Date.now(), acting, resourceKind, actingRepoCap,
  policyOptions = {}, lockOptions = {},
}) {
  const identity = taskIdentity({ kind, repo, item, seq, ...(id === undefined ? {} : { id }) });
  if (kind !== kindDef?.kind) throw new TypeError('task identity kind must match kindDef');
  if (kindDef.codeMode === 'readonly-tree' && !codeSha) throw new TypeError('item task needs a codeSha to pin its snapshot');
  if (!RESOURCE_POLICY_KINDS.includes(resourceKind)) {
    throw new TypeError(`item task enqueue refused: resourceKind must be declared in RESOURCE_POLICY_KINDS (${RESOURCE_POLICY_KINDS.join(', ')}); correct resourceKind before rescheduling`);
  }
  // A positive scalar would pass a leaf validator but disappear when merged with object defaults.
  for (const layer of ['standard', 'platform', 'tool', 'envValues']) {
    const block = policyOptions[layer];
    if (block != null && (typeof block !== 'object' || Array.isArray(block) || Object.getPrototypeOf(block) !== Object.prototype)) {
      throw new TypeError(`task policy refused: ${layer} must be a policy object; correct policy before rescheduling`);
    }
  }
  const resolved = cascadePolicy('itemTask', policyOptions.tool, {
    ...policyOptions, standard: policyOptions.standard ?? { timeoutMs: DEFAULT_TASK_TIMEOUT_MS }, valid: policyLeaf,
  });
  const { policy, sources } = validateTaskPolicy(resolved);
  const checkBounds = value => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      Object.values(value).forEach(checkBounds);
    } else if (!positive(value)) throw new TypeError('task policy refused: every age/budget bound must be finite and positive; correct policy before rescheduling');
  };
  checkBounds(policy);
  const task = { ...identity, timeoutMs: policy.timeoutMs, policy, sources, acting, resourceKind,
    ...(actingRepoCap === undefined ? {} : { actingRepoCap }), failureCount: 0, outcome: null, resultRef: null };
  const errors = validateTaskMetadata(task);
  if (errors.length) throw new TypeError(`task metadata refused: ${errors.join('; ')}`);
  const record = markQueued(newJobRunRecord({ id: taskRunId(task), kind, input,
    codeMode: kindDef.codeMode, maxAttempts: kindDef.maxAttempts, codeSha }), { at: new Date(now).toISOString() });
  record.job.task = task;
  mkdirSync(store.dir, { recursive: true });
  const lockPath = join(store.dir, `${taskTupleLockId(identity)}.lock`);
  try {
    return withFileLock(lockPath, () => {
      const { live, done, corrupt } = scanStore(store, tupleProjection, 'item-task-tuple');
      if (corrupt.length) throw new Error(`corrupt records ${corrupt.join(', ')}`);
      const rows = [...live.map(tupleProjection), ...done].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const row of rows) {
        if (!row.hasTask) continue;
        if (row.invalid) throw new Error(`corrupt record ${row.id}`);
        if (row.kind === kind && row.repo === repo && row.item === item && !row.terminal) {
          throw new Error(`active tuple held by ${row.id}`);
        }
      }
      return store.create(record);
    }, lockOptions);
  } catch (error) {
    throw new Error(`item task enqueue refused at ${lockPath}: ${error.message}; inspect and repair the named store/lock before rescheduling`, { cause: error });
  }
}

// JSON round-tripping alone would silently drop undefined/functions and coerce nonfinite numbers.
function freezeData(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || seen.has(value) ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new TypeError('expected serializable data');
  seen.add(value);
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('unsafe data key');
    copy[key] = freezeData(value[key], seen);
  }
  seen.delete(value);
  return Object.freeze(copy);
}

const accessors = new WeakMap();
const fieldPath = path => typeof path === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path) &&
  !path.split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key));
const containsComments = value => value !== null && typeof value === 'object' &&
  Object.entries(value).some(([key, child]) => key === 'comments' || containsComments(child));

/**
 * load() synchronously supplies { identity, observedAt (epoch ms), source, complete, data }.
 * expectedIdentity includes every caller-required identity field. Only source 'live-pr' can authorize
 * effects. complete is an explicit
 * provider assertion (including pagination for comment-dependent facts), never inferred from an array.
 * No mutable snapshot escapes; missing later field reads poison this accessor for planning.
 */
export function createRecordingFacts({ load, expectedIdentity, now, snapshotMaxAgeMs }) {
  let snapshot, reason = null;
  const reads = new Map();
  try {
    snapshot = freezeData(load());
    taskIdentity({ kind: 'facts', repo: expectedIdentity?.repo, item: expectedIdentity?.item, seq: 1 });
    if (!snapshot || !expectedIdentity || !Object.keys(expectedIdentity).length ||
      !snapshot.identity || Object.keys(expectedIdentity).some(key => snapshot.identity[key] !== expectedIdentity[key]) ||
      Object.keys(snapshot.identity).some(key => !Object.hasOwn(expectedIdentity, key))) throw new Error('snapshot identity mismatch');
    if (!Number.isFinite(now) || !positive(snapshotMaxAgeMs) || !Number.isFinite(snapshot.observedAt) ||
      now < snapshot.observedAt || now - snapshot.observedAt > snapshotMaxAgeMs) throw new Error('missing or stale snapshot timestamp');
    if (snapshot.complete !== true || !snapshot.data || typeof snapshot.data !== 'object' ||
      typeof snapshot.source !== 'string' || !snapshot.source.trim()) throw new Error('incomplete snapshot');
  } catch { reason = 'snapshot missing, stale, mismatched, incomplete or unreadable; refresh authoritative inputs before rescheduling'; }
  const facts = Object.freeze({
    get outcome() { return reason ? 'deferred-read' : 'ready'; },
    get reason() { return reason; },
    get recordedReads() { return Object.freeze([...reads.values()]); },
    read(path) {
      try {
        if (reason || !fieldPath(path)) throw new Error('unavailable fact');
        let value = snapshot.data;
        for (const key of path.split('.')) {
          if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error('missing field');
          value = value[key];
        }
        // A parent object can expose comments without naming them in the requested path.
        if ((path.split('.').includes('comments') || containsComments(value)) &&
          (snapshot.thread?.source !== 'live-thread' || snapshot.thread.complete !== true)) {
          throw new Error('comment facts require a complete live thread provider');
        }
        reads.set(path, Object.freeze({ path, source: snapshot.source, observedAt: snapshot.observedAt, age: now - snapshot.observedAt }));
        return value;
      } catch {
        reason = 'fact unavailable; refresh authoritative inputs before rescheduling';
        throw new Error(`deferred-read: ${reason}`);
      }
    },
  });
  accessors.set(facts, () => ({ snapshot, reason, reads }));
  return facts;
}

/** Validate before any claim/act. Port names are serializable references resolved by a later executor. */
export function validateTaskPlan({ facts, effects }) {
  const state = accessors.get(facts)?.();
  if (!state || state.reason) throw new TypeError('deferred-read: plan requires complete recorded facts');
  const refuse = reason => { throw new TypeError(`task plan refused: ${reason}`); };
  if (!Array.isArray(effects)) refuse('effects must be declared');
  if (effects.length && state.snapshot.source !== 'live-pr') refuse('authorizing facts must come from live-pr reads');
  const names = new Set();
  for (const effect of effects) {
    if (!effect || typeof effect.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(effect.name)) refuse('stable effect name required');
    if (names.has(effect.name)) refuse('effect names must be unique');
    names.add(effect.name);
    if (!Array.isArray(effect.inputs) || !effect.inputs.every(fieldPath) ||
      !Array.isArray(effect.fences) || !effect.fences.every(fieldPath)) refuse('declared inputs and fences required');
    if (effect.inputs.some(path => !effect.fences.includes(path)) ||
      [...state.reads.keys()].some(path => !effect.fences.includes(path))) refuse('unfenced fact or input');
    if (effect.inputs.some(path => !state.reads.has(path))) refuse('declared input must have a recorded fact read');
    if (typeof effect.appliedProbe !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(effect.appliedProbe)) refuse('applied probe required');
    if (effect.precondition !== 'none' && (!effect.precondition || typeof effect.precondition !== 'object' ||
      Array.isArray(effect.precondition) || !Object.keys(effect.precondition).length)) refuse('explicit precondition or none required');
  }
  try {
    return freezeData({ effects, recordedReads: facts.recordedReads,
      inputs: Object.fromEntries([...state.reads.keys()].map(path => [path, facts.read(path)])) });
  } catch (error) { refuse(`plan must be serializable: ${error.message}`); }
}


/**
 * Async child-side executor. record.read()/update(fn) must be ownership-checked atomic operations;
 * update runs fn under the record lock and returns the committed record. We also check status,
 * handle and attempt inside every callback, so a stale child cannot write or start reads.
 *
 * read({gh}) and effects.fence(context) return createRecordingFacts accessors. plan(facts)
 * returns effect declarations. probe returns {applied: boolean, evidence?}; live-marker probes
 * additionally require thread: {source: "live-thread", complete: true}, asserting full pagination.
 * act returns JSON
 * evidence and must enforce the declared server precondition. All remote IO in these adapters
 * goes through gh.read(fn)/write(fn), including pagination/retries. Budgets are explicit finite
 * nonnegative integers; local claim, record and run-store operations do not spend GitHub budget.
 * worker-run probes exclusively call runStore.find(effectId), which must authoritatively return
 * null or a worker with status launching/running/done. No GitHub probe is invoked for that kind.
 *
 * Durable execution state lives at job.task.execution: effects by stable ID, results and timing
 * entries by launch attempt. Runtime publication/retry and timeout synthesis consume that state;
 * this core never changes the launch token, job status, backoff or owner handle.
 */
export async function runItemTask({ task, attempt, handle, record, read, plan, claim, effects,
  runStore, budgets, now = Date.now, timing = () => {} }) {
  task = taskIdentity(task);
  if (!Number.isSafeInteger(attempt) || attempt < 1 || typeof handle !== 'string' || !handle) {
    throw new TypeError('task execution requires a launch attempt and handle');
  }
  const stop = (outcome, reason) => Object.assign(new Error(reason), { outcome });
  const owned = r => {
    if (r?.job?.status !== 'running' || r.job.handle !== handle || r.job.attempts !== attempt || r.job.task?.id !== task.id) {
      throw stop('superseded', 'task writer no longer owns this running launch');
    }
    return r;
  };
  const current = async () => owned(await record.read());
  const update = async fn => {
    const committed = await record.update(r => fn(owned(r)));
    return owned(committed);
  };
  const gh = { read: 0, write: 0 }, timings = Object.fromEntries(
    ['read', 'plan', 'claim', 'probe', 'fence', 'act', 'mark', 'release'].map(p => [p, 0]));
  let phase = 'read', facts, token, result, reason, outcome = 'nothing-owed', saved = {};
  const measured = async (name, fn) => {
    phase = name;
    const start = now();
    try { return await fn(); } finally { timings[name] += Math.max(0, now() - start); }
  };
  const metered = Object.freeze(Object.fromEntries(['read', 'write'].map(kind => [kind, async fn => {
    // Adapters may await or retry after entry: recheck both authorities before each write.
    if (kind === 'write') await assertClaim();
    else await current();
    if (gh[kind] >= budgets[kind]) throw Error(`budget-exhausted: GitHub ${kind}; reschedule with refreshed budget or correct the declared bound`);
    gh[kind]++;
    return fn();
  }])));
  const remember = async entry => measured('mark', async () => {
    await update(r => {
      const execution = r.job.task.execution ?? { effects: {}, results: {}, timings: {} };
      execution.effects[entry.effectId] = freezeData(entry);
      r.job.task.execution = execution;
      saved = execution.effects;
      return r;
    });
  });
  const assertClaim = async () => {
    await current();
    if (token === null || token === undefined || token === false) throw stop('superseded', 'item claim required before effect');
    if (await claim.assert(token, task) !== true) throw stop('superseded', 'item claim lost before effect');
    await current(); // the launch can be superseded while the claim assertion awaits
  };
  try {
    const r = await current();
    const completed = r.job.task.execution?.results?.[attempt];
    if (completed) return completed;
    saved = r.job.task.execution?.effects ?? {};
    if (!budgets || ['read', 'write'].some(k => !Number.isSafeInteger(budgets[k]) || budgets[k] < 0)) {
      throw Error('task requires finite read/write budgets; correct policy before rescheduling');
    }
    facts = await measured('read', () => read({ gh: metered }));
    if (!accessors.has(facts) || facts.outcome !== 'ready') throw stop('deferred-read', facts?.reason ?? 'unreadable recording facts');
    const factIdentity = accessors.get(facts)().snapshot.identity;
    if (factIdentity.repo !== task.repo || factIdentity.item !== task.item) throw stop('deferred-read', 'task fact identity mismatch');
    const planned = await measured('plan', async () => {
      const declarations = await plan(facts);
      if (facts.outcome !== 'ready') throw stop('deferred-read', facts.reason);
      if (declarations.length && accessors.get(facts)().snapshot.source !== 'live-pr') {
        throw stop('deferred-read', 'effects require complete live per-PR facts, including comment threads');
      }
      return validateTaskPlan({ facts, effects: declarations });
    });
    // Pending intents survive replans (including an empty plan). Their original values remain
    // authoritative: a new plan cannot silently overwrite an interrupted operation's inputs.
    const pending = Object.values(saved).filter(e => e.status === 'intent');
    const queue = new Map(pending.map(e => [e.effectId, e]));
    for (const declaration of planned.effects) {
      const effectId = `${task.id}:${declaration.name}`;
      if (!queue.has(effectId)) queue.set(effectId, saved[effectId] ?? {
        effectId, status: 'intent', declaration,
        inputs: Object.fromEntries(declaration.fences.map(path => [path, planned.inputs[path] ?? facts.read(path)])),
        precondition: declaration.precondition,
      });
    }
    if (queue.size) {
      token = await measured('claim', () => claim.acquire(task));
      if (token === null || token === undefined || token === false) throw stop('deferred-claim-held', 'item claim held; retry after the owner releases it');
    }
    for (const entry of queue.values()) {
      if (entry.status === 'applied') { outcome = 'acted'; continue; }
      const context = { task, attempt, effectId: entry.effectId, effect: entry.declaration,
        inputs: entry.inputs, precondition: entry.precondition, claim: token, gh: metered };
      // Planning and claim acquisition can await a newer launch; stale owners cannot start probes.
      await current();
      const probe = await measured('probe', async () => {
        if (entry.declaration.appliedProbe !== 'worker-run') return effects.probe(context);
        const worker = await runStore.find(entry.effectId);
        if (worker === null) return { applied: false };
        if (!worker || !['launching', 'running', 'done'].includes(worker.status)) throw Error('indeterminate worker run-store probe');
        return { applied: true, evidence: worker };
      });
      if (!probe || typeof probe.applied !== 'boolean') throw Error('indeterminate authoritative applied probe');
      if (entry.declaration.appliedProbe === 'live-marker' &&
        (probe.thread?.source !== 'live-thread' || probe.thread.complete !== true)) {
        throw Error('comment marker probe requires a complete live thread provider');
      }
      if (probe.applied) {
        await remember({ ...entry, status: 'applied', evidence: probe.evidence ?? { probed: true } });
        outcome = 'acted';
        continue;
      }
      await measured('fence', async () => {
        await assertClaim();
        const live = await effects.fence(context);
        const state = accessors.get(live)?.();
        if (!state || state.reason || state.snapshot.source !== 'live-pr') throw stop('deferred-read', live?.reason ?? 'incomplete live fence');
        if (state.snapshot.identity.repo !== task.repo || state.snapshot.identity.item !== task.item) throw stop('deferred-read', 'live fence identity mismatch');
        for (const path of entry.declaration.fences) {
          if (!isDeepStrictEqual(live.read(path), entry.inputs[path])) throw stop('superseded', `live input changed: ${path}`);
        }
      });
      await remember(entry); // durable intent BEFORE act, including after a conclusive restart probe
      const evidence = await measured('act', async () => {
        await assertClaim(); // ownership can change during the fence or record write
        return effects.act(context);
      });
      await remember({ ...entry, status: 'applied', evidence });
      outcome = 'acted';
    }
  } catch (error) {
    outcome = error.outcome ?? (phase === 'probe' ? 'failed' :
      ((phase === 'read' || phase === 'fence' || facts?.outcome === 'deferred-read') ? 'deferred-read' : 'failed'));
    reason = error.message;
  } finally {
    if (token !== null && token !== undefined && token !== false) {
      try { await measured('release', () => claim.release(token, task)); }
      catch (error) {
        if (outcome !== 'superseded') outcome = 'failed';
        reason = `${reason ? `${reason}; ` : ''}claim release failed: ${error.message}`;
      }
    }
  }
  result = freezeData({ v: 1, taskId: task.id, attempt, outcome, ...(reason ? { reason } : {}),
    effects: Object.values(saved), recordedReads: facts?.recordedReads ?? [], timings, gh });
  try {
    let entry;
    await update(r => {
      const execution = r.job.task.execution ?? { effects: {}, results: {}, timings: {} };
      if (execution.results[attempt]) { result = execution.results[attempt]; return r; }
      r.job.task.failureCount += taskFailureCharge(outcome);
      r.job.task.outcome = outcome;
      execution.results[attempt] = result;
      entry = { type: 'task-timing', key: `${task.id}:${attempt}`, taskId: task.id, attempt,
        outcome, failureCount: r.job.task.failureCount, timings, gh };
      execution.timings[attempt] = entry;
      r.job.task.execution = execution;
      return r;
    });
    if (entry) await timing(entry);
  } catch (error) {
    if (error.outcome === 'superseded') return freezeData({ ...result, outcome: 'superseded', reason: error.message });
    // Publication/logging failures never replay effects or charge another failure; durable results
    // and task-timing entries are available to the runtime's completion/recovery collector.
    throw error;
  }
  return result;
}
