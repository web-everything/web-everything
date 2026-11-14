/** Clean-only main merges into registered overlay tops, isolated from daemon working trees. */
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { cascadePolicy, platformPreference } from '../policy-cascade.mjs';
import { readOverlayState, overlayFilePath, appendOverlayEvent, registrationIdentity } from '../daemon-overlays.mjs';
import { isSafeBranchName } from '../daemon-self-sync.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { feedPath, publishAttention } from '../../operations/needs-you-feed.mjs';
import { markOverlayConflictWake } from '../overlay-conflict-wake.mjs';
import { buildReverseImportGraph, testDepths, isVitestTestFile, isGraphSourceFile } from '../related-test-selection.mjs';
import { alertsFilePath } from './state.mjs';
import { REBUILD_IDENTITY_ENV } from './shared.mjs';
import { tryLease } from '../../operations/coordination-lock.mjs';
import { resolveFastMaxFiles } from '../../readiness/heavy-queue-projection.mjs';
import { buildHeavyTestInvocation, runHeavyTests, heavyTestReport } from './auto-rebase.mjs';

const SELF = fileURLToPath(import.meta.url), SETTINGS = join(dirname(SELF), '../daemon-rebuild-settings.json');
const validMode = mode => ['off', 'shadow', 'on'].includes(mode);
const sidecar = (root, env) => `${overlayFilePath(root, env)}.main-sync.state`;
// The clone-wide fence keeps its original name so old and new workers still exclude each other.
const cloneLock = (root, env) => `${overlayFilePath(root, env)}.main-sync.json.clone.lock`;
const failureMarker = (root, env, ref) => join(`${alertsFilePath(root, env)}.main-sync`,
  `${createHash('sha256').update(ref).digest('hex')}.json`);
const marker = (root, env, ref) => join(`${overlayFilePath(root, env)}.auto-rebase`, `${encodeURIComponent(ref)}.lock`);
const executeGit = (args, opts) => spawnSync('git', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...opts });
const cleanText = text => String(text ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '');
const stderrTail = result => cleanText(result?.stderr || result?.error?.message).slice(-500);
function testStderrTail(result, { failedAssertions = [], failed = [] } = {}) {
  const combined = `${result?.stdout ?? ''}\n${result?.stderr || result?.error?.message || ''}`;
  const namedFiles = new Set();
  const names = failedAssertions.filter(identity => identity !== null).map(identity => {
    const [file, form, ...title] = JSON.parse(identity);
    namedFiles.add(file);
    return `${file} > ${form === 'fullName' ? title[0] : [...title[0], title[1]].join(' > ')}`;
  });
  names.push(...failed.filter(file => !namedFiles.has(file)));
  if (!names.length) {
    for (const match of stripVTControlCharacters(combined).matchAll(/^\s*FAIL\s+([^\r\n]+)/gm)) names.push(match[1].trim());
  }
  // Preserve the historical stderr-only diagnostic byte for byte after sanitizing.
  if (!result?.stdout && !names.length) return stderrTail(result);
  const prefix = cleanText([...new Set(names)].join('; ')).slice(0, 500);
  const tail = cleanText(combined);
  if (!prefix) return tail.slice(-500);
  // Reserve space for identities first: a long runner footer can only displace the tail.
  const room = 500 - prefix.length - 3;
  return room > 0 && tail ? `${prefix} | ${tail.slice(-room)}` : prefix;
}
const unsupportedAttributeSource = result => result?.status === 129 && !result.error
  && /^unknown option: --attr-source(?:=origin\/main)?\r?$/m.test(result.stderr ?? '');
const output = (result, failureTail = stderrTail(result)) => {
  if (result?.status !== 0 || result.error || typeof result.stdout !== 'string') {
    const step = result?.step ?? 'unknown', tail = failureTail;
    throw Object.assign(new Error(`${step}: command failed or incomplete; operator review required${tail ? `: ${tail}` : ''}`),
      { step, stderrTail: tail });
  }
  return result.stdout;
};
const paths = result => output(result).split('\0').filter(Boolean);
const sha = result => {
  const value = output(result).trim();
  if (!/^[a-f0-9]{40}$/.test(value)) throw Object.assign(new Error('invalid Git SHA; operator review required'), { step: result.step });
  return value;
};
// Retried Git read/preparation timeouts are tick-local: no failure memory or attention is consumed.
const transientGit = result => result?.error?.code === 'ETIMEDOUT'
  || ((result?.status !== 0 || result?.error)
    && /ETIMEDOUT|timed out/i.test(`${result?.stderr ?? ''} ${result?.error?.message ?? ''}`));
