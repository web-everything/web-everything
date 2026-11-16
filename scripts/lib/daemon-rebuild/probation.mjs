/** Post-adoption liveness probation and rollback to an observed healthy build. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { cloneKeyOf } from '../daemon-last-good.mjs';
import { defaultProbePidLiveness, withWriteLock } from '../daemon-clone-lock.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { gitRun } from '../main-staleness.mjs';
import { finalizeRebuild } from './adopt.mjs';
import { alertsFilePath, clearReadyCandidate, readRebuildState, rebuildStatePath, stateDir, writeRebuildState } from './state.mjs';
import { makeGit, verifyRev } from './shared.mjs';

export const PROBATION_MS_DEFAULT = 900_000;
export const PROBATION_MAX_BOOTS = 3;
const checks = new Map();
const watches = new Map();
const booted = new Set();
const shaOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const dateMs = value => typeof value === 'string' ? Date.parse(value) : NaN;
const buildOK = rec => rec && typeof rec.inputsKey === 'string' && shaOK(rec.mainSha) && Array.isArray(rec.applied);
const markerOK = rec => buildOK(rec) && shaOK(rec.from) && shaOK(rec.to)
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

export function writeProvenGood(root, env, rec) {
  try {
    if (!buildOK(rec) || rec.seeded === true || !shaOK(rec.head) || !Number.isFinite(dateMs(rec.provenAt))) return false;
    return writeJson(fileOf(root, env, 'proven-good'), rec);
  } catch { return false; }
}

export function readProbation(root, env = process.env) {
  try {
    const rec = readJson(fileOf(root, env, 'probation'));
    const valid = buildOK(rec) && shaOK(rec.sha) && shaOK(rec.prevHead)
      && Number.isFinite(dateMs(rec.adoptedAt)) && Number.isSafeInteger(rec.probationMs) && rec.probationMs > 0
      && Number.isSafeInteger(rec.boots) && rec.boots >= 0 && rec.version === 1
      && rec.baseline && typeof rec.baseline === 'object' && !Array.isArray(rec.baseline)
      && Object.values(rec.baseline).every(v => v === null || Number.isFinite(dateMs(v)));
    if (!valid) return null;
    // Boot registration can spread this merged view back to disk. Only the separate,
    // adoption-bound proof may authorize continuation; stale inline fields never do.
    delete rec.continuedPid;
    delete rec.continuedAt;
    const proof = readJson(fileOf(root, env, 'probation-continuation'));
    if (proof?.sha === rec.sha && proof.adoptedAt === rec.adoptedAt) {
      return { ...rec, continuedPid: proof.continuedPid, continuedAt: proof.continuedAt };
    }
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

export function openProbation({ root, env = process.env, sha, inputsKey, mainSha, applied, prevHead, now = Date.now } = {}) {
  try {
    const at = now();
    const adoptedAt = new Date(at).toISOString();
    const probationMs = probationMsOf(env);
    const rec = { sha, inputsKey, mainSha, applied, prevHead, adoptedAt, probationMs,
      baseline: Object.fromEntries(Object.entries(ticksOf(root, env)).filter(([, value]) => {
        const ms = dateMs(value.lastTickDoneAt);
        return ms >= at - 2 * probationMs && ms <= at;
      }).map(([name, value]) => [name, value.lastTickDoneAt])), boots: 0, version: 1, adopterPid: process.pid };
    if (!buildOK(rec) || !shaOK(sha) || !shaOK(prevHead)) return false;
    // Adoption alone is not liveness proof. Only a passed probation may create
    // provenGood, including when an earlier adoption's probation was replaced.
    return writeJson(fileOf(root, env, 'probation'), rec);
  } catch { return false; }
}

/** Called only after self-sync proves that nothing imported since THIS process booted changed.
 * Keep probation's health checks and deadlines; authorize this PID instead of inventing a fresh boot.
 */
