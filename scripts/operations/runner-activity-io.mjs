/**
 * Injected reader for runner-activity. The synchronous store readers run inside ONE bounded child read,
 * like pr-status's bounded gh read. The outer SIGKILL deadline covers EVERY filesystem read too (a JS
 * timer cannot interrupt readFileSync). No tick is executed and no liveness stamp is persisted.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFileRunStore, migrateLegacyRuns, runsDir, sharedRunsDir } from './run-store.mjs';
import { createFileCallLogStore } from './call-log-store.mjs';
import { DISPATCH_EFFECT, LAUNCH_KINDS, dispatchStillHolds } from './dispatch-lane.mjs';
import { REPO_ROOT, defaultListAgents, inFlightDispatchesFor, stampLiveness } from './dispatch-lane-io.mjs';
import { lockDirFor, parseLockEntry } from '../readiness/file-locks.mjs';
import { looksLikeRunnerProcess, pidToCwd, RUNNER_SCRIPT_TOKEN } from '../conveyor/resolve-runner-checkout.mjs';
import { RUNNER_LOCK_ROOT, RUNNER_LEASE_PATH, RUNNER_LEASE_MINUTES } from '../../skills-src/conveyor/runner-lock.mjs';
import { DRIVER_STATUS_FILENAME } from '../../skills-src/conveyor/runner.mjs';

export const READ_TIMEOUT_MS = 10_000;
const PROCESS_TIMEOUT_MS = 2_000;
const SELF = fileURLToPath(import.meta.url);

/**
 * The three standalone daemons runner-activity reports on today, each a singleton-lease process built on
 * the SAME primitive ({@link ../../skills-src/conveyor/runner-lock.mjs}'s keyed `acquireRunnerLease`/
 * `heartbeatRunnerLease`) — the dispatcher (`skills-src/conveyor/runner.mjs`, the original single-daemon
 * subject this operation used to report on exclusively) plus the two daemons since extracted out of its own
 * mechanical-pass list: the fix-dispatch daemon (#3870) and the review daemon (#3876), both epic #3383.
 *
 * DELIBERATELY NOT `skills-src/conveyor/daemon-manifest.mjs`'s `DAEMON_MANIFEST`. That manifest is a
 * closed allowlist `pass-daemon.mjs` resolves `--pass=<name>` launches through (#3871/#3873) — a mechanism
 * for LIGHTER, still-partially-built periodic watcher SWEEPS, and at the time of writing it is deliberately
 * EMPTY (no real entries registered yet). These three are a different, older, already-shipped shape: each
 * is its OWN hand-rolled CLI entry point with its own `main()`, its own lease key, and its own long-lived
 * loop — never spawned or tracked by `pass-daemon.mjs`. Reusing `DAEMON_MANIFEST` here would conflate two
 * unrelated daemon-launch mechanisms for no benefit (this list needs a `scriptToken` for process-identity
 * matching, which `DAEMON_MANIFEST` entries don't even carry) — out of scope for this change; see this
 * item's own build notes.
 *
 * `name` is the stable key a consumer keys off in `runners[]` (never the lease key or script path — those
 * are internal plumbing a consumer should not need to know).
 *
 * The fix-dispatch and review daemons' own lease-key CONSTANTS are deliberately NOT imported here (even
 * though each is a real, stable export) — live-caught 2026-09-22: `reconcile-fix-dispatch-daemon.mjs`
 * transitively imports this file (via `reconcile-fix-dispatch.mjs` → `dispatch-abort.mjs` → `wake.mjs` →
 * `run.mjs` → here), so importing its lease key back FROM it closed a real ESM circular-import cycle and
 * crashed the daemon at startup with a TDZ `ReferenceError` the moment it was launched standalone. These
 * two strings are copied literally instead — they are each daemon's own hardcoded lease-key sentinel, not
 * derived from anything else, so a literal copy carries zero risk of drifting from the real value; a
 * daemon renaming its own lease key is already a breaking change to itself, not something this list could
 * silently paper over either way.
 * @type {Array<{ name: string, leaseKey: string, scriptToken: string }>}
 */
