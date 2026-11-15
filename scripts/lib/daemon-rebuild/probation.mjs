/** Post-adoption liveness probation and rollback to an observed healthy build. */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { cloneKeyOf } from '../daemon-last-good.mjs';
import { withWriteLock } from '../daemon-clone-lock.mjs';
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
        const at = readJson(join(stateDir(env), name))?.lastTickDoneAt;
        ticks[name] = Number.isFinite(dateMs(at)) ? at : null;
      }
    }
  } catch { /* absent/unreadable ticks never prove liveness */ }
  return ticks;
}

export function openProbation({ root, env = process.env, sha, inputsKey, mainSha, applied, prevHead, preAdopted, now = Date.now } = {}) {
  try {
    const at = now();
    const adoptedAt = new Date(at).toISOString();
    const probationMs = probationMsOf(env);
    const rec = { sha, inputsKey, mainSha, applied, prevHead, adoptedAt, probationMs,
      baseline: Object.fromEntries(Object.entries(ticksOf(root, env)).filter(([, value]) => {
        const ms = dateMs(value);
        return ms >= at - 2 * probationMs && ms <= at;
      })), boots: 0, version: 1 };
    if (!buildOK(rec) || !shaOK(sha) || !shaOK(prevHead)) return false;
    if (!readProvenGood(root, env) && preAdopted?.head === prevHead) {
      writeProvenGood(root, env, { head: preAdopted.head, inputsKey: preAdopted.inputsKey,
        mainSha: preAdopted.mainSha, applied: preAdopted.applied, provenAt: adoptedAt, seeded: true });
    }
    return writeJson(fileOf(root, env, 'probation'), rec);
  } catch { return false; }
}

export function evaluateProbation({ probation, head, now, tickNow = {}, outcomeChecks = [] } = {}) {
  try {
    const adopted = dateMs(probation.adoptedAt);
    const expired = now - adopted > probation.probationMs;
    if (!head) return expired ? { action: 'fail', reason: 'no-tick-progress' } : { action: 'pending' };
    if (head !== probation.sha) return { action: 'superseded' };
    if (probation.boots > PROBATION_MAX_BOOTS) return { action: 'fail', reason: 'crash-loop' };
    const failed = outcomeChecks.find(check => check?.status === 'fail');
    if (failed) return { action: 'fail', reason: failed.reason || 'outcome-failed' };
    const baseline = Object.keys(probation.baseline);
    const advanced = name => dateMs(tickNow[name]?.lastTickDoneAt ?? tickNow[name]) > adopted;
    const live = baseline.length ? baseline.every(advanced) : Object.keys(tickNow).some(advanced);
    if (live && outcomeChecks.every(check => check?.status === 'ok')) return { action: 'pass' };
    return expired ? { action: 'fail', reason: 'no-tick-progress' } : { action: 'pending' };
  } catch { return { action: 'pending' }; }
}

export function registerOutcomeCheck(name, fn) { checks.set(name, fn); }
export function clearOutcomeChecks() { checks.clear(); }

async function announce(emit, root, env, kind, detail) {
  try { await emit({ kind, daemon: basename(root), detail }, { env }); } catch { /* telemetry is best effort */ }
}