function retryGit(run, args, opts, deps = {}, cleanup = () => {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let result;
    try { result = run(args, opts); }
    catch (error) { if (!transientGit({ error })) throw error; result = { error }; }
    if (!transientGit(result)) return { ...result, step: args[0] };
    cleanup();
    if (attempt < 2) (deps.gitBackoff ?? (ms => Atomics.wait(transactionWait, 0, 0, ms)))(100 * (attempt + 1));
  }
  throw Object.assign(new Error(`${args[0]}: transient Git timeout`), { transientGit: true, step: args[0] });
}
function outcome(root, env, ref, kind, detail = {}, deps = {}) {
  const data = { ref, ...detail };
  console.error(kind === 'shadow' ? `overlay-main-sync would merge main into ${cleanText(ref)}`
    : `overlay-main-sync ${kind} ref=${cleanText(ref)}${data.step ? ` step=${cleanText(data.step)}` : ''}${data.reason ? `: ${cleanText(data.reason)}` : ''}`);
  try {
    return Promise.resolve((deps.appendDaemonEvent ?? appendDaemonEvent)(
      { kind: `overlay-main-sync-${kind}`, detail: data }, { env })).catch(() => {});
  } catch { /* Observability must not change the sync outcome. */ }
}
const RETRY_DELAYS = [10, 20, 30].map(minutes => minutes * 60_000);
const STALE_REF_MS = 60 * 60_000;
const registrationKey = registration => createHash('sha256').update(JSON.stringify(registrationIdentity(registration))).digest('hex');
function staleRegistration(file, state, ref, registration, io = fs) {
  if (!Object.hasOwn(state.staleRef, ref)) return false;
  if (state.staleRegistration[ref] === registrationKey(registration)
    && Date.now() - state.staleRef[ref] < STALE_REF_MS) return true;
  updateSyncState(file, current => { delete current.staleRef[ref]; delete current.staleRegistration[ref]; }, io);
  return false;
}
function fetchOverlay(run, root, env, ref, registration, io = fs) {
  const result = run(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', `+refs/heads/${ref}:refs/remotes/origin/${ref}`]);
  // Only the exact registered head missing from origin is a stale registration.
  if (result?.status !== 0 && !result?.error && typeof result?.stderr === 'string'
    && result.stderr.split(/\r?\n/).some(line => line === `fatal: couldn't find remote ref refs/heads/${ref}`)) {
    updateSyncState(sidecar(root, env), state => {
      state.staleRef[ref] = Date.now();
      state.staleRegistration[ref] = registrationKey(registration);
      clearRetry(state, ref);
      delete state.attemptedMain[ref];
      delete state.pushRetryMain[ref]; delete state.pushRetryAfter[ref];
      for (const key of ['firstFailureAt', 'failureAlertedAt', 'failureReason', 'errorAt']) delete state[key][ref];
    }, io);
    return false;
  }
  output(result);
  return true;
}
const retryKeys = ['retryMain', 'retryTries', 'retryAfter'];
function clearRetry(state, ref) { for (const key of retryKeys) delete state[key][ref]; }
function readSyncState(file, io = fs) {
  // Migration and mixed-version rollout: a legacy file written after the new one (by a not-yet-reloaded worker)
  // is authoritative, so its cooldowns and retry stops are never bypassed. The next write lands in the new file.
  const legacyFile = file.replace(/\.state$/, '.json');
  const mtime = path => { try { return io.statSync(path).mtimeMs; } catch (error) { if (error.code === 'ENOENT') return -1; throw error; } };
  const source = mtime(legacyFile) >= mtime(file) && mtime(legacyFile) >= 0 ? legacyFile : file;
  // Both files are fully validated: a corrupt or invalid one fails closed whichever is newer.
  const load = path => {
    let raw;
    try { raw = JSON.parse(io.readFileSync(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    return validateSyncState(raw);
  };
  load(source === file ? legacyFile : file);
  return load(source) ?? validateSyncState({ lastSyncedMain: {} });
}
function validateSyncState(data) {
  if (!data || !Object.hasOwn(data, 'lastSyncedMain')) throw new Error('invalid main-sync state; operator repair required');
  for (const key of ['lastSyncedMain', 'attemptedMain', 'shadowMain', 'pushRetryMain', 'pushRetryAfter', 'errorAt', 'firstFailureAt', 'failureAlertedAt', 'failureReason', 'staleRef', 'staleRegistration', 'conflictMain', 'conflictTip', 'mainRedMain', 'mainRedTip', 'mainRedAt', ...retryKeys]) {
    if (!Object.hasOwn(data, key)) data[key] = {};
    const map = data[key], timestamp = ['pushRetryAfter', 'errorAt', 'retryAfter', 'retryTries', 'firstFailureAt', 'failureAlertedAt', 'staleRef', 'mainRedAt'].includes(key);
    const invalid = value => {
      if (key === 'failureReason') return typeof value !== 'string';
      if (key === 'staleRegistration') return typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value);
      if (!timestamp) return typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value);
      return !Number.isSafeInteger(value) || value < 0
        || (key === 'retryTries' && (value < 1 || value > RETRY_DELAYS.length));
    };
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(invalid)) {
      throw new Error('invalid main-sync state; operator repair required');
    }
  }
  if (Object.keys(data.pushRetryAfter).some(ref => !data.pushRetryMain[ref])) throw new Error('incomplete push retry state; operator repair required');
  const staleRefs = new Set([...Object.keys(data.staleRef), ...Object.keys(data.staleRegistration)]);
  if ([...staleRefs].some(ref => !Object.hasOwn(data.staleRef, ref) || !Object.hasOwn(data.staleRegistration, ref))) {
    throw new Error('incomplete stale registration state; operator repair required');
  }
  const pairRefs = new Set([...Object.keys(data.conflictMain), ...Object.keys(data.conflictTip)]);
  if ([...pairRefs].some(ref => !Object.hasOwn(data.conflictMain, ref) || !Object.hasOwn(data.conflictTip, ref))) {
    throw new Error('incomplete conflict pair state; operator repair required');
  }
  const redRefs = new Set([...Object.keys(data.mainRedMain), ...Object.keys(data.mainRedTip), ...Object.keys(data.mainRedAt)]);
  if ([...redRefs].some(ref => !Object.hasOwn(data.mainRedMain, ref) || !Object.hasOwn(data.mainRedTip, ref))) {
    throw new Error('incomplete main-red pair state; operator repair required');
  }
  const retryRefs = new Set(retryKeys.flatMap(key => Object.keys(data[key])));
  if ([...retryRefs].some(ref => retryKeys.some(key => !Object.hasOwn(data[key], ref)))) {
    throw new Error('incomplete main-sync retry state; operator repair required');
  }
  return data;
}
function writeSyncState(file, data, io) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    io.writeFileSync(temp, JSON.stringify(data)); io.renameSync(temp, file);
    // Rollout: not-yet-reloaded workers still read the pre-rename file, so keep it in step.
    if (file.endsWith('.state')) {
      const legacyTemp = `${file}.${randomUUID()}.legacy.tmp`;
      try { io.writeFileSync(legacyTemp, JSON.stringify(data)); io.renameSync(legacyTemp, file.replace(/\.state$/, '.json')); }
      finally { io.rmSync(legacyTemp, { force: true }); }
    }
  }
  finally { io.rmSync(temp, { force: true }); }
}
const transactionWait = new Int32Array(new SharedArrayBuffer(4));
function transaction(file, fn, io = fs) {
  // The shared fence covers the entire callback, including read and rename. Even an
  // expired holder cannot resume a write after a successor has acquired the fence.
  for (let attempt = 0; attempt < 100; attempt++) {
    const lease = tryLease({ path: `${file.replace(/\.state$/, '.json')}.lock`, // pre-rename lock name: old and new workers share it
      owner: { pid: process.pid, host: hostname() },
      staleMs: 30_000, fs: io });
    if (!lease.ok) { Atomics.wait(transactionWait, 0, 0, 10); continue; }
    try {
      const result = lease.handle.runIfOwned(() => ({ value: fn() }));
      if (!result || !Object.hasOwn(result, 'value')) throw new Error('main-sync state ownership lost');
      return result.value;
    } finally { lease.handle.release(); }
  }
  throw Object.assign(new Error('main-sync state busy; retry on the next tick'), { code: 'MAIN_SYNC_STATE_BUSY' });
}
function updateSyncState(file, update, io = fs) {
  return transaction(file, () => {
    const state = readSyncState(file, io);
    update(state);
    writeSyncState(file, state, io);
  }, io);
}
function acquire(file, io = fs) {
  io.mkdirSync(dirname(file), { recursive: true });
  try { if (Date.now() - io.statSync(file).mtimeMs > 30 * 60_000) io.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = randomUUID();
  try { io.writeFileSync(file, token, { flag: 'wx' }); return token; }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
}
function release(file, token, io = fs) {
  if (!token) return;
  try { if (io.readFileSync(file, 'utf8') === token) io.unlinkSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function publishNeedsYou(root, env, ref, kind, reason, extra = {}) {
  try {
    const old = readOverlayState(root, { env }).overlays.find(o => o.ref === ref);
    // Feed keys use a numeric PR; zero is the established host/non-PR convention.
    publishAttention({ repo: 'web-everything', pr: old?.pr ?? 0, head: ref, ref, kind,
      title: `Overlay top ${ref}`, reason, ...extra }, { path: feedPath({ env }) });
  } catch { /* Attention publication must never interrupt the sync or local diagnostic. */ }
}
function needsYou(root, env, ref, error, io = fs) {
  const detail = { ref, reason: String(error?.message ?? error).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1000) };
  publishNeedsYou(root, env, ref, 'overlay-main-sync-needs-you', detail.reason);
  const file = alertsFilePath(root, env);
  io.mkdirSync(dirname(file), { recursive: true });
  io.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), kind: 'overlay-main-sync-needs-you', detail })}\n`);
}
function failureAlert(root, env, ref, error, io = fs, immediate = false) {
  const at = Date.now();
  let pendingStreak;
  const record = state => {
    state.firstFailureAt ??= {};
    state.failureAlertedAt ??= {};
    state.failureReason ??= {};
    // Scheduler checks an existing streak without recording a new failure.
    if (error !== undefined) {
      state.firstFailureAt[ref] ??= at;
      state.failureReason[ref] = cleanText(error?.message ?? error).slice(0, 1000);
    }
    if (Object.hasOwn(state.firstFailureAt, ref) && !Object.hasOwn(state.failureAlertedAt, ref)
      && (immediate || at - state.firstFailureAt[ref] > 2 * 60 * 60_000)) {
      // If publication fails, the independent marker must retain the original
      // streak rather than restarting the two-hour clock during fallback.
      pendingStreak = { firstFailureAt: { [ref]: state.firstFailureAt[ref] },
        failureReason: { [ref]: state.failureReason[ref] } };
      needsYou(root, env, ref, state.failureReason[ref] ?? 'Overlay main sync failed; original error reason unavailable', io);
      state.failureAlertedAt[ref] = at;
      state.errorAt ??= {};
      state.errorAt[ref] = at;
    }
  };
  try { updateSyncState(sidecar(root, env), record, io); }
  catch {
    // Unreadable state needs an independent streak marker; it must still fail closed.
    const file = failureMarker(root, env, ref);
    try {
      transaction(file, () => {
        let state;
        try { state = JSON.parse(io.readFileSync(file, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; state = pendingStreak ?? {}; }
        // A second alert-write failure must not discard the inherited deadline.
        if (pendingStreak) writeSyncState(file, state, io);
        record(state);
        writeSyncState(file, state, io);
      }, io);
    } catch { /* Attention storage must not interrupt lock cleanup. */ }
  }
}
let lastModeLog;
export function resolveOverlayMainSyncMode(env = process.env, { settingsPath = SETTINGS } = {}) {
  let tool;
  try { tool = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).overlayMainSync; } catch { /* standard */ }
  const r = cascadePolicy('overlayMainSync', tool, { env, standard: { mode: 'shadow' },
    envValues: { mode: env.WE_DAEMON_OVERLAY_MAIN_SYNC }, valid: { mode: validMode } });
  const value = { mode: r.value.mode, source: r.sources.mode };
  const line = `overlayMainSync=${value.mode} source=${value.source}`, key = `${settingsPath}:${line}`;
  if (lastModeLog !== key) { console.error(line); lastModeLog = key; }
  return value;
}
export function resolveOverlayFlakeReruns(env = process.env, { settingsPath = SETTINGS } = {}) {
  let tool;
  try { tool = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).overlay?.mainSync; } catch { /* standard */ }
  const raw = env.WE_DAEMON_OVERLAY_MAIN_SYNC_FLAKE_RERUNS;
  const r = cascadePolicy('overlay.mainSync', tool, { env,
    platform: platformPreference('overlay', { env })?.mainSync ?? {},
    standard: { flakeReruns: 1 },
    envValues: { flakeReruns: typeof raw === 'string' && raw.trim() ? Number(raw) : undefined },
    valid: { flakeReruns: n => Number.isSafeInteger(n) && n >= 0 && n <= 2 } });
  return { value: r.value.flakeReruns, source: r.sources.flakeReruns };
}
export function resolveOverlayMainRedExpiryHours(env = process.env, { settingsPath = SETTINGS } = {}) {
  let tool;
  try { tool = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).overlay?.mainSync; } catch { /* standard */ }
  const raw = env.WE_DAEMON_OVERLAY_MAIN_SYNC_MAIN_RED_EXPIRY_HOURS;
  const r = cascadePolicy('overlay.mainSync', tool, { env,
    platform: platformPreference('overlay', { env })?.mainSync ?? {},
    standard: { mainRedExpiryHours: 6 },
    envValues: { mainRedExpiryHours: typeof raw === 'string' && raw.trim() ? Number(raw) : undefined },
    valid: { mainRedExpiryHours: n => typeof n === 'number' && Number.isFinite(n)
      && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 3_600_000 } });
  return { value: r.value.mainRedExpiryHours, source: r.sources.mainRedExpiryHours };
}
function mainRedKnown(state, ref, main, tip, env, now = () => new Date().toISOString()) {
  if (state.mainRedMain[ref] !== main || state.mainRedTip[ref] !== tip
    || !Object.hasOwn(state.mainRedAt, ref)) return false;
  const age = new Date(now()).getTime() - state.mainRedAt[ref];
  const { value: hours } = resolveOverlayMainRedExpiryHours(env);
  return age >= 0 && age < hours * 3_600_000;
}
export function selectSyncTargets(state) {
  if (state?.corrupt || !Array.isArray(state?.overlays)) throw new Error('overlay state unavailable; operator repair required');
  return state.overlays.filter(o => !state.overlays.some(other => other !== o && other.stackBases?.includes(o.ref))).map(o => o.ref);
}
function openJobLog(root, env) {
  const file = `${overlayFilePath(root, env)}.main-sync.log`;
  try {
    fs.mkdirSync(dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.renameSync(file, `${file}.1`);
    }
    return fs.openSync(file, 'a');
  } catch { return undefined; }
}
export function kickOverlayMainSync({ root, env = process.env, mode, spawnFn = spawn, git = executeGit, deps = {} }) {
  mode ??= resolveOverlayMainSyncMode(env).mode;
  if (!validMode(mode)) throw new Error('invalid overlay main sync mode');
  const result = { started: [], skipped: [], would: [] };
  if (mode === 'off') return result;
  const run = args => retryGit(git, args, { cwd: root, env }, deps);
  const registrations = readOverlayState(root, { env });
  for (const ref of selectSyncTargets(registrations)) {
    let token, cloneToken;
    const clone = cloneLock(root, env);
    const skip = reason => { result.skipped.push(ref); outcome(root, env, ref, 'skipped', { reason }, deps); };
    const lock = marker(root, env, ref);
    const alert = error => {
      outcome(root, env, ref, 'failed', { step: error.step ?? 'state', reason: error.message, stderrTail: error.stderrTail ?? '' }, deps);
      failureAlert(root, env, ref, error);
    };
    try {
      if (!isSafeBranchName(ref)) throw new Error('unsafe overlay ref');
      cloneToken = acquire(clone);
      if (!cloneToken) { skip('clone-busy'); continue; }
      token = acquire(lock);
      if (!token) { skip('ref-busy'); continue; }
      const synced = readSyncState(sidecar(root, env));
      const registration = registrations.overlays.find(o => o.ref === ref);
      if (staleRegistration(sidecar(root, env), synced, ref, registration)) { skip('stale-registration'); continue; }
      if (Date.now() < (synced.pushRetryAfter[ref] ?? 0)) { skip('cooldown'); continue; }
      if (!fetchOverlay(run, root, env, ref, registration)) { skip('stale-registration'); continue; }
      const main = sha(run(['rev-parse', 'origin/main']));
      if (synced.retryMain[ref] === main && Date.now() < synced.retryAfter[ref]) { skip('cooldown'); continue; }
      const tip = sha(run(['rev-parse', `origin/${ref}`]));
      if (mainRedKnown(synced, ref, main, tip, env, deps.now)) { skip('main-red-known'); continue; }
      const pairKnown = synced.conflictMain[ref] === main && synced.conflictTip[ref] === tip;
      // A known conflicting (main, tip) pair is final: silent skip (its one conflict event was already emitted).
      if (pairKnown) {
        if (Object.hasOwn(synced.firstFailureAt, ref) && !Object.hasOwn(synced.failureAlertedAt, ref)) failureAlert(root, env, ref);
        result.skipped.push(ref); continue;
      }
      if (Object.hasOwn(synced.conflictMain, ref)) {
        const old = synced.conflictMain[ref];
        if (old === main) {
          // Only the ref tip moved: lift the terminal stop ONLY on evidence that the new tip merges cleanly
          // with the same main (side-effect-free merge-tree). A conflict or an error keeps the stop.
          let check;
          try {
            // Match the scratch worker even when this checkout predates main's merge attributes.
            const args = ['merge-tree', '--write-tree', '--name-only', main, tip];
            check = run(['--attr-source=origin/main', ...args]);
            if (unsupportedAttributeSource(check)) check = run(args);
          }
          catch (error) { check = { error }; }
          // Evidence must be complete: a tree id on the first line, whatever the exit status.
          const treeOk = !check?.error && typeof check?.stdout === 'string' && /^[a-f0-9]{40}$/.test(check.stdout.split(/\r?\n/)[0]);
          if (!treeOk) { skip('conflict-check-error'); continue; }
          if (check.status === 1) {
            const files = check.stdout.split(/\r?\n/).slice(1).map(cleanText);
            const conflicted = files.slice(0, files.indexOf('') < 0 ? files.length : files.indexOf('')).filter(Boolean);
            if (conflicted.length) {
              updateSyncState(sidecar(root, env), state => { state.conflictTip[ref] = tip; });
              outcome(root, env, ref, 'conflict', { step: 'merge', main, tip, files: conflicted,
                stderrTail: '', reason: `merge conflicts remain after the ref tip moved: ${conflicted.join(', ')}` }, deps);
            } else skip('conflict-check-error');
            result.skipped.push(ref); continue;
          }
          if (check?.status !== 0 || check.error) { skip('conflict-check-error'); continue; }
        }
        // Clean after the move (or main moved): forget the pair so the normal retry cap governs later failures.
        updateSyncState(sidecar(root, env), state => {
          delete state.conflictMain[ref]; delete state.conflictTip[ref];
          if (state.attemptedMain[ref] === old) delete state.attemptedMain[ref];
        });
        delete synced.conflictMain[ref]; delete synced.conflictTip[ref];
        if (synced.attemptedMain[ref] === old) delete synced.attemptedMain[ref];
      }
      const last = synced.lastSyncedMain[ref];
      const attemptedHere = synced.attemptedMain[ref] === main;
      if (attemptedHere && Object.hasOwn(synced.firstFailureAt, ref)
        && !Object.hasOwn(synced.failureAlertedAt, ref)) failureAlert(root, env, ref);
      if (last === main || attemptedHere || (mode === 'shadow' && synced.shadowMain[ref] === main)) {
        skip('up-to-date'); continue;
      }
      const base = last ?? sha(run(['merge-base', 'origin/main', `origin/${ref}`]));
      const changed = new Set(paths(run(['diff', '--name-only', '-z', base, main])));
      if (!paths(run(['diff', '--name-only', '-z', `origin/main...origin/${ref}`])).some(f => changed.has(f))) {
        skip('up-to-date'); continue;
      }
      if (mode === 'shadow') {
        updateSyncState(sidecar(root, env), state => { state.shadowMain[ref] = main; });
        outcome(root, env, ref, 'shadow', {}, deps);
        appendOverlayEvent(root, { kind: 'overlay-main-sync-shadow', ref }, { env });
        result.would.push(ref); continue;
      }
      const owner = token;
      const fd = openJobLog(root, env);
      let child;
      // The worker acquires its own clone fence; retain the ref marker during handoff.
      release(clone, cloneToken); cloneToken = null;
      try {
        child = spawnFn(process.execPath, [SELF, `--clone=${root}`, `--ref=${ref}`, `--token=${owner}`],
          { cwd: root, env, detached: true, stdio: fd === undefined ? 'ignore' : ['ignore', fd, fd] });
      } finally {
        try { if (fd !== undefined) fs.closeSync(fd); }
        catch { /* Closing the log must not interrupt child ownership transfer. */ }
      }
      child.once?.('error', error => { alert(error); release(lock, owner); });
      child.unref(); result.started.push(ref); token = null;
    } catch (error) {
      if (error.transientGit) skip('transient-git');
      else { alert(error); result.skipped.push(ref); }
    } finally {
      try { release(lock, token); } finally { release(clone, cloneToken); }
    }
  }
  return result;
}
const testFailure = evidence => Object.assign(new Error('selected tests did not pass or execute; operator review required'),
  { stderrTail: evidence?.stderrTail ?? '' });
const remoteUnconfirmed = result => result?.status === 124 && typeof result.stderr === 'string'
  && result.stderr.includes('remote termination unconfirmed; refusing local rerun (exit 124).');
// Vitest's "Unhandled Errors" section header and its "Errors  N error(s)" summary row.
const UNHANDLED_ERRORS = /^\s*(?:⎯+\s*)?Unhandled (?:Errors?|Rejections?)\b|^\s*Errors\s+\d+ errors?\s*$/i;
function failedTestReport(stdout, options) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 8 * 1024 * 1024) throw testFailure();
  const failed = new Map(), titles = [];
  // A red suite (not ok ... {) with no failed leaf beneath it is a hook failure
  // (beforeAll/afterAll); the leaf-only inventory below would erase it, so track it.
  // Per-occurrence ids (not title paths) so duplicate sibling suite names cannot mask each other.
  const redSuites = new Set(), suitesWithFailedLeaf = new Set(), suiteIds = [];
  let suiteCount = 0;
  let leaf = 0, diagnostic, inTap = false;
  // Reuse the strict TAP plan and typed-test-count validator. Normalize only red
  // statuses/diagnostics for validation, then restore the observed failed leaves.
  const normalized = stdout.replace(/\r\n/g, '\n').split('\n').flatMap(line => {
    // BasicReporter colors its summary in CI (same as heavyTestReport): strip ANSI for summary
    // detection only, so TAP titles stay literal.
    const plain = stripVTControlCharacters(line);
    if (line === 'TAP version 13') inTap = true;
    if (/^(?: Test Files|  Snapshots)  /.test(plain)) inTap = false;
    if (diagnostic !== undefined) {
      if (line === `${diagnostic}...`) diagnostic = undefined;
      return [];
    }
    // Fail closed: an unhandled error is a red run the failed leaves do not explain, so it must
    // never be rerun away. Checked outside YAML diagnostics; a TAP result line never matches these.
    if (UNHANDLED_ERRORS.test(plain)) throw testFailure();
    const yaml = inTap && /^( +)---$/.exec(line);
    if (yaml) { diagnostic = yaml[1]; return []; }
    const task = inTap && /^( *)(not )?ok \d+ - (.*?)(?: # (SKIP|TODO|time=\d+(?:\.\d+)?ms))?( \{)?$/s.exec(line);
    if (inTap && /^\s*}$/.test(line)) { titles.pop(); suiteIds.pop(); }
    if (task) {
      if (task[5]) {
        titles.push(task[3]);
        suiteIds.push(suiteCount++);
        if (task[2]) redSuites.add(suiteIds.at(-1));
      } else if (titles.length) {
        if (task[2]) {
          failed.set(leaf, { title: task[3], ancestorTitles: titles.slice(1) });
          for (const id of suiteIds) suitesWithFailedLeaf.add(id);
        }
        leaf++;
      }
    }
    if (plain.startsWith('      Tests  ')) {
      const summary = /^      Tests  (.+) \((\d+)\)$/.exec(plain);
      if (!summary) throw testFailure();
      let passed = 0;
      const pending = [];
      for (const part of summary[1].split(' | ')) {
        const count = /^(\d+) (passed|failed|skipped|todo)$/.exec(part);
        if (!count) throw testFailure();
        if (['passed', 'failed'].includes(count[2])) passed += Number(count[1]);
        else pending.push(part);
      }
      return [`      Tests  ${[...(passed ? [`${passed} passed`] : []), ...pending].join(' | ')} (${summary[2]})`];
    }
    return [line.replace(/^(\s*)not ok /, '$1ok ')];
  }).join('\n');
  if (diagnostic !== undefined || !failed.size) throw testFailure();
  // Fail closed: a red suite without a failed leaf is a hook failure that must not be rerun away.
  for (const id of redSuites) if (!suitesWithFailedLeaf.has(id)) throw testFailure();
  const report = heavyTestReport(normalized, options);
  report.testResults.flatMap(r => r.assertionResults).forEach((assertion, index) => {
    if (failed.has(index)) {
      if (assertion.status !== 'passed') throw testFailure();
      assertion.status = 'failed';
      Object.assign(assertion, failed.get(index));
    }
  });
  return report;
}
// Scope identities to their file; never infer a test identity from a failing filename.
function assertionIdentity(file, assertion) {
  if (typeof assertion.fullName === 'string' && assertion.fullName.trim()) {
    return JSON.stringify([file, 'fullName', assertion.fullName]);
  }
  if (typeof assertion.title === 'string' && assertion.title.trim()
    && Array.isArray(assertion.ancestorTitles)
    && assertion.ancestorTitles.every(title => typeof title === 'string' && title.trim())) {
    return JSON.stringify([file, 'title', assertion.ancestorTitles, assertion.title]);
  }
  return null;
}
// Vitest 1.x has no list CLI: let its own config loader and project globbing define the inventory.
// createVitest does not set the flags the real CLI (startVitest) sets before it loads the config, and configs
// branch on them, so establish the same prelude first: TEST and VITEST forced, NODE_ENV only defaulted.
// A config or plugin may log to stdout before, after or around the inventory, so the inventory is a single
// marked line on its own (a leading newline ends any unterminated write) and only that line is parsed.
export const VITEST_INVENTORY_MARK = '@@overlay-main-sync-inventory@@ ';
const VITEST_LIST_SCRIPT = `
process.env.TEST = 'true';
process.env.VITEST = 'true';
process.env.NODE_ENV ??= 'test';
const { createVitest } = await import('vitest/node');
const ctx = await createVitest('test', { watch: false, run: false });
try {
  const files = await ctx.globTestFiles();
  process.stdout.write('\\n${VITEST_INVENTORY_MARK}' + JSON.stringify(files.map(entry => Array.isArray(entry) ? entry[1] : entry)) + '\\n');
} finally { await ctx.close(); }
`;
export const OVERLAY_RELATED_TEST_CAP_ENV = 'WE_OVERLAY_MAIN_SYNC_RELATED_MAX_FILES';
export function overlayRelatedTestCap(env = {}) {
  const n = Number(env?.[OVERLAY_RELATED_TEST_CAP_ENV]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 150;
}
const TEST_LIST_MAX_BUFFER = 8 * 1024 * 1024;
async function runnableTestFiles({ scratch, env, runner = spawnSync }) {
  let result;
  try {
    result = await runner(process.execPath, ['--input-type=module', '-e', VITEST_LIST_SCRIPT], {
      cwd: scratch, env, encoding: 'utf8', timeout: 60_000, maxBuffer: TEST_LIST_MAX_BUFFER,
    });
    const stdout = output({ ...result, step: 'test-select' });
    if (Buffer.byteLength(stdout, 'utf8') > TEST_LIST_MAX_BUFFER) throw new Error('Vitest inventory exceeds 8 MiB');
    // Fail closed: no marked line means the listing did not complete; the last one wins over earlier noise.
    const marked = stdout.split(/\r?\n/).filter(line => line.startsWith(VITEST_INVENTORY_MARK));
    if (!marked.length) throw new Error('Vitest inventory line missing from stdout');
    const files = JSON.parse(marked.at(-1).slice(VITEST_INVENTORY_MARK.length));
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !isAbsolute(file) || file.includes('\0'))) {
      throw new Error('invalid Vitest inventory paths');
    }
    return new Set(files);
  } catch (cause) {
    const tail = stderrTail(result) || cleanText(cause.message).slice(-500);
    throw Object.assign(new Error(`Vitest inventory unavailable; operator review required: ${cleanText(cause.message)}`),
      { step: 'test-select', stderrTail: tail });
  }
}

async function syncTestEvidence({ root, scratch, selected, testReport, env, io, runner }) {
  io.rmSync(testReport, { force: true }); // Never consume a previous attempt's evidence.
  const invocation = buildHeavyTestInvocation({ root, scratch, selected, testReport, env, io });
  const result = await (runner ?? (options => runHeavyTests(options, { io })))(invocation);
  if (remoteUnconfirmed(result)) return { remoteUnconfirmed: true };
  let validatedFailure = false;
  if (result?.status === 1) {
    try {
      const report = failedTestReport(result.stdout, { ...invocation, root: io.realpathSync(scratch) });
      io.writeFileSync(testReport, JSON.stringify(report));
      validatedFailure = true;
    } catch { /* No trustworthy TAP inventory: retain the command failure below. */ }
  }
  const commandOk = result?.status === 0 && !result.error && typeof result.stdout === 'string';
  let report;
  try {
    if (io.statSync(testReport).size > 8 * 1024 * 1024) throw new Error('test report over 8 MiB; operator review required');
    report = JSON.parse(io.readFileSync(testReport, 'utf8'));
  } catch (error) {
    if (!commandOk) output({ ...result, step: 'tests' }, testStderrTail(result));
    throw Object.assign(error, { stderrTail: testStderrTail(result) });
  }
  const results = report?.testResults;
  if (!Array.isArray(results)) throw testFailure({ stderrTail: testStderrTail(result) });
  const names = selected.map(file => join(io.realpathSync(scratch), file));
  const failed = [], passed = [], failedAssertions = [], failedFiles = [], byFile = new Map();
  for (let i = 0; i < selected.length; i++) {
    const matches = results.filter(r => r?.name === names[i]);
    if (matches.length !== 1) continue;
    const r = matches[0], assertions = r.assertionResults;
    if (r.status === 'failed') failedFiles.push(selected[i]);
    if (!Array.isArray(assertions) || !assertions.length
      || assertions.some(a => !['passed', 'failed'].includes(a?.status))) continue;
    const ids = status => assertions.filter(a => a.status === status).map(a => assertionIdentity(selected[i], a));
    byFile.set(selected[i], { total: assertions.length, failedIds: ids('failed'), passedIds: ids('passed') });
    if (assertions.some(a => a.status === 'failed')) {
      failed.push(selected[i]);
      failedAssertions.push(...assertions.filter(a => a.status === 'failed').map(a => assertionIdentity(selected[i], a)));
    }
    else if (r.status !== 'failed') passed.push(selected[i]);
  }
  const complete = passed.length + failed.length === selected.length
    // Vitest file filters are substring matches, so a chunk can also run extra files. They are tolerated only
    // when every assertion passed: anything else keeps the chunk incomplete.
    && results.every(r => names.includes(r?.name) || (r?.status !== 'failed'
      && Array.isArray(r?.assertionResults) && r.assertionResults.length > 0
      && r.assertionResults.every(a => a?.status === 'passed')));
  const green = commandOk && complete && !failed.length && report.success !== false
    && !(report.numFailedTests > 0) && !(report.numFailedTestSuites > 0);
  const tail = testStderrTail(result, { failedAssertions, failed: [...new Set([...failed, ...failedFiles])] });
  if (!commandOk && !(result?.status === 1 && (!result.error || validatedFailure) && complete && failed.length)) {
    output({ ...result, step: 'tests' }, tail);
  }
  return { green, failed, complete, failedAssertions, byFile, stderrTail: tail };
}
// A green rerun only clears a failure it actually re-executed. Per previously failed file the rerun must
// run at least as many assertions as the failing run did (a vanished assertion fails closed), and, when
// both sides carry assertion identities, every previously failed identity must reappear among the
// rerun's passed ones (counted, so duplicate titles cannot cover each other). A TAP-derived passing
// report carries no titles, so there the count is the guarantee.
function rerunCoversFailures(previous, rerun, files) {
  for (const file of files) {
    const before = previous.byFile.get(file), after = rerun.byFile.get(file);
    if (!before || !after || after.total < before.total) return false;
    if (before.failedIds.some(id => id === null)) return false;
    if (after.passedIds.some(id => id === null)) continue;
    if (!coveredWithMultiplicity(before.failedIds, after.passedIds)) return false;
  }
  return true;
}
// Every needed identity must be matched by its own supplied occurrence: duplicates consume one each.
function coveredWithMultiplicity(needed, supplied) {
  const available = new Map();
  for (const id of supplied) available.set(id, (available.get(id) ?? 0) + 1);
  for (const id of needed) {
    const left = available.get(id) ?? 0;
    if (left < 1) return false;
    available.set(id, left - 1);
  }
  return true;
}
export async function runOverlayMainSync({ root, ref, token, env = process.env, deps = {} }) {
  const io = deps.io ?? fs, event = deps.appendOverlayEvent ?? appendOverlayEvent;
  const now = deps.now ?? (() => new Date().toISOString());
  let step = 'state';
  const setStep = name => { step = name; };
  const git = (args, cwd = root, globalArgs = [], opts = {}) => {
    setStep(args[0]);
    return retryGit((args, opts) => (deps.git ?? executeGit)([...globalArgs, ...args], opts),
      args, { ...opts, cwd, env: { ...env, ...REBUILD_IDENTITY_ENV } }, deps,
      () => {
        if (args[0] === 'clone') io.rmSync(args.at(-1), { recursive: true, force: true });
        else if (args[0] === 'checkout' && cwd !== root) {
          // Interrupted checkouts can leave a partial index and untracked target files.
          io.rmSync(join(cwd, '.git', 'index'), { force: true });
          io.rmSync(join(cwd, '.git', 'index.lock'), { force: true });
          for (const entry of io.readdirSync(cwd)) {
            if (entry !== '.git') io.rmSync(join(cwd, entry), { recursive: true, force: true });
          }
        }
      });
  };
  const failureEvent = async error => {
    const detail = { ref, step: error.step ?? step, stderrTail: error.stderrTail ?? '', main: main ?? null };
    await outcome(root, env, ref, 'failed', { ...detail, reason: error.message }, deps);
  };
  const lock = marker(root, env, ref);
  const clone = cloneLock(root, env);
  const skip = async reason => {
    await outcome(root, env, ref, 'skipped', { reason }, deps);
    return { skipped: true, reason };
  };
  let cloneToken, scratchParent, heartbeat, main, conflictInfo, mergeConflict = false, publicationStarted = false;
  try {
    if (!isSafeBranchName(ref)) throw new Error('unsafe overlay ref');
    cloneToken = acquire(clone, io);
    if (!cloneToken) return await skip('clone-busy');
    const synced = readSyncState(sidecar(root, env), io);
    if (token) { if (io.readFileSync(lock, 'utf8') !== token) throw new Error('marker ownership lost'); }
    else { token = acquire(lock, io); if (!token) return await skip('ref-busy'); }
    heartbeat = setInterval(() => {
      try {
        const date = new Date();
        if (io.readFileSync(lock, 'utf8') === token) io.utimesSync(lock, date, date);
        if (io.readFileSync(clone, 'utf8') === cloneToken) io.utimesSync(clone, date, date);
      }
      catch { /* ownership is checked again before push */ }
    }, deps.heartbeatMs ?? 60_000);
    heartbeat.unref();
    setStep('registration');
    const state = readOverlayState(root, { env }), old = state.overlays.find(o => o.ref === ref);
    if (state.corrupt || !old || !selectSyncTargets(state).includes(ref)) throw new Error('overlay registration unavailable');
    if (staleRegistration(sidecar(root, env), synced, ref, old, io)) return await skip('stale-registration');
    main = sha(git(['rev-parse', 'origin/main']));
    setStep('scratch');
    scratchParent = io.mkdtempSync(join(env.TMPDIR || tmpdir(), 'we-overlay-main-sync-'));
    const scratch = join(scratchParent, 'repo');
    const url = output(git(['remote', 'get-url', 'origin'])).trim();
    const origin = isAbsolute(url) || url.includes(':') || url.startsWith('~') ? url : resolve(root, url);
    output(git(['clone', '--shared', '--no-checkout', root, scratch]));
    output(git(['remote', 'set-url', 'origin', origin], scratch));
    if (!fetchOverlay(args => git(args, scratch), root, env, ref, old, io)) return await skip('stale-registration');
    output(git(['checkout', '--force', '-b', ref, `origin/${ref}`], scratch, [], { timeout: 300_000 }));
    const from = sha(git(['rev-parse', 'HEAD'], scratch));
    main = sha(git(['rev-parse', 'origin/main'], scratch));
    if (mainRedKnown(synced, ref, main, from, env, now)) return await skip('main-red-known');
    if (synced.conflictMain[ref] === main && synced.conflictTip[ref] === from) return await skip('conflict-known');
    const base = sha(git(['merge-base', main, from], scratch));
    const own = paths(git(['diff', '--name-only', '-z', base, from], scratch));
    let merge, mergeError;
    try {
      // The overlay may predate main's merge attributes. Keep the retry/diagnostic step as merge.
      merge = git(['merge', '--no-edit', 'origin/main'], scratch, ['--attr-source=origin/main']);
      if (unsupportedAttributeSource(merge)) {
        // Git before 2.40 rejects the global option before starting a merge.
        merge = git(['merge', '--no-edit', 'origin/main'], scratch);
      }
    }
    catch (error) {
      if (!error.transientGit) throw error;
      mergeError = error; merge = { error };
    }
    const conflicts = paths(git(['diff', '--name-only', '-z', '--diff-filter=U'], scratch));
    if (conflicts.length) {
      mergeConflict = true;
      conflictInfo = { files: conflicts, tip: from,
        stderrTail: stderrTail(merge) || cleanText(merge?.stdout).slice(-500) };
      event(root, { kind: 'overlay-main-merge-conflict', ref, files: conflicts }, { env });
      if (old.pr) markOverlayConflictWake(env, { pr: old.pr, ref, files: conflicts, at: now(), clone: root });
      else publishNeedsYou(root, env, ref, 'overlay-main-merge-conflict',
        `Merge conflicts on ${ref}: ${conflicts.join(', ')}`, { files: conflicts });
      output(git(['merge', '--abort'], scratch));
      throw Object.assign(new Error(`merge conflicts require operator resolution: ${conflicts.join(', ')}`),
        { step: 'merge', stderrTail: conflictInfo.stderrTail });
    }
    if (mergeError) throw mergeError;
    output(merge);
    const to = sha(git(['rev-parse', 'HEAD'], scratch));
    // Combined paths include merge resolutions, excluding changes inherited only from main.
    const conflictTouched = paths(git(['diff-tree', '--cc', '--name-only', '--no-commit-id', '-z', to], scratch));
    const files = paths(git(['ls-files', '-z'], scratch)), candidates = new Set(files);
    setStep('test-select');
    // Read all graph inputs first: the shared helper skips unreadable files; this caller refuses them.
    const contents = new Map(files.filter(isGraphSourceFile).map(f => [f, io.readFileSync(join(scratch, f), 'utf8')]));
    const reverse = buildReverseImportGraph({ files, readFile: f => contents.get(f) });
    const selected = new Set(own.filter(f => candidates.has(f) && isVitestTestFile(f)));
    for (const f of testDepths([...own, ...conflictTouched], reverse).keys()) if (candidates.has(f)) selected.add(f);
    if (!selected.size) return await skip('no-relevant-tests');
    // Own changed test files first, then dependents: the cap below must never drop the overlay's own tests.
    let tests = [...selected].sort((a, b) => (own.includes(b) ? 1 : 0) - (own.includes(a) ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0));
    io.appendFileSync(join(scratch, '.git', 'info', 'exclude'), '\n/node_modules\n');
    io.statSync(join(root, 'node_modules'));
    io.symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const frontier = resolve(root, '..', 'frontierui');
    // A real, clean clone, never a link: the Forge manifest refuses a symlinked or dirty sibling, so a link here
    // forced every scratch test run back onto the Mac. A local clone is cheap (hardlinked objects) and committed-only.
    if (io.existsSync(frontier)) output(git(['clone', '--quiet', '--local', frontier, join(scratchParent, 'frontierui')], scratchParent));
    setStep('test-select');
    // Discover tests in the environment they will run in: reuse the test run's own construction, never a copy.
    const { env: testEnv } = buildHeavyTestInvocation({ root, scratch, selected: [], testReport: join(scratchParent, 'inventory.json'), env, io });
    const runnable = await runnableTestFiles({ scratch, env: testEnv, runner: deps.testListRunner });
    const scratchReal = io.realpathSync(scratch);
    tests = tests.filter(file => runnable.has(join(scratchReal, file)));
    const filteredNotRunnable = selected.size - tests.length;
    // Related-only, capped: more than the fast-lane file cap per run is classified FULL by heavy-admission and
    // runs on the Mac. Never run a whole suite here; CI retests. Chunks stay within the fast cap.
    const cap = overlayRelatedTestCap(env), chunkSize = Math.min(50, resolveFastMaxFiles(env));
    // The overlay's own changed tests are never dropped; only dependents beyond the cap are.
    const ownCount = tests.filter(file => own.includes(file)).length;
    const droppedByCap = Math.max(0, tests.length - Math.max(cap, ownCount));
    if (droppedByCap) tests = tests.slice(0, Math.max(cap, ownCount));
    console.error(`overlay-main-sync test-select ref=${cleanText(ref)} selected: ${tests.length} filteredNotRunnable: ${filteredNotRunnable} related-only (no full suite; CI retests) cappedOut: ${droppedByCap}`);
    event(root, { kind: 'overlay-main-test-selection', ref, selected: tests.length, filteredNotRunnable }, { env });
    if (!tests.length) return await skip('no-relevant-tests');
    event(root, { kind: 'overlay-main-related-only', ref, files: tests.length, cappedOut: droppedByCap, unverifiedTests: droppedByCap > 0 }, { env });
    setStep('tests');
    const { value: reruns, source: rerunsSource } = resolveOverlayFlakeReruns(env);
    for (let offset = 0; offset < tests.length; offset += chunkSize) {
      const chunk = tests.slice(offset, offset + chunkSize);
      const check = (selected, attempt, tree = scratch, runner = deps.testRunner) => syncTestEvidence({
        root, scratch: tree, selected, env, io, runner,
        testReport: join(scratchParent, `tests-${offset / chunkSize}-${attempt}.json`) });
      let evidence = await check(chunk, 'initial');
      // The remote process may still be running: neither publication nor a local rerun is safe.
      if (evidence.remoteUnconfirmed) return await skip('remote-termination-unconfirmed');
      if (evidence.green) continue;
      if (!reruns || !evidence.complete || !evidence.failed.length) throw testFailure(evidence);
      const retried = [...evidence.failed];
      let remaining = retried, previous = evidence;
      // Coverage is always measured against the ORIGINAL failure, never the previous rerun: with several
      // reruns an assertion that vanished in rerun 1 would otherwise be forgotten by rerun 2.
      // A file is only checked on the rerun where it clears, and that single run must itself re-execute
      // every originally failed assertion (passes are not pooled across reruns: pooling over-credits twins).
      const original = evidence;
      for (let attempt = 0; attempt < reruns; attempt++) {
        evidence = await check(remaining, attempt);
        if (evidence.remoteUnconfirmed) return await skip('remote-termination-unconfirmed');
        // A file that stops failing must have re-executed what failed originally; otherwise it is no pass.
        const cleared = previous.failed.filter(file => !evidence.failed.includes(file) && evidence.byFile.has(file));
        if (cleared.length && !rerunCoversFailures(original, evidence, cleared)) throw testFailure(original);
        if (evidence.green && !cleared.length) throw testFailure(original);
        if (evidence.green || !evidence.complete || !evidence.failed.length) break;
        remaining = evidence.failed; previous = evidence;
      }
      if (evidence.green) {
        event(root, { kind: 'overlay-main-flaky-retried', ref, files: retried,
          flakeReruns: reruns, flakeRerunsSource: rerunsSource }, { env });
        continue;
      }
      let mainRed = false;
      try {
        const mainScratch = join(scratchParent, `main-${offset / chunkSize}`);
        output(git(['clone', '--shared', '--no-checkout', scratch, mainScratch]));
        output(git(['checkout', '--force', '--detach', main], mainScratch, [], { timeout: 300_000 }));
        io.appendFileSync(join(mainScratch, '.git', 'info', 'exclude'), '\n/node_modules\n');
        io.symlinkSync(join(root, 'node_modules'), join(mainScratch, 'node_modules'), 'dir');
        const comparison = await check(remaining, 'main', mainScratch, deps.mainTestRunner ?? null);
        // The remote process may still be running: do not classify, publish or fail on this evidence.
        if (comparison.remoteUnconfirmed) return await skip('remote-termination-unconfirmed');
        // Counted, so two same-titled overlay failures need two main failures (one cannot cover both).
        mainRed = evidence.complete && evidence.failedAssertions.length > 0
          && evidence.failedAssertions.every(identity => identity !== null)
          && comparison.complete && comparison.failedAssertions.every(identity => identity !== null)
          && coveredWithMultiplicity(evidence.failedAssertions, comparison.failedAssertions);
      } catch { /* Unknown main evidence must retain the ordinary operator-review failure. */ }
      setStep('tests');
      if (mainRed) {
        updateSyncState(sidecar(root, env), state => {
          state.mainRedMain[ref] = main; state.mainRedTip[ref] = from; state.mainRedAt[ref] = new Date(now()).getTime();
          clearRetry(state, ref);
        }, io);
        event(root, { kind: 'overlay-main-red', ref, files: remaining }, { env });
        return await skip('main-red');
      }
      throw testFailure(evidence);
    }
    setStep('verify');
    const current = readOverlayState(root, { env });
    if (current.corrupt || !isDeepStrictEqual(current.overlays.find(o => o.ref === ref), old)
      || io.readFileSync(lock, 'utf8') !== token
      || io.readFileSync(clone, 'utf8') !== cloneToken) throw new Error('overlay registration or marker changed');
    if (sha(git(['rev-parse', 'HEAD'], scratch)) !== to || output(git(['status', '--porcelain'], scratch)).trim()) throw new Error('candidate changed during tests');
    let push;
    publicationStarted = true;
    setStep('push');
    // A timeout may follow successful publication, so never retry a push here.
    try { push = (deps.git ?? executeGit)(['push', 'origin', `HEAD:refs/heads/${ref}`],
      { cwd: scratch, env: { ...env, ...REBUILD_IDENTITY_ENV } }); }
    catch (error) { push = { error }; }
    const file = sidecar(root, env);
    if (push?.status !== 0 || push.error) {
      updateSyncState(file, state => {
        state.pushRetryAfter[ref] = Date.now() + 10 * 60_000;
        state.pushRetryMain[ref] = main;
      }, io);
      const tail = stderrTail(push);
      const error = Object.assign(new Error(`push failed; retry in ten minutes: ${tail || 'push rejected or failed'}`),
        { step: 'push', stderrTail: tail });
      await failureEvent(error);
      failureAlert(root, env, ref, error, io);
      return { pushed: false };
    }
    setStep('state-publish');
    updateSyncState(file, state => {
      clearRetry(state, ref);
      delete state.firstFailureAt[ref]; delete state.failureAlertedAt[ref]; delete state.failureReason[ref];
      state.lastSyncedMain[ref] = main;
      delete state.pushRetryAfter[ref]; delete state.pushRetryMain[ref];
      delete state.conflictMain[ref]; delete state.conflictTip[ref];
      delete state.mainRedMain[ref]; delete state.mainRedTip[ref]; delete state.mainRedAt[ref];
    }, io);
    const diagnostic = failureMarker(root, env, ref);
    transaction(diagnostic, () => io.rmSync(diagnostic, { force: true }), io);
    event(root, { kind: 'overlay-main-synced', ref, from, to, tests }, { env });
    await outcome(root, env, ref, 'synced', { from, to, tests }, deps);
    return { pushed: true, ref, from, to, tests };
  } catch (cause) {
    if (cause.transientGit && !mergeConflict) return await skip('transient-git');
    const failedStep = cause.step ?? step;
    const message = cleanText(cause.message ?? cause);
    const error = Object.assign(new Error(message.startsWith(`${failedStep}: `) ? message : `${failedStep}: ${message}`),
      { step: failedStep, stderrTail: cause.stderrTail ?? '' });
    try {
      // Publication has its own retry path; conflicts require a human immediately.
      if (main && !publicationStarted) {
        updateSyncState(sidecar(root, env), state => {
          const tries = state.retryMain[ref] === main ? state.retryTries[ref] : 0;
          if (mergeConflict || tries >= RETRY_DELAYS.length) {
            state.attemptedMain[ref] = main;
            if (mergeConflict) { state.conflictMain[ref] = main; state.conflictTip[ref] = conflictInfo.tip; }
            clearRetry(state, ref);
          } else {
            state.retryMain[ref] = main;
            state.retryTries[ref] = tries + 1;
            state.retryAfter[ref] = Date.now() + RETRY_DELAYS[tries];
          }
        }, io);
      }
    } catch { /* The diagnostic below can keep an independent failure streak. */ }
    // One conflict event per (main, tip) pair replaces the repeating failed event; the wake / needs-you
    // rebase request was already raised once at detection above.
    if (mergeConflict) await outcome(root, env, ref, 'conflict', { step: 'merge', main, tip: conflictInfo.tip,
      files: conflictInfo.files, stderrTail: conflictInfo.stderrTail, reason: error.message }, deps);
    else await failureEvent(error);
    failureAlert(root, env, ref, error, io, mergeConflict); throw error;
  }
  finally {
    clearInterval(heartbeat);
    try { if (scratchParent) io.rmSync(scratchParent, { recursive: true, force: true }); }
    finally {
      try { release(lock, token, io); } finally { release(clone, cloneToken, io); }
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const option = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  runOverlayMainSync({ root: option('clone'), ref: option('ref'), token: option('token') })
    .catch(() => { process.exitCode = 1; });
}