export const KNOWN_DAEMONS = [
  { name: 'dispatcher', leaseKey: RUNNER_LEASE_PATH, scriptToken: RUNNER_SCRIPT_TOKEN },
  { name: 'fix-dispatch', leaseKey: '<conveyor:reconcile-fix-dispatch-daemon-lease>', scriptToken: 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs' },
  { name: 'review', leaseKey: '<conveyor:review-daemon-lease>', scriptToken: 'skills-src/conveyor/review-daemon.mjs' },
];

/** Missing is distinct from corrupt/unreadable. All real calls are covered by the outer read deadline. */
function optionalText(path) {
  try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/**
 * Read + parse ONE daemon's own lease file. Isolated failure boundary (WE runner-activity multi-daemon
 * generalization): a read error other than ENOENT (an unreadable lock dir — permissions, a torn write) or a
 * lease that parses to something unusable (corrupt JSON, or a lease with no usable positive-integer pid) is
 * caught HERE and reported back as `error`, never thrown — so ONE daemon's bad lock dir can never abort the
 * whole multi-daemon snapshot. This deliberately covers only the LEASE FILE READ/PARSE step; the separate
 * process-identity check ({@link resolveDaemonLiveness}) keeps the ORIGINAL hard-fail behavior (a genuine
 * `ps`/`lsof` infra error — a timeout, a permission error — still propagates and fails the whole read) per
 * #3884's fix: a timeout must never silently masquerade as "dead", for any of the three daemons, not just
 * the dispatcher.
 * @returns {{ name: string, source: string, lease: object|null, error: string|null }}
 */
function readDaemonLease({ name, leaseKey }, { readText, lockRoot }) {
  const source = join(lockDirFor(lockRoot, leaseKey), 'lock.json');
  let lockText;
  try { lockText = readText(source); }
  catch (e) { return { name, source, lease: null, error: `lock directory unreadable: ${e.message}` }; }
  if (lockText == null) return { name, source, lease: null, error: null };
  const lease = parseLockEntry(lockText);
  if (!lease) return { name, source, lease: null, error: 'malformed lease' };
  if (!(Number.isInteger(lease.pid) && lease.pid > 0)) return { name, source, lease, error: 'lease has no usable pid' };
  return { name, source, lease, error: null };
}

/**
 * Resolve ONE daemon's process identity given an already-validated lease (a usable positive `pid`). Mirrors
 * the dispatcher-only logic this operation always had, generalized over `scriptToken`: resolve candidate
 * script-path tokens from the pid's command line BEFORE identity checking (cwd alone is never the checkout
 * root), then confirm via {@link looksLikeRunnerProcess}. A `ps` exit 1 with no stderr means no such pid
 * (not alive, not an error); any OTHER `ps`/`lsof` failure (permission error, timeout) is a genuine
 * inability to check and PROPAGATES — it must never be reported as "dead" (#3884).
 * @returns {{ alive: boolean, root: string|null }}
 */
function resolveDaemonLiveness({ name, scriptToken }, lease, { commandRead }) {
  let command = '';
  try { command = commandRead('ps', ['-o', 'command=', '-p', String(lease.pid)]); }
  catch (e) {
    if (e.status !== 1 || String(e.stderr || '').trim()) throw e;
  }
  // Loose candidate filter on the script's bare BASENAME (e.g. `runner.mjs`) — a relative invocation from an
  // arbitrary cwd (`conveyor/runner.mjs`, `../driver/skills-src/conveyor/runner.mjs`, …) only shares this
  // suffix with `scriptToken`, not the whole path; full-suffix identity is verified by `looksLikeRunnerProcess`
  // below only AFTER resolving each candidate to an absolute path against the pid's real cwd.
  const basename = scriptToken.slice(scriptToken.lastIndexOf('/') + 1);
  const candidates = command.trim().split(/\s+/).filter((t) => t === basename || t.endsWith(`/${basename}`));
  let cwd;
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) && cwd === undefined) {
      cwd = pidToCwd(lease.pid, (pid) => commandRead('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']));
      if (!cwd || !isAbsolute(cwd)) throw new Error(`runner-activity: live ${name} checkout could not be resolved`);
    }
    const script = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
    if (looksLikeRunnerProcess(script, scriptToken)) return { alive: true, root: resolve(dirname(script), '../..') };
  }
  return { alive: false, root: null };
}

