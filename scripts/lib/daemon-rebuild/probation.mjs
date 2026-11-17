/** Post-adoption liveness probation and rollback to an observed healthy build. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { acquireLockDir, makeLockEntry, readLockEntry, releaseLockDirIf } from '../../readiness/file-locks.mjs';
import { cloneKeyOf } from '../daemon-last-good.mjs';
import { defaultProbePidLiveness, withWriteLock } from '../daemon-clone-lock.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { gitRun } from '../main-staleness.mjs';
import { finalizeRebuild } from './adopt.mjs';
import { alertsFilePath, clearReadyCandidate, readRebuildState, rebuildStatePath, stateDir, writeRebuildState } from './state.mjs';
import { makeGit, verifyRev } from './shared.mjs';

export const PROBATION_MS_DEFAULT = 900_000;
export const PROBATION_MAX_BOOTS = 3;
const idOK = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const shaOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const dateMs = value => typeof value === 'string' ? Date.parse(value) : NaN;
const buildOK = rec => rec && typeof rec.inputsKey === 'string' && shaOK(rec.mainSha) && Array.isArray(rec.applied);
const markerOK = rec => buildOK(rec) && idOK(rec.adoptionId) && shaOK(rec.from) && shaOK(rec.to)
  && typeof rec.rejectInputsKey === 'string' && typeof rec.reason === 'string' && Number.isFinite(dateMs(rec.at));
const fileOf = (root, env, kind) => join(stateDir(env), `${cloneKeyOf(root)}.${kind}.json`);

// Recovery owes a restart only while this process's loaded code differs from
// disk. Older direct callers without a boot snapshot loaded the failed head.
function rollbackRestartRequired(head, bootHead, marker) {
  const loadedHead = shaOK(bootHead) ? bootHead : marker?.from;
  return shaOK(loadedHead) && shaOK(head) && head !== loadedHead;
}

export function probationMsOf(env = process.env) {
  const raw = env?.WE_DAEMON_PROBATION_MS;
  const n = Number(raw);
  return /^\d+$/.test(String(raw)) && Number.isSafeInteger(n) && n > 0 ? n : PROBATION_MS_DEFAULT;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, rec) {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(rec), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* no temporary file */ }
    return false;
  }
}

function removeProbation(root, env) {
  unlinkSync(fileOf(root, env, 'probation'));
}

export function readProvenGood(root, env = process.env) {
  try {
    const rec = readJson(fileOf(root, env, 'proven-good'));
    return buildOK(rec) && rec.seeded !== true && shaOK(rec.head) && Number.isFinite(dateMs(rec.provenAt)) ? rec : null;
  } catch { return null; }
}

/** One mutex for every probation, marker and proven-good mutation.
 * The id is re-read AFTER acquisition. Never reclaim a live, unknown or entryless
 * holder, even after expiry. Async boot recovery retains the mutex until settled.
 */
export function withProbationLock(root, expectId, fn, { env = process.env } = {}) {
  const lockRoot = join(stateDir(env), `${cloneKeyOf(root)}.probation-registration`);
  const key = 'probation';
  const entry = makeLockEntry(`${hostname()}:${process.pid}-${randomUUID()}`, key, new Date().toISOString(), process.pid);
  try {
    if (!acquireLockDir(lockRoot, key, entry)) {
      const held = readLockEntry(lockRoot, key);
      if (!held || defaultProbePidLiveness(held) !== 'dead'
        || !releaseLockDirIf(lockRoot, key, held) || !acquireLockDir(lockRoot, key, entry)) {
        return { action: 'pending', reason: 'probation-lock-held' };
      }
    }
  } catch { return { action: 'pending', reason: 'probation-lock-held' }; }
  const release = () => releaseLockDirIf(lockRoot, key, entry);
  try {
    const probation = readProbation(root, env);
    const marker = readJson(fileOf(root, env, 'rollback-requested'));
    const id = probation?.adoptionId ?? marker?.adoptionId ?? null;
    if (expectId !== id) {
      release();
      return { action: 'none', reason: 'adoption-changed' };
    }
    const result = fn(probation, marker);
    if (result?.then) return Promise.resolve(result).finally(release);
    release();
    return result;
  } catch (error) { release(); throw error; }
}

