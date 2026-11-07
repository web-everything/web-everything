/**
 * Restart an explicit, reviewed allowlist of stateless launchd services after adoption; all host IO has
 * injectable seams. Which services restart is decided by LABEL alone (policy `daemon.serviceRestart.allowedLabels`):
 * a plist's command line, arguments, shell string and wrappers are never read to infer ownership.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fsAsync from 'node:fs/promises';
import childProcess from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { cascadePolicy } from './policy-cascade.mjs';
import { randomBytes } from 'node:crypto';
import { lockDirFor, makeLockEntry, parseLockEntry, releaseLockDirIf } from '../readiness/file-locks.mjs';
import { probePidLiveness } from '../readiness/pid-liveness.mjs';
import { readRebuildState } from './daemon-rebuild/state.mjs';

const commandOptions = { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 };
const message = e => String(e?.message ?? e);
const safeLog = (log, line) => { try { (typeof log === 'function' ? log : log?.error?.bind(log))?.(line.replace(/[\x00-\x1f\x7f]/g, ' ')); } catch { /* logging cannot fail a tick */ } };
const runHost = (command, argv) => new Promise((ok, fail) => childProcess.execFile(command, argv, commandOptions,
  (error, stdout, stderr) => error ? fail(error) : ok({ stdout, stderr, status: 0 })));
const readHostPlistAsync = async path => JSON.parse((await runHost('plutil', ['-convert', 'json', '-o', '-', path])).stdout);
const launchHost = argv => runHost('launchctl', argv);
const printHost = argv => execFileSync('launchctl', argv, commandOptions);
const userId = () => process.getuid();

function assertActive(signal) {
  if (signal?.aborted) throw new Error('service restart cancelled: inspect LaunchAgents before retrying');
}