/**
 * Snapshot assembly with injected stores/readers. Reads all three {@link KNOWN_DAEMONS} leases into
 * `runners[]` (raw per-daemon findings only — `state`/`stalled`/`stalledReason` are computed downstream by
 * `assessRunnerActivity`, the declared compute step, same read/compute split as before). Only the dispatcher
 * entry's resolved checkout drives the dispatcher-specific fields below it (`lastTick`, `inFlightDispatches`,
 * `completedDispatches`) — the fix-dispatch/review daemons have no tick or dispatch-lane concept of their
 * own, so those stay dispatcher-only top-level fields rather than being forced into each `runners[]` entry.
 *
 * In-flight rows come from the existing dispatch reader; terminal effects supply outcomes, never the call
 * log's `complete` (which can mean no dispatch occurred). Older records lack a completion timestamp: report
 * the last-attempt ordering proxy explicitly.
 */
export function collectRunnerActivity({ limit = 10 } = {}, {
  readText = optionalText,
  exec = execFileSync,
  env = process.env,
  now = () => new Date(),
  // D6 of 128 (#xyloz19): every runner's history is the ONE shared folder; a runner checkout's old per-clone
  // records are moved in the first time it is read, so nothing written before the move is lost.
  storeFor = (root) => {
    if (env.OPERATION_RUNS_DIR) return createFileRunStore(env.OPERATION_RUNS_DIR);
    const shared = sharedRunsDir(env);
    if (env.WE_UNDER_TEST !== '1') migrateLegacyRuns(runsDir(root), shared);
    return createFileRunStore(shared);
  },
  listAgents = () => defaultListAgents({ exec, env: { ...env, WE_DISPATCH_LIST_TIMEOUT_MS: String(PROCESS_TIMEOUT_MS) } }),
} = {}) {
  const observedAt = now().toISOString();
  const lockRoot = env.CONVEYOR_RUNNER_LOCK_ROOT || RUNNER_LOCK_ROOT;
  const commandRead = (file, argv) => String(exec(file, argv, {
    encoding: 'utf8', timeout: PROCESS_TIMEOUT_MS, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  }) || '');

  let root = REPO_ROOT; // the dispatcher's resolved checkout, if it is alive; falls back to this process's own repo root
  const runners = KNOWN_DAEMONS.map((daemon) => {
    const { name, source, lease, error } = readDaemonLease(daemon, { readText, lockRoot });
    if (error) {
      // Isolated failure: this daemon's own lease could not be read/parsed reliably. `present: null` marks
      // "unknown" — distinct from a genuinely absent lease (`present: false`) and a genuinely present, live
      // one (`present: true`) — so a consumer never conflates "no daemon registered" with "couldn't tell".
      return { name, present: lease ? true : null, pid: lease?.pid ?? null, alive: false,
        heartbeatAt: lease?.heartbeatAt ?? null, source, livenessSource: 'lease unreadable', error };
    }
    if (!lease) {
      return { name, present: false, pid: null, alive: false, heartbeatAt: null,
        source, livenessSource: 'singleton lease absent' };
    }
    const { alive, root: resolvedRoot } = resolveDaemonLiveness(daemon, lease, { commandRead });
    if (daemon.name === 'dispatcher' && alive) root = resolvedRoot;
    return { name, present: true, pid: lease.pid, alive, heartbeatAt: lease.heartbeatAt,
      source, livenessSource: 'singleton lease + ps command identity' };
  });

  const tickSource = join(root, '.conveyor', DRIVER_STATUS_FILENAME);
  const tickText = readText(tickSource);
  const tick = tickText == null ? null : JSON.parse(tickText);
  if (tickText != null && (!tick || !Number.isInteger(tick.tick) || !Number.isFinite(Date.parse(tick.at)) || !Array.isArray(tick.stalled))) {
    throw new Error('runner-activity: malformed driver-status snapshot');
  }
  const store = storeFor(root);
  const ids = store.list(); // A failed listing is not an empty history.
  const records = new Map();
  let unreadableRunRecords = 0;
  for (const id of ids) {
    try { const record = store.read(id); if (record) records.set(id, record); }
    catch { unreadableRunRecords += 1; }
  }
  const cachedStore = { list: () => [...records.keys()], read: (id) => records.get(id) };
  const effects = [...records.values()].flatMap((run) => (run.effects || [])
    .filter((e) => e.type === DISPATCH_EFFECT).map((e) => ({ run, e })));
  const nums = new Set(effects.map(({ e }) => String(e.payload?.num ?? '')));
  const rows = [...nums].flatMap((num) => inFlightDispatchesFor(num, { store: cachedStore }).runs);
  const stamped = stampLiveness({ runs: rows, unreadable: unreadableRunRecords }, { listAgents });
  const metadata = (run, e) => ({
    num: e.payload?.num ?? null,
    launchKind: LAUNCH_KINDS.includes(e.payload?.launchKind) ? e.payload.launchKind
      : LAUNCH_KINDS.includes(run.findings?.read?.launchKind) ? run.findings.read.launchKind : 'unknown',
  });
  const inFlightDispatches = stamped.runs.map((row) => {
    const run = records.get(row.runId);
    const e = run.effects.find((entry) => entry.key === row.key);
    const started = Date.parse(row.startedAt);
    return { ...row, ...metadata(run, e),
      ageMs: Number.isFinite(started) ? Math.max(0, Date.parse(observedAt) - started) : null,
      holds: dispatchStillHolds(row, observedAt),
    };
  });
  const completed = effects.filter(({ e }) => ['applied', 'failed'].includes(e.status)).map(({ run, e }) => {
    const timing = (run.stepTimings || []).find((t) => t.step === e.step && t.finishedAt);
    const at = timing?.finishedAt || e.lastAttemptAt || e.startedAt || null;
    return { runId: run.id, key: e.key, ...metadata(run, e), outcome: e.status,
      result: e.result ?? null, error: e.error ?? null, at,
      timestampSource: timing ? 'run.stepTimings.finishedAt' : 'last-attempt-proxy',
    };
  }).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || a.runId.localeCompare(b.runId));
  return {
    observedAt, checkout: root, staleAfterMs: RUNNER_LEASE_MINUTES * 60_000,
    runners,
    lastTick: { number: tick?.tick ?? null, at: tick?.at ?? null, source: tickSource,
      proxy: false, stalled: tick?.stalled ?? [], statusLine: tick?.statusLine ?? '',
      plannedDispatch: tick?.dispatch ?? null },
    inFlightDispatches, dispatchLiveness: stamped.livenessSource,
    completedDispatches: completed.slice(0, limit), completedAvailable: completed.length,
    historySource: env.OPERATION_RUNS_DIR || sharedRunsDir(env), unreadableRunRecords,
  };
}

