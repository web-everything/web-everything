/** Post-adoption liveness probation and rollback to an observed healthy build. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { cloneKeyOf } from '../daemon-last-good.mjs';
import { inspectCloneLock, withWriteLock } from '../daemon-clone-lock.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { gitRun } from '../main-staleness.mjs';
import { finalizeRebuild } from './adopt.mjs';
import { alertsFilePath, clearReadyCandidate, readRebuildState, stateDir, writeRebuildState } from './state.mjs';
import { makeGit, verifyRev } from './shared.mjs';

export const PROBATION_MS_DEFAULT = 900_000;
export const PROBATION_MAX_BOOTS = 3;
const checks = new Map();
const watches = new Map();
const booted = new Set();
const shaOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
const dateMs = value => typeof value === 'string' ? Date.parse(value) : NaN;
const buildOK = rec => rec && typeof rec.inputsKey === 'string' && shaOK(rec.mainSha) && Array.isArray(rec.applied);
const fileOf = (root, env, kind) => join(stateDir(env), `${cloneKeyOf(root)}.${kind}.json`);

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
    return buildOK(rec) && shaOK(rec.head) && Number.isFinite(dateMs(rec.provenAt)) ? rec : null;
  } catch { return null; }
}

export function writeProvenGood(root, env, rec) {
  try {
    if (!buildOK(rec) || !shaOK(rec.head) || !Number.isFinite(dateMs(rec.provenAt))) return false;
    return writeJson(fileOf(root, env, 'proven-good'), rec);
  } catch { return false; }
}

export function readProbation(root, env = process.env) {
  try {
    const rec = readJson(fileOf(root, env, 'probation'));
    return buildOK(rec) && shaOK(rec.sha) && shaOK(rec.prevHead)
      && Number.isFinite(dateMs(rec.adoptedAt)) && Number.isSafeInteger(rec.probationMs) && rec.probationMs > 0
      && Number.isSafeInteger(rec.boots) && rec.boots >= 0 && rec.version === 1
      && rec.baseline && typeof rec.baseline === 'object' && !Array.isArray(rec.baseline)
      && Object.values(rec.baseline).every(v => v === null || Number.isFinite(dateMs(v))) ? rec : null;
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

function unverifiedTree(root, stEnv, head, run, env) {
  const trees = readRebuildState(root, stEnv).forceUnverifiedTrees;
  if (trees == null || (Array.isArray(trees) && !trees.length)) return false;
  try {
    const tree = verifyRev(makeGit({ run, cwd: root, env }), `${head}^{tree}`);
    return !shaOK(tree) || !Array.isArray(trees) || trees.includes(tree);
  } catch { return true; }
}

export function openProbation({ root, env = process.env, sha, inputsKey, mainSha, applied, prevHead, preAdopted, run = gitRun, now = Date.now } = {}) {
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
    if (!readProvenGood(root, env) && preAdopted?.head === prevHead && preAdopted.forced !== true && !preAdopted.unverified
      && !unverifiedTree(root, env, prevHead, run, env)) {
      writeProvenGood(root, env, { head: preAdopted.head, inputsKey: preAdopted.inputsKey,
        mainSha: preAdopted.mainSha, applied: preAdopted.applied, provenAt: adoptedAt, seeded: true });
    }
    return writeJson(fileOf(root, env, 'probation'), rec);
  } catch { return false; }
}

export function evaluateProbation({ probation, head, now, tickNow = {}, outcomeChecks = [], observeOnly = false } = {}) {
  try {
    const adopted = dateMs(probation.adoptedAt);
    const boot = dateMs(probation.bootedAt);
    const capped = now - adopted > 2 * probation.probationMs;
    const hasBoot = Number.isSafeInteger(probation.bootPid) && probation.bootPid > 0 && Number.isFinite(boot);
    if (head && head !== probation.sha) return { action: 'superseded' };
    if (!hasBoot) return capped ? { action: 'fail', reason: 'never-booted' } : { action: 'pending' };
    if (observeOnly) return { action: 'pending' };
    const expired = now - boot > probation.probationMs || capped;
    if (expired) return { action: 'fail', reason: 'no-tick-progress' };
    if (!head) return { action: 'pending' };
    if (probation.boots > PROBATION_MAX_BOOTS) return { action: 'fail', reason: 'crash-loop' };
    const failed = outcomeChecks.find(check => check?.status === 'fail');
    if (failed) return { action: 'fail', reason: failed.reason || 'outcome-failed' };
    const live = Object.values(tickNow).some(tick => {
      const at = dateMs(tick?.lastTickDoneAt);
      return tick?.pid === probation.bootPid && tick.pid !== probation.adopterPid && tick.head === probation.sha
        && at > adopted && at > boot && at <= now + 60_000 && now - at <= 2 * probation.probationMs;
    });
    if (live && outcomeChecks.every(check => check?.status === 'ok')) return { action: 'pass' };
    return { action: 'pending' };
  } catch { return { action: 'pending' }; }
}

const OUTCOME_CHECK_LIMIT_MS = 30_000;
const unreadableAlerted = new Set();

export function registerOutcomeCheck(name, fn) { checks.set(name, fn); }
export function clearOutcomeChecks() { checks.clear(); }

async function announce(emit, root, env, kind, detail) {
  try { await emit({ kind, daemon: basename(root), detail }, { env }); } catch { /* telemetry is best effort */ }
}