// Per-label files survive adopting-daemon exits. Unknown/corrupt state refuses the restart.
const diskState = {
  path: label => join(homedir(), '.claude', 'launchd-code-restart', `${encodeURIComponent(label)}.json`),
  async get(label) {
    try { return JSON.parse(await fsAsync.readFile(this.path(label), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  },
  async set(label, value) {
    const path = this.path(label), temp = `${path}.${process.pid}.tmp`;
    await fsAsync.mkdir(join(homedir(), '.claude', 'launchd-code-restart'), { recursive: true });
    await fsAsync.writeFile(temp, JSON.stringify(value)); await fsAsync.rename(temp, path);
  },
  // Labels whose restart was skipped by the cooldown and still owed: [{ label, at, sha, pendingSha }].
  // Cheap (one small directory listing) so every tick can ask; unreadable entries are ignored here and
  // surface through the normal `get` path when that label is next adopted.
  async pending() {
    const dir = join(homedir(), '.claude', 'launchd-code-restart');
    let files;
    try { files = await fsAsync.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const state = JSON.parse(await fsAsync.readFile(join(dir, file), 'utf8'));
        // A marker we cannot act on (no cooldown anchor / sha) would spam every tick: ignore it here.
        if (typeof state?.pendingSha === 'string' && state.pendingSha && Number.isFinite(state.at)
          && typeof state.sha === 'string' && state.sha) out.push({ label: decodeURIComponent(file.slice(0, -5)), ...state });
      } catch { /* not a pending marker we can read */ }
    }
    return out;
  },
};
// Use the shared lock identity/entry format, with async exclusive mkdir so a slow
// filesystem cannot block the adopter's timeout. A held lock is NEVER expired by age: a paused
// holder can resume and still kickstart. The only reclaim is of a lock whose recorded owner pid is
// PROVEN dead (ESRCH / zombie, via probePidLiveness; pid reuse or any doubt reads as alive and keeps
// the lock). The proof is re-checked against the exact entry judged (releaseLockDirIf), so a
// contender cannot remove a lock a faster reclaimer just took. Anything else stays blocked and
// surfaces as a restart-lock-held flag.
// @test-only-export-ok: test seam for the real disk lock (root dir and liveness probe are injectable); production uses `diskLocks`.
export function createDiskLocks({ root: rootOpt, liveness = probePidLiveness, pid = process.pid } = {}) {
  return {
    async acquire(label) {
      const root = rootOpt ?? join(homedir(), '.claude', 'launchd-code-restart', 'locks');
      const key = `launchd-code-restart:${label}`, dir = lockDirFor(root, key);
      await fsAsync.mkdir(root, { recursive: true });
      // The lock dir appears already holding its lock.json: it is built in a private sibling and renamed into
      // place, which POSIX refuses (ENOTEMPTY/EEXIST) when the target exists. So an entry-less lock dir (a
      // crash between mkdir and the metadata write) can never exist, and every held lock names its owner.
      const win = async () => {
        const nonce = randomBytes(6).toString('hex');
        const entry = makeLockEntry(`launchd-code-restart:${pid}:${nonce}`, label, new Date().toISOString(), pid);
        const staging = join(root, `.staging-${pid}-${nonce}`);
        await fsAsync.mkdir(staging);
        try {
          await fsAsync.writeFile(join(staging, 'lock.json'), JSON.stringify(entry), { flag: 'wx' });
          await fsAsync.rename(staging, dir);
          return true;
        } catch (error) {
          await fsAsync.rm(staging, { recursive: true, force: true }).catch(() => {});
          if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') return false;
          throw error;
        }
      };
      if (!(await win())) {
        let held = null;
        try { held = parseLockEntry(await fsAsync.readFile(join(dir, 'lock.json'), 'utf8')); } catch { /* unreadable: fail closed */ }
        // Unreadable, pid-less, own-pid or not-provably-dead owners all keep the lock.
        if (!held || liveness(held.pid, pid) !== 'dead') return null;
        if (!releaseLockDirIf(root, key, held) || !(await win())) return null;
      }
      return async () => { await fsAsync.rm(dir, { recursive: true }); };
    },
  };
}
const diskLocks = createDiskLocks();
const inFlight = new Set();

// The reviewed allowlist is EXACT labels (no globs): a label names one service, nothing is matched by prefix.
// Labels go into a launchctl service target, so keep them to a plain launchd-label alphabet (no "/", spaces, "*").
// Bounded: a label becomes a state-file name (255-byte limit), and labels differing only by case would share
// one state file on a case-insensitive volume, so the list is capped and must be unique ignoring case.
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LABEL = 128, MAX_ALLOWED = 64;
const labels = value => Array.isArray(value) && value.length <= MAX_ALLOWED
  && value.every(x => typeof x === 'string' && x.length <= MAX_LABEL && LABEL.test(x))
  && new Set(value.map(x => x.toLowerCase())).size === value.length;
const defaults = { enabled: true,
  // Namespace membership alone does not establish that a service is stateless: every entry is reviewed by hand.
  allowedLabels: ['com.we.resource-sampler'], minIntervalMs: 600_000 };
// Labels under these namespaces are named in the log when they are NOT on the allowlist, so a missing entry is visible.
const MANAGED_NAMESPACE = /^com\.(?:we|webeverything)\./;
const MAX_NAMED = 20;
// The not-allowlisted listing is informational and runs AFTER the restarts, so it is bounded: at most this many
// plists and this much wall time (a hung plutil costs one 5s timeout, never the restart).
const MAX_SCANNED_PLISTS = 200, SCAN_BUDGET_MS = 3000;

// Kill-switch parsing is case/whitespace-insensitive and FAILS CLOSED: an operator who set the variable
// meant to stop restarts, so any non-empty value that is not a recognised "enable" word disables them.
const ENABLE_WORDS = new Set(['true', '1', 'yes', 'on']);
function parseKillSwitch(raw) {
  if (raw === undefined || raw === null) return undefined;
  const word = String(raw).trim().toLowerCase();
  return word === '' ? undefined : ENABLE_WORDS.has(word);
}

// One policy for both restart and stale detection, so detection never alerts on a service
// that policy intentionally leaves alone.
function resolveRestartPolicy({ settings, platform, env, envValues, log }) {
  const values = envValues ?? {
    enabled: parseKillSwitch(env.WE_DAEMON_SERVICE_RESTART_ENABLED),
    // Blank is "unset", not 0 (Number('') === 0 would silently disable the debounce).
    minIntervalMs: String(env.WE_DAEMON_SERVICE_RESTART_MIN_INTERVAL_MS ?? '').trim() === '' ? undefined : Number(env.WE_DAEMON_SERVICE_RESTART_MIN_INTERVAL_MS),
  };
  return cascadePolicy('daemon.serviceRestart', settings, { standard: defaults, platform, env, envValues: values,
    valid: { enabled: v => typeof v === 'boolean', allowedLabels: labels,
      minIntervalMs: v => Number.isFinite(v) && v >= 0 }, log: line => safeLog(log, line) });
}
// Why policy never restarts this label (null when it is restartable). Decided by the label ONLY, never by argv.
// Independent of `enabled`. The name guard keeps a dev server out even if one were ever listed by mistake.
const neverRestartReason = (label, p) =>
  /dev|vite|storybook|playground|npm-start/i.test(label) ? 'built-in-never'
  : !p.allowedLabels.includes(label) ? 'not-allowlisted' : null;

// Labels of managed-namespace LaunchAgents that are not on the allowlist (label read only; nothing else in a plist is looked at).
// Informational: never throws on abort (it just stops), skips entries past the bounds, and counts anything it cannot
// use (unreadable plist, over-long or malformed label, scan cut short) as `unreadable` so the log line says so.
async function unlistedLabels({ agentsDir = join(homedir(), 'Library', 'LaunchAgents'), readPlist = readHostPlistAsync,
  listPlists = dir => fsAsync.readdir(dir), allowed, selfLabel, signal, now }) {
  const named = [], started = now();
  let unreadable = 0, files, scanned = 0;
  try { files = await listPlists(agentsDir); } catch { return { named, unreadable: 1 }; }
  for (const file of files) {
    if (signal?.aborted) break;
    if (!file.endsWith('.plist')) continue;
    if (scanned >= MAX_SCANNED_PLISTS || now() - started >= SCAN_BUDGET_MS) { unreadable += 1; break; }
    scanned += 1;
    try {
      const label = (await readPlist(resolve(agentsDir, file)))?.Label;
      if (typeof label !== 'string' || !MANAGED_NAMESPACE.test(label)) continue;
      if (label.length > MAX_LABEL || !LABEL.test(label)) { unreadable += 1; continue; }
      if (!allowed.includes(label) && label !== selfLabel && !named.includes(label)) named.push(label);
    } catch { unreadable += 1; }
  }
  return { named, unreadable };
}

export async function restartServicesForClone({ settings, platform, env = process.env, envValues,
  launchctl = launchHost, uid = userId, log = console, now = Date.now, stateStore = diskState, lockStore = diskLocks,
  adoptedSha: adoptedShaOpt, signal, pendingOnly = false, selfLabel = null, ...options } = {}) {
  const result = { restarted: [], skipped: [], flagged: [], errors: [] };
  let source = 'unresolved';
  let adoptedSha = adoptedShaOpt;
  // pendingOnly (later ticks): retry only the labels whose restart a cooldown deferred. Each owes the sha it
  // was deferred for; nothing is inspected when none is owed, and a label that no longer qualifies is cleared.
  let owed = null;
  // Clear an owed marker without rolling back a restart another process recorded since we listed it:
  // re-read first and only write when the marker we listed is still the one on disk.
  // The read-then-write must not interleave with a restart recording newer state, so it runs under the
  // label lock: callers already holding it pass `held`; others take it here and, if it is busy, leave the
  // marker in place (still owed; the next tick retries).
  const settle = async (label, previous, held = false) => {
    let release = null;
    if (!held) {
      release = await lockStore.acquire(label);
      if (release === null) return;
      if (typeof release !== 'function') throw new Error('unreadable restart lock acquisition result');
    }
    try {
      const fresh = await stateStore.get(label);
      // Compare-and-delete: remove only the marker this restart consumed. Owner (clone), sha, cooldown
      // anchor and generation must all match, so a marker another clone (or a later deferral) wrote since
      // our read survives, even when it owes the same sha from the same anchor.
      if (fresh && fresh.pendingSha !== undefined && fresh.pendingSha === previous.pendingSha && fresh.at === previous.at
        && fresh.pendingRoot === previous.pendingRoot && fresh.pendingGen === previous.pendingGen) {
        await stateStore.set(label, { at: fresh.at, sha: fresh.sha });
      }
    } finally {
      if (release) await release();
    }
  };
  const report = (kind, service, reason) => {
    const entry = { ...service, reason };
    result[kind].push(entry);
    safeLog(log, `daemon.serviceRestart ${kind} ${service.label ?? '?'}: ${reason} (source ${source})`);
  };
  try {
    // State is keyed by label, shared by every clone's daemon: a marker belongs to the clone that deferred it.
    if (pendingOnly) {
      owed = new Map(((await stateStore.pending?.()) ?? []).filter(x => x.pendingRoot === options.cloneRoot).map(x => [x.label, x]));
      if (!owed.size) return result;
    }
    const policy = resolveRestartPolicy({ settings, platform, env, envValues, log });
    source = JSON.stringify({ values: policy.value, sources: policy.sources });
    if (owed) {
      // Inside the cooldown there is nothing to do until one is due.
      const current = now();
      owed = new Map([...owed].filter(([, x]) => !(current - x.at < policy.value.minIntervalMs)));
      if (!owed.size) return result;
    }
    const p = policy.value;
    for (const label of owed ? owed.keys() : new Set(p.allowedLabels)) {
      const service = { label };
      // A deferred restart owes the sha it was deferred for, not the (possibly absent) current adoption.
      if (owed) adoptedSha = owed.get(label).pendingSha;
      let reason = label === selfLabel ? 'self' : !p.enabled ? 'disabled' : neverRestartReason(label, p);
      if (reason) {
        if (owed) { try { await settle(label, owed.get(label)); } catch (error) { report('errors', service, message(error)); } continue; }
        report('skipped', service, reason); continue;
      }
      if (inFlight.has(label)) { report('skipped', service, 'restart-in-flight'); continue; }
      inFlight.add(label);
      let phase = 'lock', releaseLock;
      try {
        assertActive(signal);
        releaseLock = await lockStore.acquire(label);
        if (releaseLock === null) {
          if (owed) continue; // still owed; the next tick retries without repeating the lock alarm
          report('skipped', service, 'restart-lock-held');
          report('flagged', service, 'restart-lock-held: inspect the lock owner if contention persists; remove an abandoned marker only after confirming its owner exited');
          continue;
        }
        if (typeof releaseLock !== 'function') throw new Error('unreadable restart lock acquisition result');
        assertActive(signal);
        phase = 'state';
        const previous = await stateStore.get(label), at = now();
        if (!Number.isFinite(at)) throw new Error('unreadable clock');
        if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous)
          || !Number.isFinite(previous.at) || previous.at < 0 || typeof previous.sha !== 'string' || !previous.sha.trim())) {
          throw new Error('unreadable restart state: inspect persisted state');
        }
        // An owed retry was planned from a listing made before the lock: trust only what is on disk now.
        // Cleared, taken by another clone, or replaced by a newer sha => follow the marker, never the listing.
        if (owed) {
          if (!previous || previous.pendingSha === undefined || previous.pendingRoot !== options.cloneRoot) continue;
          adoptedSha = previous.pendingSha;
        }
        if (typeof adoptedSha !== 'string' || !adoptedSha.trim()) throw new Error('unknown adopted sha: inspect rebuild state');
        reason = previous && adoptedSha && previous.sha === adoptedSha ? 'same-adopted-sha'
          : previous && at - previous.at < p.minIntervalMs ? 'debounced' : null;
        if (reason === 'debounced') {
          // Remember the restart we owe: a later tick retries it once the cooldown has passed.
          // A newer adoption simply replaces the owed sha; a successful restart clears it.
          // Each deferral gets its own generation, so cleanup can tell this marker from a later rewrite.
          // The state holds one marker per label: never overwrite another clone's owed restart. Say so instead.
          const foreign = previous.pendingSha !== undefined && previous.pendingRoot !== undefined && previous.pendingRoot !== options.cloneRoot;
          if (!owed && !foreign) await stateStore.set(label, { ...previous, pendingSha: adoptedSha, pendingRoot: options.cloneRoot, pendingGen: randomBytes(6).toString('hex') });
          if (!owed) report('skipped', service, reason);
          if (!owed && foreign) report('flagged', service, 'restart-owed-by-other-clone: another clone already owes this label a restart; inspect and restart the service by hand if it is not retried');
          continue;
        }
        if (reason) {
          // Already running the adopted sha (e.g. A, B deferred, then back to A): nothing is owed any more.
          // Only this clone's own marker: another clone's owed restart is not consumed by our same-sha skip.
          if (previous.pendingSha !== undefined && (previous.pendingRoot === undefined || previous.pendingRoot === options.cloneRoot)) await settle(label, previous, true);
          if (!owed) report('skipped', service, reason);
          continue;
        }
        const id = typeof uid === 'function' ? uid() : uid;
        if (!Number.isInteger(id) || id < 0) throw new Error('unreadable uid');
        // Record intent BEFORE kickstart: process death or launchctl failure must not
        // erase the cooldown. A failed write refuses the restart and requires inspection.
        // The state holds one marker per label: another clone's owed restart rides through our successful
        // restart untouched (only a marker this clone owns, or a legacy rootless one, is consumed here).
        const carried = previous?.pendingSha !== undefined && previous.pendingRoot !== undefined && previous.pendingRoot !== options.cloneRoot
          ? { pendingSha: previous.pendingSha, pendingRoot: previous.pendingRoot, pendingGen: previous.pendingGen } : {};
        await stateStore.set(label, { at, sha: adoptedSha, ...carried });
        phase = 'launch';
        assertActive(signal);
        // No mid-write signal exists. kickstart -k is the operator's proven operation for
        // these stateless samplers; the reviewed label allowlist safeguards writers.
        const answer = await launchctl(['kickstart', '-k', `gui/${id}/${label}`]);
        if (answer?.error || answer?.status != null && answer.status !== 0 || answer?.code != null && answer.code !== 0) throw new Error(message(answer.error ?? answer.stderr ?? 'launchctl failed'));
        report('restarted', service, 'kickstart -k');
      } catch (error) {
        if (phase === 'lock') report('flagged', service, `restart-lock-failed: inspect the per-label lock and its owner before retrying; ${message(error)}`);
        if (phase === 'state') report('flagged', service, `restart-state-failed: inspect persisted state before retrying; ${message(error)}`);
        report('errors', service, phase === 'launch' ? `${message(error)}; intent retained, inspect service before retrying` : message(error));
      }
      finally {
        try { if (typeof releaseLock === 'function') await releaseLock(); }
        catch (error) {
          report('flagged', service, `restart-lock-release-failed: inspect lock ownership before removing the marker; ${message(error)}`);
          report('errors', service, message(error));
        }
        inFlight.delete(label);
      }
    }
    // Services that are not on the allowlist are never restarted. One line names them so a missing entry is visible.
    // It runs AFTER the restarts and is bounded, so a slow or oversized LaunchAgents directory can never delay one.
    if (!pendingOnly) {
      const { named, unreadable } = await unlistedLabels({ ...options, allowed: p.allowedLabels, selfLabel, signal, now });
      for (const label of named.slice(0, MAX_NAMED)) result.skipped.push({ label, reason: 'not-allowlisted' });
      if (named.length || unreadable) {
        safeLog(log, `daemon.serviceRestart not-allowlisted: ${named.length ? `${named.slice(0, MAX_NAMED).join(', ')}${named.length > MAX_NAMED ? `, +${named.length - MAX_NAMED} more` : ''}` : 'none named'}`
          + `${unreadable ? ` (${unreadable} LaunchAgent entr${unreadable === 1 ? 'y' : 'ies'} unreadable, invalid or past the scan bound)` : ''}: never restarted; `
          + `add the label to daemon.serviceRestart.allowedLabels to restart it (allowedLabels source ${policy.sources?.allowedLabels ?? 'unknown'})`);
      }
    }
  } catch (error) { report('errors', {}, message(error)); }
  return result;
}