export function continueProbation({ root, env = process.env, sha, now = Date.now } = {}) {
  try {
    const probation = readProbation(root, env);
    if (!probation || probation.sha !== sha) return false;
    if (probation.continuedPid !== process.pid) {
      // This gate may run under a reader lease, concurrently with other daemons.
      // Never rewrite probation's adoption or boot metadata from this snapshot.
      if (!writeJson(fileOf(root, env, 'probation-continuation'), { sha, adoptedAt: probation.adoptedAt,
        continuedPid: process.pid, continuedAt: probation.continuedAt ?? new Date(now()).toISOString() })) return false;
    }
    const watch = watches.get(cloneKeyOf(root));
    if (watch) watch.observeOnly = false;
    return true;
  } catch { return false; }
}

export function evaluateProbation({ probation, head, now, tickNow = {}, outcomeChecks = [], observeOnly = false } = {}) {
  try {
    const adopted = dateMs(probation.adoptedAt);
    const boot = dateMs(probation.bootedAt);
    const capped = now - adopted > 2 * probation.probationMs;
    const hasBoot = Number.isSafeInteger(probation.bootPid) && probation.bootPid > 0 && Number.isFinite(boot);
    const continued = dateMs(probation.continuedAt);
    const hasContinuation = Number.isSafeInteger(probation.continuedPid) && probation.continuedPid > 0
      && Number.isFinite(continued) && continued >= adopted && continued <= now;
    const proofStart = hasBoot ? boot : continued;
    const proofPid = hasBoot ? probation.bootPid : probation.continuedPid;
    if (head && head !== probation.sha) return { action: 'superseded' };
    if (!hasBoot && !hasContinuation) return capped ? { action: 'fail', reason: 'never-booted' } : { action: 'pending' };
    if (capped) return { action: 'fail', reason: 'no-tick-progress' };
    if (observeOnly) return { action: 'pending' };
    const expired = now - proofStart > probation.probationMs;
    if (expired) return { action: 'fail', reason: 'no-tick-progress' };
    if (!head) return { action: 'pending' };
    if (probation.boots > PROBATION_MAX_BOOTS) return { action: 'fail', reason: 'crash-loop' };
    const failed = outcomeChecks.find(check => check?.status === 'fail');
    if (failed) return { action: 'fail', reason: failed.reason || 'outcome-failed' };
    const live = Object.values(tickNow).some(tick => {
      const at = dateMs(tick?.lastTickDoneAt);
      return tick?.pid === proofPid && (!hasBoot || tick.pid !== probation.adopterPid) && tick.head === probation.sha
        && at > adopted && at > proofStart && at <= now + 60_000 && now - at <= 2 * probation.probationMs;
    });
    if (live && outcomeChecks.every(check => check?.status === 'ok')) return { action: 'pass' };
    return { action: 'pending' };
  } catch { return { action: 'pending' }; }
}

const OUTCOME_CHECK_LIMIT_MS = 30_000;
const needsYouAlerted = new Set();

export function registerOutcomeCheck(name, fn) { checks.set(name, fn); }
export function clearOutcomeChecks() { checks.clear(); }

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