export async function rollbackToProvenGood({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, expectSha = null, ignoreOwners = [], reason, emit = appendDaemonEvent } = {}) {
  const stEnv = { ...env, ...stateOpts.env };
  try {
    const locked = await withWriteLock(root, async () => {
      let head = null;
      try { head = verifyRev(makeGit({ run, cwd: root, env }), 'HEAD'); } catch { /* unreadable HEAD is never reset */ }
      const good = readProvenGood(root, stEnv);
      if (!good) {
        const file = alertsFilePath(root, stEnv);
        const alert = { at: new Date(now()).toISOString(), kind: 'probation-needs-you', detail: { reason: 'no-proven-good' } };
        try { log.error?.('daemon-rebuild: probation-needs-you — no proven-good build; operator recovery required'); } catch { /* log only */ }
        try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(alert)}\n`, 'utf8'); } catch { /* best effort */ }
        return { ok: false, reason: 'no-proven-good' };
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
    }, { now, ignoreOwners, ...(stEnv.WE_DAEMON_CLONE_LOCK_ROOT ? { lockRoot: stEnv.WE_DAEMON_CLONE_LOCK_ROOT } : {}) });
    const result = locked.ok ? locked.value : { ok: false, reason: locked.reason };
    if (result.ok && !result.already) await announce(emit, root, stEnv, 'probation-rolled-back', { reason: reason || 'probation-failed', head: result.head });
    return result;
  } catch { return { ok: false, reason: 'rollback-failed' }; }
}

export async function runProbationTick({ root, env = process.env, stateOpts = {}, log = console, run = gitRun,
  now = Date.now, readHead, rollback, emit = appendDaemonEvent, ignoreOwners = [] } = {}) {
  try {
    const stEnv = { ...env, ...stateOpts.env };
    const probation = readProbation(root, stEnv);
    if (!probation) return { action: 'none' };
    const at = now();
    let head = null;
    try { head = await (readHead ? readHead() : verifyRev(makeGit({ run, cwd: root, env }), 'HEAD')); } catch { /* unknown HEAD */ }
    const outcomes = await Promise.all([...checks.values()].map(async fn => {
      try { return await fn({ root, env: stEnv, probation, now: at }); } catch { return { status: 'pending' }; }
    }));
    // Async probes may outlast a newer adoption. Leave its probation alone.
    const current = readProbation(root, stEnv);
    if (!current || current.sha !== probation.sha || current.adoptedAt !== probation.adoptedAt) return { action: 'superseded' };
    const verdict = evaluateProbation({ probation, head, now: at, tickNow: ticksOf(root, stEnv), outcomeChecks: outcomes });
    if (verdict.action === 'superseded') {
      removeProbation(root, stEnv);
      return verdict;
    }
    if (verdict.action === 'pass') {
      const { sha: head, inputsKey, mainSha, applied } = probation;
      if (!writeProvenGood(root, stEnv, { head, inputsKey, mainSha, applied, provenAt: new Date(at).toISOString() })) return { action: 'pending' };
      removeProbation(root, stEnv);
      await announce(emit, root, stEnv, 'probation-passed', { head });
      return { action: 'passed' };
    }
    if (verdict.action === 'fail') {
      const result = rollback ? await rollback(verdict.reason, { ignoreOwners }) : await rollbackToProvenGood({
        root, env, stateOpts, log, run, now, emit, ignoreOwners, expectSha: probation.sha, reason: verdict.reason });
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
    if (watches.has(key)) return;
    const stEnv = { ...env, ...stateOpts.env };
    const probation = readProbation(root, stEnv);
    if (!probation) return;
    if (!booted.has(key)) {
      if (!writeJson(fileOf(root, stEnv, 'probation'), { ...probation, boots: probation.boots + 1 })) return;
      booted.add(key);
    }
    const watch = { busy: false, timer: null };
    watches.set(key, watch);
    const tick = async () => {
      if (watch.busy) return;
      watch.busy = true;
      try {
        const result = await runProbationTick({ ...options, ignoreOwners: [`${hostname()}:${process.pid}`] });
        // This probe may belong to an older adoption, while this root's watch
        // is also responsible for a replacement opened during its async checks.
        if (result.action === 'superseded' && readProbation(root, stEnv)) return;
        // A refused/failed rollback leaves recovery owed; retry on the next tick.
        if (['none', 'passed', 'superseded', 'rolled-back'].includes(result.action)) {
          clearInterval(watch.timer);
          watches.delete(key);
          if (result.action === 'rolled-back') onRolledBack();
        }
      } catch { /* watch failures never delay or crash adoption */ } finally { watch.busy = false; }
    };
    watch.timer = setInterval(tick, intervalMs ?? Math.min(30_000, probation.probationMs / 4));
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