function processStart(label, { launchctl, uid, ps }) {
  let printed;
  try { printed = launchctl(['print', `gui/${typeof uid === 'function' ? uid() : uid}/${label}`]); }
  catch (e) {
    if (/could not find service/i.test(String(e.stderr ?? e.message))) return null;
    throw e;
  }
  if (printed?.status && printed.status !== 0) throw new Error('launchctl print failed');
  const output = typeof printed === 'string' ? printed : printed?.stdout;
  if (typeof output !== 'string') throw new Error('unreadable launchctl print');
  const pid = output.match(/\bpid\s*=\s*(\d+)/)?.[1];
  if (!pid) {
    if (/state\s*=\s*(?:not running|waiting|exited)/i.test(output)) return null;
    throw new Error('unknown launchctl process state');
  }
  const start = Date.parse(ps(['-o', 'lstart=', '-p', pid]).trim());
  if (!Number.isFinite(start)) throw new Error('unreadable process start');
  return start;
}

/** null process start means positively not running; unknown evidence is flagged.
 * Inspects exactly the allowlisted labels (the services policy restarts), never a plist's command line.
 * onFreshService reports positive clean evidence so health episodes can close without treating absence as clean. */
// The allowlisted services are host-wide, but adoption is per clone: a clone that adopted the same build another
// clone already restarted the service for never restarts it again (same-adopted-sha), so its own adoption time
// alone would flag that service stale for good. The restart record is the evidence that the build is loaded.
const readRestartRecord = label => { try { return JSON.parse(readFileSync(diskState.path(label), 'utf8')); } catch { return undefined; } };
// null = this clone has adopted nothing (no claim to be stale against); NaN = an adoption record with an unusable time.
const readAdoption = root => {
  const adopted = readRebuildState(root)?.adopted;
  return adopted == null ? { atMs: null, head: null } : { atMs: Date.parse(adopted.at ?? ''), head: adopted.head ?? null };
};

