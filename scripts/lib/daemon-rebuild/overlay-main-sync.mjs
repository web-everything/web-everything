/** Clean-only main merges into registered overlay tops, isolated from daemon working trees. */
import * as fs from 'node:fs';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cascadePolicy } from '../policy-cascade.mjs';
import { readOverlayState, overlayFilePath, appendOverlayEvent } from '../daemon-overlays.mjs';
import { isSafeBranchName } from '../daemon-self-sync.mjs';
import { markOverlayConflictWake } from '../overlay-conflict-wake.mjs';
import { buildReverseImportGraph, testDepths, isVitestTestFile, isGraphSourceFile } from '../related-test-selection.mjs';
import { alertsFilePath } from './state.mjs';
import { REBUILD_IDENTITY_ENV } from './shared.mjs';
import { tryLease } from '../../operations/coordination-lock.mjs';

const SELF = fileURLToPath(import.meta.url), SETTINGS = join(dirname(SELF), '../daemon-rebuild-settings.json');
const validMode = mode => ['off', 'shadow', 'on'].includes(mode);
const sidecar = (root, env) => `${overlayFilePath(root, env)}.main-sync.json`;
const marker = (root, env, ref) => join(`${overlayFilePath(root, env)}.auto-rebase`, `${encodeURIComponent(ref)}.lock`);
const executeGit = (args, opts) => spawnSync('git', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...opts });
const output = result => {
  if (result?.status !== 0 || result.error || typeof result.stdout !== 'string') throw new Error('command failed or incomplete; operator review required');
  return result.stdout;
};
const paths = result => output(result).split('\0').filter(Boolean);
const sha = result => {
  const value = output(result).trim();
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('invalid Git SHA; operator review required');
  return value;
};
function readSyncState(file, io = fs) {
  let data;
  try {
    data = JSON.parse(io.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') data = { lastSyncedMain: {} }; else throw error; }
  if (!data || !Object.hasOwn(data, 'lastSyncedMain')) throw new Error('invalid main-sync state; operator repair required');
  for (const key of ['lastSyncedMain', 'attemptedMain', 'shadowMain', 'pushRetryMain', 'pushRetryAfter', 'errorAt']) {
    if (!Object.hasOwn(data, key)) data[key] = {};
    const map = data[key], timestamp = key === 'pushRetryAfter' || key === 'errorAt';
    if (!map || typeof map !== 'object' || Array.isArray(map) || Object.values(map).some(v => timestamp
      ? !Number.isSafeInteger(v) || v < 0 : typeof v !== 'string' || !/^[a-f0-9]{40}$/.test(v))) throw new Error('invalid main-sync state; operator repair required');
  }
  if (Object.keys(data.pushRetryAfter).some(ref => !data.pushRetryMain[ref])) throw new Error('incomplete push retry state; operator repair required');
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
function needsYou(root, env, ref, error, io = fs) {
  const detail = { ref, reason: String(error?.message ?? error).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1000) };
  const file = alertsFilePath(root, env);
  io.mkdirSync(dirname(file), { recursive: true });
  io.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), kind: 'overlay-main-sync-needs-you', detail })}\n`);
}
const alertFallback = new Map(), ALERT_INTERVAL = 60 * 60_000;
function rateLimitedAlert(root, env, ref, error, io = fs) {
  // Keep diagnostics independent of the state they diagnose, including malformed JSON.
  const file = join(`${alertsFilePath(root, env)}.main-sync`, `${createHash('sha256').update(ref).digest('hex')}.json`);
  const at = Date.now();
  const recent = time => Number.isFinite(time) && at >= time && at - time < ALERT_INTERVAL;
  for (const [key, time] of alertFallback) if (!recent(time)) alertFallback.delete(key);
  if (recent(alertFallback.get(file))) return;
  let emitted = false, lastAlertAt = at;
  try {
    transaction(file, () => {
      let previous;
      try { previous = JSON.parse(io.readFileSync(file, 'utf8')).at; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (recent(previous)) { lastAlertAt = previous; return; }
      needsYou(root, env, ref, error, io);
      emitted = true;
      writeSyncState(file, { at }, io);
    }, io);
  } catch (markerError) {
    if (markerError.code === 'MAIN_SYNC_STATE_BUSY') return; // Another process owns this diagnostic; retry next tick.
    // If the diagnostic marker itself is unavailable, a long-lived health-watch
    // still emits at most once an hour. Keep the original actionable error.
    if (!emitted) needsYou(root, env, ref, error, io);
    emitted = true;
  }
  alertFallback.set(file, lastAlertAt);
  if (emitted) {
    try { updateSyncState(sidecar(root, env), state => { state.errorAt[ref] = at; }, io); }
    catch { /* The independent marker remains authoritative when state is unreadable/busy. */ }
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
export function kickOverlayMainSync({ root, env = process.env, mode, spawnFn = spawn, git = executeGit }) {
  mode ??= resolveOverlayMainSyncMode(env).mode;
  if (!validMode(mode)) throw new Error('invalid overlay main sync mode');
  const result = { started: [], skipped: [], would: [] };
  if (mode === 'off') return result;
  const run = args => git(args, { cwd: root, env });
  for (const ref of selectSyncTargets(readOverlayState(root, { env }))) {
    let token;
    const lock = marker(root, env, ref);
    const alert = error => rateLimitedAlert(root, env, ref, error);
    try {
      if (!isSafeBranchName(ref)) throw new Error('unsafe overlay ref');
      token = acquire(lock);
      if (!token) { result.skipped.push(ref); continue; }
      const synced = readSyncState(sidecar(root, env));
      if (Date.now() < (synced.pushRetryAfter[ref] ?? 0)) { result.skipped.push(ref); continue; }
      output(run(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', `+refs/heads/${ref}:refs/remotes/origin/${ref}`]));
      const main = sha(run(['rev-parse', 'origin/main']));
      const last = synced.lastSyncedMain[ref];
      if (last === main || synced.attemptedMain[ref] === main || (mode === 'shadow' && synced.shadowMain[ref] === main)) {
        result.skipped.push(ref); continue;
      }
      const base = last ?? sha(run(['merge-base', 'origin/main', `origin/${ref}`]));
      const changed = new Set(paths(run(['diff', '--name-only', '-z', base, main])));
      if (!paths(run(['diff', '--name-only', '-z', `origin/main...origin/${ref}`])).some(f => changed.has(f))) {
        result.skipped.push(ref); continue;
      }
      if (mode === 'shadow') {
        updateSyncState(sidecar(root, env), state => { state.shadowMain[ref] = main; });
        console.error(`overlay-main-sync would merge main into ${ref}`);
        appendOverlayEvent(root, { kind: 'overlay-main-sync-shadow', ref }, { env });
        result.would.push(ref); continue;
      }
      const owner = token;
      const child = spawnFn(process.execPath, [SELF, `--clone=${root}`, `--ref=${ref}`, `--token=${owner}`],
        { cwd: root, env, detached: true, stdio: 'ignore' });
      child.once?.('error', error => { alert(error); release(lock, owner); });
      child.unref(); result.started.push(ref); token = null;
    } catch (error) { alert(error); result.skipped.push(ref); }
    finally { release(lock, token); }
  }
  return result;
}
const runTests = ({ root, args, env }) => new Promise(resolveResult => {
  execFile(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 },
    (error, stdout, stderr) => resolveResult({ status: error ? 1 : 0, error, stdout, stderr }));
});
export async function runOverlayMainSync({ root, ref, token, env = process.env, deps = {} }) {
  const io = deps.io ?? fs, event = deps.appendOverlayEvent ?? appendOverlayEvent;
  const now = deps.now ?? (() => new Date().toISOString());
  const git = (args, cwd = root) => (deps.git ?? executeGit)(args, { cwd, env: { ...env, ...REBUILD_IDENTITY_ENV } });
  const lock = marker(root, env, ref);
  let scratchParent, heartbeat, main, publicationStarted = false;
  try {
    if (!isSafeBranchName(ref)) throw new Error('unsafe overlay ref');
    readSyncState(sidecar(root, env), io);
    main = sha(git(['rev-parse', 'origin/main']));
    if (token) { if (io.readFileSync(lock, 'utf8') !== token) throw new Error('marker ownership lost'); }
    else { token = acquire(lock, io); if (!token) return; }
    heartbeat = setInterval(() => {
      try { if (io.readFileSync(lock, 'utf8') === token) { const date = new Date(); io.utimesSync(lock, date, date); } }
      catch { /* ownership is checked again before push */ }
    }, deps.heartbeatMs ?? 60_000);
    heartbeat.unref();
    const state = readOverlayState(root, { env }), old = state.overlays.find(o => o.ref === ref);
    if (state.corrupt || !old || !selectSyncTargets(state).includes(ref)) throw new Error('overlay registration unavailable');
    scratchParent = io.mkdtempSync(join(env.TMPDIR || tmpdir(), 'we-overlay-main-sync-'));
    const scratch = join(scratchParent, 'repo');
    const url = output(git(['remote', 'get-url', 'origin'])).trim();
    const origin = isAbsolute(url) || url.includes(':') || url.startsWith('~') ? url : resolve(root, url);
    output(git(['clone', '--shared', '--no-checkout', root, scratch]));
    output(git(['remote', 'set-url', 'origin', origin], scratch));
    output(git(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', `+refs/heads/${ref}:refs/remotes/origin/${ref}`], scratch));
    output(git(['checkout', '-b', ref, `origin/${ref}`], scratch));
    const from = sha(git(['rev-parse', 'HEAD'], scratch));
    main = sha(git(['rev-parse', 'origin/main'], scratch));
    const base = sha(git(['merge-base', main, from], scratch));
    const own = paths(git(['diff', '--name-only', '-z', base, from], scratch));
    const mainFiles = new Set(paths(git(['diff', '--name-only', '-z', base, main], scratch)));
    const merge = git(['merge', '--no-edit', 'origin/main'], scratch);
    const conflicts = paths(git(['diff', '--name-only', '-z', '--diff-filter=U'], scratch));
    if (conflicts.length) {
      output(git(['merge', '--abort'], scratch));
      event(root, { kind: 'overlay-main-merge-conflict', ref, files: conflicts }, { env });
      if (old.pr) markOverlayConflictWake(env, { pr: old.pr, ref, files: conflicts, at: now(), clone: root });
      throw new Error(`merge conflicts require operator resolution: ${conflicts.join(', ')}`);
    }
    output(merge);
    const to = sha(git(['rev-parse', 'HEAD'], scratch));
    const files = paths(git(['ls-files', '-z'], scratch)), candidates = new Set(files);
    // Read all graph inputs first: the shared helper skips unreadable files; this caller refuses them.
    const contents = new Map(files.filter(isGraphSourceFile).map(f => [f, io.readFileSync(join(scratch, f), 'utf8')]));
    const reverse = buildReverseImportGraph({ files, readFile: f => contents.get(f) });
    const selected = new Set(own.filter(f => candidates.has(f) && isVitestTestFile(f)));
    for (const f of testDepths(own.filter(f => mainFiles.has(f)), reverse).keys()) selected.add(f);
    const tests = [...selected].sort();
    if (tests.length > 100) throw new Error('test selection over 100; operator review required');
    if (!tests.length) throw new Error('test selection empty; operator review required');
    io.appendFileSync(join(scratch, '.git', 'info', 'exclude'), '\n/node_modules\n');
    io.statSync(join(root, 'node_modules'));
    io.symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const frontier = resolve(root, '..', 'frontierui');
    if (io.existsSync(frontier)) io.symlinkSync(frontier, join(scratchParent, 'frontierui'), 'dir');
    const reportFile = join(scratchParent, 'tests.json');
    const args = ['scripts/readiness/heavy-admission.mjs', 'run', '--wait-ms=540000', '--', 'npx', 'vitest', 'run', ...tests,
      '--reporter=default', '--reporter=json', `--outputFile.json=${reportFile}`];
    output(await (deps.testRunner ?? runTests)({ root: scratch, args, env }));
    if (io.statSync(reportFile).size > 8 * 1024 * 1024) throw new Error('test report over 8 MiB; operator review required');
    const report = JSON.parse(io.readFileSync(reportFile, 'utf8'));
    const executed = new Set((report.testResults ?? []).filter(r => Array.isArray(r.assertionResults)
      && r.assertionResults.length && r.assertionResults.every(a => a.status === 'passed')).map(r => r.name));
    if (tests.some(f => !executed.has(join(io.realpathSync(scratch), f)))) throw new Error('selected tests did not pass or execute; operator review required');
    const current = readOverlayState(root, { env });
    if (current.corrupt || !isDeepStrictEqual(current.overlays.find(o => o.ref === ref), old)
      || io.readFileSync(lock, 'utf8') !== token) throw new Error('overlay registration or marker changed');
    if (sha(git(['rev-parse', 'HEAD'], scratch)) !== to || output(git(['status', '--porcelain'], scratch)).trim()) throw new Error('candidate changed during tests');
    let push;
    publicationStarted = true;
    try { push = git(['push', 'origin', `HEAD:refs/heads/${ref}`], scratch); }
    catch (error) { push = { error }; }
    const file = sidecar(root, env);
    if (push?.status !== 0 || push.error) {
      updateSyncState(file, state => {
        state.pushRetryAfter[ref] = Date.now() + 10 * 60_000;
        state.pushRetryMain[ref] = main;
      }, io);
      const reason = String(push?.stderr || push?.error?.message || 'push rejected or failed');
      rateLimitedAlert(root, env, ref, new Error(`push failed; retry in ten minutes: ${reason}`), io);
      return { pushed: false };
    }
    updateSyncState(file, state => {
      state.lastSyncedMain[ref] = main;
      delete state.pushRetryAfter[ref]; delete state.pushRetryMain[ref];
    }, io);
    event(root, { kind: 'overlay-main-synced', ref, from, to, tests }, { env });
    return { pushed: true, ref, from, to, tests };
  } catch (error) {
    try {
      // A state-lock/write failure after attempting publication must remain retryable;
      // attemptedMain is reserved for merge/test failures requiring a new main.
      if (main && !publicationStarted) {
        updateSyncState(sidecar(root, env), state => { state.attemptedMain[ref] = main; }, io);
      }
    } catch { /* The diagnostic below uses its own rate-limit marker. */ }
    rateLimitedAlert(root, env, ref, error, io); throw error;
  }
  finally {
    clearInterval(heartbeat);
    try { if (scratchParent) io.rmSync(scratchParent, { recursive: true, force: true }); }
    finally { release(lock, token, io); }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const option = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  runOverlayMainSync({ root: option('clone'), ref: option('ref'), token: option('token') })
    .catch(() => { process.exitCode = 1; });
}