function currentId(root, env) {
  return readProbation(root, env)?.adoptionId ?? readJson(fileOf(root, env, 'rollback-requested'))?.adoptionId ?? null;
}

export function writeProvenGood(root, env, rec, expectId = rec?.adoptionId ?? null) {
  try {
    if (!buildOK(rec) || rec.seeded === true || !shaOK(rec.head) || !Number.isFinite(dateMs(rec.provenAt))) return false;
    return withProbationLock(root, expectId, () => writeJson(fileOf(root, env, 'proven-good'), rec), { env }) === true;
  } catch { return false; }
}

export function readProbation(root, env = process.env) {
  try {
    const rec = readJson(fileOf(root, env, 'probation'));
    const valid = buildOK(rec) && idOK(rec.adoptionId) && shaOK(rec.sha) && shaOK(rec.prevHead)
      && Number.isFinite(dateMs(rec.adoptedAt)) && Number.isSafeInteger(rec.probationMs) && rec.probationMs > 0
      && Number.isSafeInteger(rec.boots) && rec.boots >= 0 && rec.version === 1
      && rec.baseline && typeof rec.baseline === 'object' && !Array.isArray(rec.baseline)
      && Object.values(rec.baseline).every(v => v === null || Number.isFinite(dateMs(v)));
    if (!valid) return null;
    return rec;
  } catch { return null; }
}

function ticksOf(root, env) {
  const ticks = {};
  try {
    const prefix = `${cloneKeyOf(root)}.ticks.`;
    for (const name of readdirSync(stateDir(env))) {
      if (name.startsWith(prefix) && name.endsWith('.json')) {
        const rec = readJson(join(stateDir(env), name));
        ticks[name] = { lastTickDoneAt: rec?.lastTickDoneAt, pid: rec?.pid, head: rec?.head };
      }
    }
  } catch { /* absent/unreadable ticks never prove liveness */ }
  return ticks;
}

function readProbationState(root, env) {
  const state = readJson(rebuildStatePath(root, env));
  return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
}

function unverifiedTree(root, stEnv, head, run, env) {
  // The general rebuild reader maps errors to empty state. That cannot prove a
  // rollback target or promotion is absent from forceUnverifiedTrees.
  const state = readProbationState(root, stEnv);
  if (!state) return true;
  const trees = state.forceUnverifiedTrees;
  if (trees == null || (Array.isArray(trees) && !trees.length)) return false;
  try {
    const tree = verifyRev(makeGit({ run, cwd: root, env }), `${head}^{tree}`);
    return !shaOK(tree) || !Array.isArray(trees) || trees.includes(tree);
  } catch { return true; }
}

export function openProbation({ root, env = process.env, sha, inputsKey, mainSha, applied, prevHead,
  now = Date.now, run = gitRun, expectId = currentId(root, env) } = {}) {
  try {
    return withProbationLock(root, expectId, () => {
      if (verifyRev(makeGit({ run, cwd: root, env }), 'HEAD') !== sha) return false;
      // A duplicate completion cannot restart the deadline of the same adoption.
      if (readProbation(root, env)?.sha === sha) return false;
      const rec = { adoptionId: randomUUID(), sha, inputsKey, mainSha, applied, prevHead,
        adoptedAt: new Date(now()).toISOString(), probationMs: probationMsOf(env),
        baseline: {}, boots: 0, version: 1 };
      if (!buildOK(rec) || !shaOK(sha) || !shaOK(prevHead)) return false;
      return writeJson(fileOf(root, env, 'probation'), rec);
    }, { env }) === true;
  } catch { return false; }
}

