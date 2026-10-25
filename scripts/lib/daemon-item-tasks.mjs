/** Per-item enqueue exclusion and read/plan ports. No claim or effect execution lives here. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from './atomic-json-file.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { taskRunId, markQueued, DEFAULT_TASK_TIMEOUT_MS, validateTaskPolicy } from './daemon-jobs.mjs';
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

/** Lock order is tuple then record. All work inside the tuple callback is synchronous. */
export function enqueueItemTask({ store, kindDef, kind = kindDef?.kind, repo, item, seq, id,
  input = {}, codeSha = null, now = Date.now(), acting, resourceKind, actingRepoCap,
  policyOptions = {}, lockOptions = {},
}) {
  const identity = taskIdentity({ kind, repo, item, seq, ...(id === undefined ? {} : { id }) });
  if (kind !== kindDef?.kind) throw new TypeError('task identity kind must match kindDef');
  if (kindDef.codeMode === 'readonly-tree' && !codeSha) throw new TypeError('item task needs a codeSha to pin its snapshot');
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
      const { records, corrupt } = store.list();
      if (corrupt.length) throw new Error(`corrupt records ${corrupt.join(', ')}`);
      for (const existing of records) {
        const other = existing.job.task;
        if (!other) continue;
        const invalid = validateTaskMetadata(other);
        if (invalid.length || other.kind !== existing.job.kind) throw new Error(`corrupt record ${existing.id}`);
        if (other.kind === kind && other.repo === repo && other.item === item && !TERMINAL_JOB_STATUSES.includes(existing.job.status)) {
          throw new Error(`active tuple held by ${existing.id}`);
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

/**
 * load() synchronously supplies { identity, observedAt (epoch ms), source, complete, data }.
 * expectedIdentity includes every caller-required identity field. Discovery snapshots must label their
 * source 'discovery'; they may nominate candidates but cannot authorize effects. complete is an explicit
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