/** Probation records recovery owed; only a fresh boot may move the clone. */
export async function requestRollback({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, expectSha = null, reason = 'probation-failed', emit = appendDaemonEvent } = {}) {
  const stEnv = { ...env, ...stateOpts.env };
  try {
    const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
    if (!head) return { ok: false, reason: 'head-unresolved' };
    if (expectSha && head !== expectSha) return { superseded: true, head };
    const good = readProvenGood(root, stEnv);
    const refusal = !good ? 'no-proven-good' : unverifiedTree(root, stEnv, good.head, run, env) ? 'proven-good-unverified' : null;
    if (refusal) {
      await needsYou({ root, env: stEnv, now, emit, log }, { reason: refusal });
      return { ok: false, reason: refusal };
    }
    const marker = { from: head, to: good.head, inputsKey: good.inputsKey, mainSha: good.mainSha, applied: good.applied,
      rejectInputsKey: readRebuildState(root, stEnv).adopted?.inputsKey, reason, at: new Date(now()).toISOString() };
    if (!markerOK(marker)) {
      await needsYou({ root, env: stEnv, now, emit, log }, { reason: 'rollback-request-unreadable' });
      return { ok: false, reason: 'rollback-request-unreadable' };
    }
    if (!writeJson(fileOf(root, stEnv, 'rollback-requested'), marker)) return { ok: false, reason: 'rollback-failed' };
    try { removeProbation(root, stEnv); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await announce(emit, root, stEnv, 'probation-rollback-requested', { reason, head: good.head });
    return { ok: true, requested: true };
  } catch { return { ok: false, reason: 'rollback-failed' }; }
}

/** Apply recovery once at boot, before the daemon takes any read lease. */
export async function applyPendingRollback({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, lockWaitMs, bootHead, emit = appendDaemonEvent } = {}) {
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
    const complete = async () => {
      // A request writer does not take the clone lock. Recheck after async
      // finalization as well, before deleting any recovery evidence.
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
      await announce(emit, root, stEnv, 'probation-rolled-back', { reason: marker.reason, head: marker.to });
      return { ok: true, head: marker.to };
    };
    const locked = await withWriteLock(root, async () => {
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
    }, { now, waitMs: lockWaitMs ?? 60_000,
      // Expiry and unknown liveness never authorize reclamation. A same-host
      // PID verifiably gone may have left its lease behind while dying mid-tick.
      // A distinct owner also prevents excluding a same-process reader.
      owner: `probation-rollback:${process.pid}:${randomUUID()}`, leaseMinutes: Infinity,
      probe: entry => defaultProbePidLiveness(entry) === 'dead' ? 'dead' : 'alive',
      ...(stEnv.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: stEnv.WE_DAEMON_CLONE_LOCK_ROOT } : {}) });
    if (!locked.ok) {
      await needsYou({ root, env: stEnv, now, emit, log }, { reason: 'rollback-lock-timeout', heldBy: locked.heldBy });
      const head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD');
      const changed = rollbackRestartRequired(head, bootHead, marker);
      return { ok: false, reason: 'rollback-lock-timeout', ...(changed ? { restartRequired: true } : {}) };
    }
    return restartRequired ? { ...locked.value, restartRequired: true } : locked.value;
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

export async function runProbationTick({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, readHead, rollback, emit = appendDaemonEvent, observeOnly = false } = {}) {
  try {
    const stEnv = { ...env, ...stateOpts.env };
    const probation = readProbation(root, stEnv);
    if (!probation) {
      // A probation file that exists but cannot be read is never silently dropped: keep it and tell the operator once.
      if (existsSync(fileOf(root, stEnv, 'probation'))) {
        await needsYou({ root, env: stEnv, now, emit, log }, { reason: 'probation-unreadable' });
        return { action: 'pending', reason: 'probation-unreadable' };
      }
      return { action: 'none' };
    }
    let at = now();
    let head = null;
    try { head = await (readHead ? readHead() : verifyRev(makeGit({ run, cwd: root, env }), 'HEAD')); } catch { /* unknown HEAD */ }
    // A never-settling outcome check must not block the deadline: after the limit it counts as pending.
    const outcomes = await Promise.all((observeOnly ? [] : [...checks.values()]).map(async fn => {
      let timer;
      try {
        return await Promise.race([Promise.resolve(fn({ root, env: stEnv, probation, now: at })),
          new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'pending' }), OUTCOME_CHECK_LIMIT_MS); timer.unref?.(); })]);
      } catch { return { status: 'pending' }; } finally { clearTimeout(timer); }
    }));
    at = now();
    // Async probes may outlast a newer adoption. Leave its probation alone.
    const current = readProbation(root, stEnv);
    if (!current || current.sha !== probation.sha || current.adoptedAt !== probation.adoptedAt) return { action: 'superseded' };
    const verdict = evaluateProbation({ probation, head, now: at, tickNow: ticksOf(root, stEnv), outcomeChecks: outcomes, observeOnly });
    if (verdict.action === 'superseded') {
      removeProbation(root, stEnv);
      return verdict;
    }
    if (verdict.action === 'pass') {
      const { sha: head, inputsKey, mainSha, applied } = probation;
      if (!readProbationState(root, stEnv)) {
        await needsYou({ root, env: stEnv, now, emit, log }, { reason: 'rebuild-state-unreadable' });
        return { action: 'pending', reason: 'rebuild-state-unreadable' };
      }
      if (unverifiedTree(root, stEnv, head, run, env)) {
        removeProbation(root, stEnv);
        return { action: 'passed-unverified' };
      }
      if (!writeProvenGood(root, stEnv, { head, inputsKey, mainSha, applied, provenAt: new Date(at).toISOString() })) return { action: 'pending' };
      removeProbation(root, stEnv);
      await announce(emit, root, stEnv, 'probation-passed', { head });
      return { action: 'passed' };
    }
    if (verdict.action === 'fail') {
      const result = rollback ? await rollback(verdict.reason, {}) : await requestRollback({
        root, env, stateOpts, log, run, now, emit, expectSha: probation.sha, reason: verdict.reason });
      return { action: result?.ok ? 'rolled-back' : 'rollback-failed', reason: verdict.reason,
        ...(!result?.ok && result?.detail ? { detail: result.detail } : {}) };
    }
    return { action: 'pending' };
  } catch { return { action: 'pending' }; }
}