/** Previous tick evidence belongs to THIS process and this adoption, never a sibling. */
export function evaluateProbation({ probation, head, bootSha, bootAt, now, tickNow = {} } = {}) {
  if (!probation) return { action: 'none' };
  const adopted = dateMs(probation.adoptedAt);
  if (head && head !== probation.sha) return { action: 'none', reason: 'superseded' };
  if (now > adopted + 2 * probation.probationMs) return { action: 'fail', reason: 'no-tick-progress' };
  if (probation.boots > PROBATION_MAX_BOOTS) return { action: 'fail', reason: 'crash-loop' };
  if (bootSha !== probation.sha || !Number.isFinite(bootAt) || !head) return { action: 'pending' };
  const start = Math.max(adopted, bootAt);
  if (now > start + probation.probationMs) return { action: 'fail', reason: 'no-tick-progress' };
  const live = Object.values(tickNow).some(tick => {
    const at = dateMs(tick?.lastTickDoneAt);
    return tick?.pid === process.pid && tick.head === probation.sha
      && at > start && at <= now + 60_000 && now - at <= 2 * probation.probationMs;
  });
  return { action: live ? 'pass' : 'pending' };
}

const needsYouAlerted = new Set();

async function announce(emit, root, env, kind, detail) {
  try { await emit({ kind, daemon: basename(root), detail }, { env }); } catch { /* telemetry is best effort */ }
}