/** Same injected exec seam as pr-status; a fixed outer bound also covers sync disk reads in the child. */
export function createRunnerActivityReader({ run = execFileSync, env = process.env } = {}) {
  return (input) => JSON.parse(String(run(process.execPath, [SELF, '--snapshot', JSON.stringify(input)], {
    encoding: 'utf8', timeout: READ_TIMEOUT_MS, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, env,
  })));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href && process.argv[2] === '--snapshot') {
  try { process.stdout.write(JSON.stringify(collectRunnerActivity(JSON.parse(process.argv[3] || '{}')))); }
  catch (e) { process.stderr.write(`runner-activity: ${e.message}\n`); process.exitCode = 1; }
}

/** runner-activity-only CLI persistence. Every adapter read/write and telemetry append runs
 * in a killable child; the shared adapter and other operations retain their existing stores. */
export const CLI_IO_TIMEOUT_MS = 2_000;
export function createRunnerActivityCliStores({ run = execFileSync, env = process.env } = {}) {
  const invoke = (target, method, value) => JSON.parse(String(run(process.execPath, [SELF, '--cli-io'], {
    input: JSON.stringify({ target, method, value }),
    encoding: 'utf8', timeout: CLI_IO_TIMEOUT_MS, killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, env,
  })));
  return {
    store: Object.fromEntries(['read', 'write', 'list', 'delete'].map((method) =>
      [method, (value) => invoke('store', method, value)])),
    callLog: { append: (value) => invoke('callLog', 'append', value) },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href && process.argv[2] === '--cli-io') {
  try {
    const { target, method, value } = JSON.parse(readFileSync(0, 'utf8'));
    const handle = target === 'store' ? createFileRunStore() : createFileCallLogStore();
    process.stdout.write(JSON.stringify(handle[method](value) ?? null));
  } catch (e) { process.stderr.write(`runner-activity CLI IO: ${e.message}\n`); process.exitCode = 1; }
}
