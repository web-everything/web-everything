/** Clean-only main merges into registered overlay tops, isolated from daemon working trees. */
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cascadePolicy } from '../policy-cascade.mjs';
import { readOverlayState, overlayFilePath, appendOverlayEvent, registrationIdentity } from '../daemon-overlays.mjs';
import { isSafeBranchName } from '../daemon-self-sync.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { feedPath, publishAttention } from '../../operations/needs-you-feed.mjs';
import { markOverlayConflictWake } from '../overlay-conflict-wake.mjs';
import { buildReverseImportGraph, testDepths, isVitestTestFile, isGraphSourceFile } from '../related-test-selection.mjs';
import { alertsFilePath } from './state.mjs';
import { REBUILD_IDENTITY_ENV } from './shared.mjs';
import { tryLease } from '../../operations/coordination-lock.mjs';
import { buildHeavyTestInvocation, runHeavyTests } from './auto-rebase.mjs';

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
const output = result => {
  if (result?.status !== 0 || result.error || typeof result.stdout !== 'string') {
    const step = result?.step ?? 'unknown', tail = stderrTail(result);
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
  let data;
  try {
    data = JSON.parse(io.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // One-time migration: the pre-rename state file (retry caps, cooldowns) is read when no new file exists yet.
    try { data = JSON.parse(io.readFileSync(file.replace(/\.state$/, '.json'), 'utf8')); }
    catch (legacy) { if (legacy.code === 'ENOENT') data = { lastSyncedMain: {} }; else throw legacy; }
  }
  if (!data || !Object.hasOwn(data, 'lastSyncedMain')) throw new Error('invalid main-sync state; operator repair required');
  for (const key of ['lastSyncedMain', 'attemptedMain', 'shadowMain', 'pushRetryMain', 'pushRetryAfter', 'errorAt', 'firstFailureAt', 'failureAlertedAt', 'failureReason', 'staleRef', 'staleRegistration', 'conflictMain', 'conflictTip', ...retryKeys]) {
    if (!Object.hasOwn(data, key)) data[key] = {};
    const map = data[key], timestamp = ['pushRetryAfter', 'errorAt', 'retryAfter', 'retryTries', 'firstFailureAt', 'failureAlertedAt', 'staleRef'].includes(key);
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
  const retryRefs = new Set(retryKeys.flatMap(key => Object.keys(data[key])));
  if ([...retryRefs].some(ref => retryKeys.some(key => !Object.hasOwn(data[key], ref)))) {
    throw new Error('incomplete main-sync retry state; operator repair required');
  }
  return data;
}
function writeSyncState(file, data, io) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { io.writeFileSync(temp, JSON.stringify(data)); io.renameSync(temp, file); }
  finally { io.rmSync(temp, { force: true }); }
}
const transactionWait = new Int32Array(new SharedArrayBuffer(4));
function transaction(file, fn, io = fs) {
  // The shared fence covers the entire callback, including read and rename. Even an
  // expired holder cannot resume a write after a successor has acquired the fence.
  for (let attempt = 0; attempt < 100; attempt++) {
    const lease = tryLease({ path: `${file}.lock`, owner: { pid: process.pid, host: hostname() },
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
      const pairKnown = synced.conflictMain[ref] === main && synced.conflictTip[ref] === tip;
      // A known conflicting (main, tip) pair is final: silent skip (its one conflict event was already emitted).
      if (pairKnown) {
        if (Object.hasOwn(synced.firstFailureAt, ref) && !Object.hasOwn(synced.failureAlertedAt, ref)) failureAlert(root, env, ref);
        result.skipped.push(ref); continue;
      }
      if (Object.hasOwn(synced.conflictMain, ref)) {
        // Either sha moved: forget the pair now, so the normal retry cap governs any later failure.
        const old = synced.conflictMain[ref];
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
    if (synced.conflictMain[ref] === main && synced.conflictTip[ref] === from) return await skip('conflict-known');
    const base = sha(git(['merge-base', main, from], scratch));
    const own = paths(git(['diff', '--name-only', '-z', base, from], scratch));
    let merge, mergeError;
    try {
      // The overlay may predate main's merge attributes. Keep the retry/diagnostic step as merge.
      merge = git(['merge', '--no-edit', 'origin/main'], scratch, ['--attr-source=origin/main']);
      if (merge.status === 129 && !merge.error
        && /^unknown option: --attr-source(?:=origin\/main)?\r?$/m.test(merge.stderr ?? '')) {
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
    const tests = [...selected].sort();
    io.appendFileSync(join(scratch, '.git', 'info', 'exclude'), '\n/node_modules\n');
    io.statSync(join(root, 'node_modules'));
    io.symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const frontier = resolve(root, '..', 'frontierui');
    // A real, clean clone, never a link: the Forge manifest refuses a symlinked or dirty sibling, so a link here
    // forced every scratch test run back onto the Mac. A local clone is cheap (hardlinked objects) and committed-only.
    if (io.existsSync(frontier)) output(git(['clone', '--quiet', '--local', frontier, join(scratchParent, 'frontierui')], scratchParent));
    setStep('tests');
    for (let offset = 0; offset < tests.length; offset += 50) {
      const chunk = tests.slice(offset, offset + 50);
      const reportFile = join(scratchParent, `tests-${offset / 50}.json`);
      const invocation = buildHeavyTestInvocation({ root, scratch, selected: chunk, testReport: reportFile, env, io });
      const result = await (deps.testRunner ?? (o => runHeavyTests(o, { io })))(invocation);
      // The remote process may still be running: neither publication nor a local rerun is safe.
      if (result?.status === 124 && typeof result.stderr === 'string'
        && result.stderr.includes('remote termination unconfirmed; refusing local rerun (exit 124).')) {
        return await skip('remote-termination-unconfirmed');
      }
      output({ ...result, step });
      if (io.statSync(reportFile).size > 8 * 1024 * 1024) throw new Error('test report over 8 MiB; operator review required');
      const report = JSON.parse(io.readFileSync(reportFile, 'utf8'));
      const results = report.testResults ?? [];
      const executed = new Set(results.filter(r => Array.isArray(r.assertionResults)
        && r.assertionResults.length && r.assertionResults.every(a => a.status === 'passed')).map(r => r.name));
      if (report.success === false || report.numFailedTests > 0 || report.numFailedTestSuites > 0 || results.some(r => r.status === 'failed'
        || !Array.isArray(r.assertionResults) || !r.assertionResults.length || r.assertionResults.some(a => a.status !== 'passed'))
        || chunk.some(f => !executed.has(join(io.realpathSync(scratch), f)))) {
        throw new Error('selected tests did not pass or execute; operator review required');
      }
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