export async function rollbackToProvenGood({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, expectSha = null, reason, emit = appendDaemonEvent,
  kill = (pid, signal) => process.kill(pid, signal), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } } } = {}) {
  const stEnv = { ...env, ...stateOpts.env };
  try {
    const restore = async () => {
      let head = null;
      try { head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD'); } catch { /* unreadable HEAD is never reset */ }
      const good = readProvenGood(root, stEnv);
      const refusal = !good ? 'no-proven-good' : unverifiedTree(root, stEnv, good.head, run, env) ? 'proven-good-unverified' : null;
      if (refusal) {
        const file = alertsFilePath(root, stEnv);
        const alert = { at: new Date(now()).toISOString(), kind: 'probation-needs-you', detail: { reason: refusal } };
        try { log.error?.(`daemon-rebuild: probation-needs-you — ${refusal}; operator recovery required`); } catch { /* log only */ }
        try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(alert)}\n`, 'utf8'); } catch { /* best effort */ }
        return { ok: false, reason: refusal };
      }
      if (!head) return { ok: false, reason: 'head-unresolved' };
      if (expectSha && head !== expectSha) return { superseded: true, head };
      if (head === good.head) return { ok: true, already: true };
      const failedInputsKey = readRebuildState(root, stEnv).adopted?.inputsKey;
      const done = await finalizeRebuild({ root, env, stateOpts, log, run, now, prevHead: head,
        lease: { token: 'probation-rollback' },
        plan: { ok: true, finalSha: good.head, inputsKey: good.inputsKey, mainSha: good.mainSha, applied: good.applied } });
      if (!done?.adopted) return { ok: false, reason: done?.reason || 'rollback-failed' };
      const state = readRebuildState(root, stEnv);
      state.rejected = { inputsKey: failedInputsKey, reason: reason || 'probation-failed', at: new Date(now()).toISOString(), probation: true };
      writeRebuildState(root, state, stEnv);
      clearReadyCandidate(root, stEnv);
      try { removeProbation(root, stEnv); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { ok: true, head: good.head };
    };
    // The lock permits same-owner read upgrades; rollback must drain even our own tick.
    const lockOpts = { owner: `${hostname()}:probation-${process.pid}-${randomUUID()}`, now, waitMs: 0, ...(stEnv.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: stEnv.WE_DAEMON_CLONE_LOCK_ROOT } : {}) };
    // Expired leases can still belong to running ticks: drain them before acquisition reclaims their slots.
    const tickPids = new Set(Object.values(ticksOf(root, stEnv)).map(tick => tick.pid));
    const readers = inspectCloneLock(root, { lockRoot: lockOpts.lockRoot }).readers;
    const pids = new Set(readers.flatMap(reader => {
      const owner = /^(.*):(\d+)$/.exec(reader.owner || '');
      const pid = Number(owner?.[2]);
      return owner?.[1] === hostname() && Number.isSafeInteger(pid) && pid > 1 && tickPids.has(pid) && isAlive(pid) ? [pid] : [];
    }));
    for (const pid of pids) {
      try { kill(pid, 'SIGTERM'); } catch { return { ok: false, reason: 'tick-in-progress' }; }
      if (pid === process.pid) return { ok: false, reason: 'tick-in-progress' };
    }
    for (const pid of pids) {
      for (let poll = 0; poll < 3 && isAlive(pid); poll++) await sleep(100);
      if (isAlive(pid)) return { ok: false, reason: 'tick-in-progress' };
    }
    let locked = await withWriteLock(root, restore, lockOpts);
    if (!locked.ok && locked.reason === 'tick-in-progress') {
      const owner = /^(.*):(\d+)$/.exec(locked.heldBy || '');
      const pid = Number(owner?.[2]);
      if (owner?.[1] === hostname() && Number.isSafeInteger(pid) && pid > 1
        && Object.values(ticksOf(root, stEnv)).some(tick => tick.pid === pid)) {
        try { kill(pid, 'SIGTERM'); } catch { return { ok: false, reason: 'tick-in-progress' }; }
        if (pid === process.pid) return { ok: false, reason: 'tick-in-progress' };
        for (let poll = 0; poll < 3; poll++) {
          await sleep(100);
          try { kill(pid, 0); } catch { break; }
        }
        locked = await withWriteLock(root, restore, lockOpts);
      }
    }
    const result = locked.ok ? locked.value : { ok: false, reason: locked.reason };
    if (result.ok && !result.already) await announce(emit, root, stEnv, 'probation-rolled-back', { reason: reason || 'probation-failed', head: result.head });
    return result;
  } catch { return { ok: false, reason: 'rollback-failed' }; }
}

export async function runProbationTick({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, readHead, rollback, emit = appendDaemonEvent, observeOnly = false, kill, sleep, isAlive } = {}) {
  try {
    const stEnv = { ...env, ...stateOpts.env };
    const probation = readProbation(root, stEnv);
    if (!probation) {
      // A probation file that exists but cannot be read is never silently dropped: keep it and tell the operator once.
      if (existsSync(fileOf(root, stEnv, 'probation'))) {
        if (!unreadableAlerted.has(root)) {
          unreadableAlerted.add(root);
          try {
            const file = alertsFilePath(root, stEnv);
            mkdirSync(dirname(file), { recursive: true });
            appendFileSync(file, `${JSON.stringify({ at: new Date(now()).toISOString(), kind: 'probation-needs-you', detail: { reason: 'probation-unreadable' } })}\n`, 'utf8');
          } catch { /* best effort */ }
        }
        return { action: 'pending', reason: 'probation-unreadable' };
      }
      return { action: 'none' };
    }
    const at = now();
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
      const result = rollback ? await rollback(verdict.reason, {}) : await rollbackToProvenGood({
        root, env, stateOpts, log, run, now, emit, kill, sleep, isAlive, expectSha: probation.sha, reason: verdict.reason });
      return { action: result?.ok ? 'rolled-back' : 'rollback-failed', reason: verdict.reason };
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
    if (probation && !observeOnly) {
      const { now = Date.now, run = gitRun, readHead, processStartMs = now() - process.uptime() * 1000 } = options;
      let head = null;
      try { head = readHead ? readHead() : verifyRev(makeGit({ run, cwd: root, env }), 'HEAD'); } catch { /* unknown HEAD cannot prove a boot */ }
      observeOnly = !Number.isFinite(processStartMs) || processStartMs < dateMs(probation.adoptedAt) - 1000 || head !== probation.sha;
    }
    if (probation && !observeOnly && !booted.has(key)) {
      if (!writeJson(fileOf(root, stEnv, 'probation'), { ...probation, boots: probation.boots + 1, bootPid: process.pid,
        bootedAt: probation.bootedAt ?? new Date((options.now ?? Date.now)()).toISOString() })) return;
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
    ? await rollbackToProvenGood({ root }) : { ok: false, reason: 'invalid-rollback-target', detail: '--clone and --to=provenGood required' };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