async function needsYou({ root, env, now, emit, log }, detail) {
  const key = JSON.stringify([cloneKeyOf(root), detail.reason]);
  if (needsYouAlerted.has(key)) return;
  needsYouAlerted.add(key);
  try { log?.error?.(`daemon-rebuild: probation-needs-you — ${detail.reason}; operator recovery required`); } catch { /* log only */ }
  try {
    const file = alertsFilePath(root, env);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date(now()).toISOString(), kind: 'probation-needs-you', detail })}\n`, 'utf8');
  } catch { /* operator alert is best effort; still emit below */ }
  if (emit) await announce(emit, root, env, 'probation-needs-you', detail);
}

/** Called only while holding the adoption's mutex. A marker survives until boot. */
function requestRollbackLocked({ root, env, log, run, now, reason, emit }, probation) {
  const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
  if (!probation || head !== probation.sha) return { ok: false, reason: 'adoption-changed' };
  const good = readProvenGood(root, env);
  const refusal = !good ? 'no-proven-good' : unverifiedTree(root, env, good.head, run, env) ? 'proven-good-unverified' : null;
  if (refusal) {
    void needsYou({ root, env, now, emit, log }, { reason: refusal });
    return { ok: false, reason: refusal };
  }
  const marker = { adoptionId: probation.adoptionId, from: head, to: good.head,
    inputsKey: good.inputsKey, mainSha: good.mainSha, applied: good.applied,
    rejectInputsKey: probation.inputsKey, reason, at: new Date(now()).toISOString() };
  if (!markerOK(marker)) return { ok: false, reason: 'rollback-request-unreadable' };
  if (!writeJson(fileOf(root, env, 'rollback-requested'), marker)) return { ok: false, reason: 'rollback-failed' };
  // Keep probation as the identity authority until boot consumes both records.
  void announce(emit, root, env, 'probation-rollback-requested', { reason, head: good.head });
  return { ok: true, requested: true };
}

export function requestRollback({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, expectId, expectSha, reason = 'probation-failed', emit = appendDaemonEvent } = {}) {
  const stEnv = { ...env, ...stateOpts.env };
  const id = expectId === undefined ? currentId(root, stEnv) : expectId;
  try {
    return withProbationLock(root, id, probation => {
      if (!probation && existsSync(fileOf(root, stEnv, 'probation'))) {
        void needsYou({ root, env: stEnv, now, emit, log }, { reason: 'probation-unreadable' });
        return { ok: false, reason: 'probation-unreadable' };
      }
      if (expectSha && probation?.sha !== expectSha) return { ok: false, reason: 'adoption-changed' };
      return requestRollbackLocked({ root, env: stEnv, log, run, now, reason, emit }, probation);
    }, { env: stEnv });
  } catch { return { ok: false, reason: 'rollback-failed' }; }
}

/** Apply recovery once at boot, before the daemon takes any read lease. */
export async function applyPendingRollback({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, lockWaitMs, bootHead, expectId, emit = appendDaemonEvent } = {}) {
  const stEnv = { ...env, ...stateOpts.env };
  let restartRequired = false;
  let resetAttempted = false;
  let marker;
  try {
    const file = fileOf(root, stEnv, 'rollback-requested');
    let markerBytes;
    try {
      markerBytes = readFileSync(file, 'utf8');
      marker = JSON.parse(markerBytes);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // A sibling may have completed rollback after this process loaded its
        // modules, before this hook even read the marker.
        if (shaOK(bootHead)) {
          const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
          if (rollbackRestartRequired(head, bootHead, marker)) return { restartRequired: true, reason: 'boot-head-changed', head };
        }
        return { action: 'none' };
      }
    }
    if (!markerOK(marker)) {
      await needsYou({ root, env: stEnv, now, emit, log }, { reason: 'rollback-request-unreadable' });
      const head = shaOK(bootHead) ? verifyRev(makeGit({ run, cwd: root, env }), 'HEAD') : null;
      return { ok: false, reason: 'rollback-request-unreadable',
        ...(rollbackRestartRequired(head, bootHead, marker) ? { restartRequired: true } : {}) };
    }
    if (expectId !== undefined && marker.adoptionId !== expectId) return { action: 'none', reason: 'adoption-changed' };
    const complete = async () => {
      // The shared mutex excludes request writers through finalization. Retain
      // the byte check as a fail-closed guard for external evidence corruption.
      let currentBytes;
      try { currentBytes = readFileSync(file, 'utf8'); } catch { /* consumed or unreadable */ }
      if (currentBytes !== markerBytes) return { reason: 'rollback-request-changed', head: marker.to,
        ...(rollbackRestartRequired(marker.to, bootHead, marker) ? { restartRequired: true } : {}) };
      const state = readProbationState(root, stEnv);
      if (!state) return { ok: false, reason: 'rebuild-state-unreadable' };
      state.rejected = { inputsKey: marker.rejectInputsKey, reason: marker.reason, at: marker.at, probation: true };
      writeRebuildState(root, state, stEnv);
      clearReadyCandidate(root, stEnv);
      unlinkSync(file);
      if (readProbation(root, stEnv)?.adoptionId === marker.adoptionId) removeProbation(root, stEnv);
      await announce(emit, root, stEnv, 'probation-rolled-back', { reason: marker.reason, head: marker.to });
      return { ok: true, head: marker.to };
    };
    const locked = await withWriteLock(root, () => withProbationLock(root, marker.adoptionId, async () => {
      const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
      restartRequired = rollbackRestartRequired(head, bootHead, marker);
      // Never replay a snapshot after another caller consumed or replaced it.
      // This process may still have failed code loaded even if HEAD is now the
      // target. Retire it without touching the new owner's recovery evidence.
      let currentBytes;
      try { currentBytes = readFileSync(file, 'utf8'); } catch { /* unknown/consumed marker requires a fresh boot */ }
      if (currentBytes !== markerBytes) return { reason: 'rollback-request-changed', head };
      if (!head) return { ok: false, reason: 'head-unresolved' };
      if (head !== marker.from && head !== marker.to) {
        // A newer adoption supersedes the request, but may also supersede this
        // process's loaded code. Retire stale code before ordinary tick spacing.
        unlinkSync(file);
        return { action: 'superseded', head };
      }
      if (readProvenGood(root, stEnv)?.head !== marker.to || unverifiedTree(root, stEnv, marker.to, run, env)) {
        await needsYou({ root, env: stEnv, now, emit, log }, { reason: 'proven-good-unverified' });
        return { ok: false, reason: 'proven-good-unverified' };
      }
      if (head === marker.to) return complete();
      // Recovery must remember the failed inputs even if the process dies just after reset.
      const state = readRebuildState(root, stEnv);
      state.rejected = { inputsKey: marker.rejectInputsKey, reason: marker.reason, at: marker.at, probation: true };
      writeRebuildState(root, state, stEnv);
      resetAttempted = true;
      const done = await finalizeRebuild({ root, env, stateOpts, log, run, now, prevHead: head,
        lease: { token: 'probation-rollback' },
        plan: { ok: true, finalSha: marker.to, inputsKey: marker.inputsKey, mainSha: marker.mainSha, applied: marker.applied } });
      const after = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
      restartRequired = rollbackRestartRequired(shaOK(after) ? after : marker.to, bootHead, marker);
      if (!done?.adopted) return { ok: false, reason: done?.reason || 'rollback-failed' };
      return complete();
    }, { env: stEnv }), { now, waitMs: lockWaitMs ?? 60_000,
      // Expiry and unknown liveness never authorize reclamation. A same-host
      // PID verifiably gone may have left its lease behind while dying mid-tick.
      // A distinct owner also prevents excluding a same-process reader.
      owner: `${hostname()}:${process.pid}-probation-rollback-${randomUUID()}`, leaseMinutes: Infinity,
      probe: entry => defaultProbePidLiveness(entry) === 'dead' ? 'dead' : 'alive',
      ...(stEnv.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: stEnv.WE_DAEMON_CLONE_LOCK_ROOT } : {}) });
    if (!locked.ok) {
      await needsYou({ root, env: stEnv, now, emit, log }, { reason: 'rollback-lock-timeout', heldBy: locked.heldBy });
      const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
      const changed = rollbackRestartRequired(head, bootHead, marker);
      return { ok: false, reason: 'rollback-lock-timeout', ...(changed ? { restartRequired: true } : {}) };
    }
    const currentHead = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
    restartRequired ||= rollbackRestartRequired(currentHead, bootHead, marker);
    return restartRequired ? { ...locked.value, head: currentHead, restartRequired: true } : locked.value;
  } catch {
    // Finalization may throw after its reset. Never let a bookkeeping failure
    // turn a changed checkout into permission to execute old modules.
    if (shaOK(bootHead) || shaOK(marker?.from)) {
      try {
        const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
        restartRequired = shaOK(head) ? rollbackRestartRequired(head, bootHead, marker)
          : restartRequired || (resetAttempted && rollbackRestartRequired(marker.to, bootHead, marker));
      } catch { restartRequired ||= resetAttempted && rollbackRestartRequired(marker.to, bootHead, marker); }
    }
    return { ok: false, reason: 'rollback-failed', ...(restartRequired ? { restartRequired: true } : {}) };
  }
}

/** Synchronous: no timer or asynchronous probe can overlap the caller's tick. */
export function checkProbationAtTick({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, bootSha, bootAt, readHead, expectId, emit = appendDaemonEvent } = {}) {
  const stEnv = { ...env, ...stateOpts.env };
  const probation = readProbation(root, stEnv);
  if (!probation) {
    if (!existsSync(fileOf(root, stEnv, 'probation'))) return { action: 'none' };
    void needsYou({ root, env: stEnv, now, emit, log }, { reason: 'probation-unreadable' });
    return { action: 'pending', reason: 'probation-unreadable' };
  }
  try {
    return withProbationLock(root, expectId ?? probation.adoptionId, (current, marker) => {
      if (!current) return { action: 'none' };
      const head = readHead ? readHead() : verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
      const verdict = evaluateProbation({ probation: current, head, bootSha, bootAt, now: now(), tickNow: ticksOf(root, stEnv) });
      if (verdict.reason === 'superseded') {
        removeProbation(root, stEnv);
        return verdict;
      }
      if (markerOK(marker) && marker.adoptionId === current.adoptionId) return { action: 'fail', reason: marker.reason };
      if (verdict.action === 'pass') {
        if (!readProbationState(root, stEnv)) {
          void needsYou({ root, env: stEnv, now, emit, log }, { reason: 'rebuild-state-unreadable' });
          return { action: 'pending', reason: 'rebuild-state-unreadable' };
        }
        const unverified = unverifiedTree(root, stEnv, head, run, env);
        if (!unverified && !writeJson(fileOf(root, stEnv, 'proven-good'), {
          adoptionId: current.adoptionId, head, inputsKey: current.inputsKey, mainSha: current.mainSha,
          applied: current.applied, provenAt: new Date(now()).toISOString(),
        })) return { action: 'pending' };
        removeProbation(root, stEnv);
        void announce(emit, root, stEnv, 'probation-passed', { head, unverified });
      }
      if (verdict.action === 'fail') {
        const result = requestRollbackLocked({ root, env: stEnv, log, run, now, reason: verdict.reason, emit }, current);
        if (!result.ok) return { action: 'pending', reason: result.reason };
      }
      return verdict;
    }, { env: stEnv });
  } catch { return { action: 'pending' }; }
}

/** Every process boot enforces the adoption cap before rebuild or tick leases. */
export async function bootProbation({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, bootSha, bootHead = bootSha, bootAt = now(), expectId,
  probeBoot = defaultProbePidLiveness, emit = appendDaemonEvent, ...options } = {}) {
  const stEnv = { ...env, ...stateOpts.env };
  const probation = readProbation(root, stEnv);
  if (probation) {
    const registered = withProbationLock(root, expectId ?? probation.adoptionId, current => {
      if (!current) return { action: 'none' };
      const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
      if (head !== current.sha || bootHead !== head) return { action: 'none' };
      let updated = current;
      if (bootAt >= dateMs(current.adoptedAt) && (current.bootPid !== process.pid || current.bootedAt !== new Date(bootAt).toISOString())) {
        let predecessor = 'unknown';
        try { predecessor = probeBoot({ owner: `${current.bootHost ?? ''}:${current.bootPid}`, pid: current.bootPid }); } catch { /* unknown */ }
        const concurrentBoots = current.concurrentBoots === true || (current.boots > 0 && predecessor !== 'dead');
        updated = { ...current, boots: concurrentBoots ? 1 : current.boots + 1, concurrentBoots,
          bootPid: process.pid, bootHost: hostname(), bootedAt: new Date(bootAt).toISOString() };
        if (!writeJson(fileOf(root, stEnv, 'probation'), updated)) return { action: 'pending', reason: 'probation-open-failed' };
      }
      const reason = now() > dateMs(current.adoptedAt) + 2 * current.probationMs ? 'no-tick-progress'
        : updated.boots > PROBATION_MAX_BOOTS ? 'crash-loop' : null;
      if (reason) return requestRollbackLocked({ root, env: stEnv, log, run, now, emit, reason }, updated);
      return { action: 'pending' };
    }, { env: stEnv });
    if (registered?.reason === 'adoption-changed' || registered?.reason === 'probation-lock-held') return registered;
  }
  return applyPendingRollback({ ...options, root, env, stateOpts, log, run, now, bootHead, expectId, emit });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const root = args.find(arg => arg.startsWith('--clone='))?.slice('--clone='.length);
  const to = args.find(arg => arg.startsWith('--to='))?.slice('--to='.length);
  const result = args[0] === 'rollback' && root && to === 'provenGood'
    ? await requestRollback({ root }) : { ok: false, reason: 'invalid-rollback-target', detail: '--clone and --to=provenGood required' };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