export function findStaleCodeServices({ readProcessStartMs = processStart, onFreshService = () => {},
  readAdoptedAtMs, readAdoptedHead, readRestart = readRestartRecord,
  launchctl = printHost, uid = userId, ps = argv => execFileSync('ps', argv, commandOptions),
  settings, platform, env = process.env, envValues, log, selfLabel = null, ...options } = {}) {
  // An unreadable policy fails closed: one unlabeled flag (the inspection is incomplete), never a clean result.
  let p;
  try { p = resolveRestartPolicy({ settings, platform, env, envValues, log }).value; }
  catch (error) { return [{ label: null, reason: 'policy-unreadable', error: message(error) }]; }
  const flagged = [];
  for (const label of new Set(p.allowedLabels)) {
    const service = { label };
    try {
      // The watching daemon restarts through self-sync; services policy never restarts are neither stale nor fresh evidence.
      if (label === selfLabel || neverRestartReason(label, p)) continue;
      const start = readProcessStartMs(label, { launchctl, uid, ps });
      if (start === null) { onFreshService(service); continue; }
      if (!Number.isFinite(start)) throw new Error('unreadable process start');
      const adoption = readAdoptedAtMs ? { atMs: readAdoptedAtMs(options.cloneRoot), head: readAdoptedHead?.(options.cloneRoot) ?? null } : readAdoption(options.cloneRoot);
      const adopted = adoption.atMs;
      // This clone has adopted nothing, so there is no rebuild the service could be stale against: no claim either way.
      if (adopted === null) continue;
      if (!Number.isFinite(adopted)) { flagged.push({ ...service, reason: 'adoption-unreadable' }); continue; }
      if (start >= Math.floor(adopted / 1000) * 1000) { onFreshService(service); continue; }
      // Started before this clone's adoption: still fresh when it was restarted for this very build (its restart
      // record names the adopted head) and the process started after that restart was recorded.
      const restart = adoption.head ? readRestart(label) : undefined;
      if (restart && restart.sha === adoption.head && Number.isFinite(restart.at) && start >= Math.floor(restart.at / 1000) * 1000) onFreshService(service);
      else flagged.push({ ...service, reason: 'stale-code', processStartMs: start, adoptedAtMs: adopted });
    } catch (error) { flagged.push({ ...service, reason: 'process-unreadable', error: message(error) }); }
  }
  return flagged;
}