/** Arm without awaiting probes or rollback, and avoid overlapping interval ticks. */
export function armProbationWatch({ intervalMs, onRolledBack = () => process.exit(0), ...options } = {}) {
  try {
    const { root, env = process.env, stateOpts = {} } = options;
    const key = cloneKeyOf(root);
    const existing = watches.get(key);
    if (existing) {
      if (options.observeOnly) existing.observeOnly = true;
      return;
    }
    const stEnv = { ...env, ...stateOpts.env };
    const probation = readProbation(root, stEnv);
    // An unreadable probation file still starts the watch: its tick raises the needs-you alert instead of going silent.
    if (!probation && !existsSync(fileOf(root, stEnv, 'probation'))) return;
    let observeOnly = !!options.observeOnly;
    let processStartMs;
    if (probation && !observeOnly) {
      const { now = Date.now, run = gitRun, readHead } = options;
      processStartMs = options.processStartMs === undefined ? now() - process.uptime() * 1000 : options.processStartMs;
      let head = null;
      try { head = readHead ? readHead() : verifyRev(makeGit({ run, cwd: root, env }), 'HEAD'); } catch { /* unknown HEAD cannot prove a boot */ }
      observeOnly = !Number.isFinite(processStartMs) || processStartMs < dateMs(probation.adoptedAt) || head !== probation.sha;
    }
    if (probation && !observeOnly && !booted.has(key)) {
      if (!writeJson(fileOf(root, stEnv, 'probation'), { ...probation, boots: probation.boots + 1, bootPid: process.pid,
        bootedAt: probation.bootedAt ?? new Date(processStartMs).toISOString() })) return;
      booted.add(key);
    }
    const watch = { busy: false, timer: null, observeOnly };
    watches.set(key, watch);
    const tick = async () => {
      if (watch.busy) return;
      watch.busy = true;
      try {
        const result = await runProbationTick({ ...options, observeOnly: watch.observeOnly });
        // This probe may belong to an older adoption, while this root's watch
        // is also responsible for a replacement opened during its async checks.
        if (result.action === 'superseded' && readProbation(root, stEnv)) return;
        // A refused/failed rollback leaves recovery owed; retry on the next tick.
        if (['none', 'passed', 'passed-unverified', 'superseded', 'rolled-back'].includes(result.action)) {
          clearInterval(watch.timer);
          watches.delete(key);
          if (result.action === 'rolled-back') onRolledBack();
        }
      } catch { /* watch failures never delay or crash adoption */ } finally { watch.busy = false; }
    };
    watch.timer = setInterval(tick, intervalMs ?? Math.min(30_000, (probation?.probationMs ?? PROBATION_MS_DEFAULT) / 4));
    watch.timer.unref?.();
    // Start probes after returning to the caller: even a synchronous Git runner
    // must not hold up the rebuild result.
    void Promise.resolve().then(tick);
  } catch { /* best effort; caller always returns immediately */ }
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
