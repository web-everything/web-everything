#!/usr/bin/env node
/**
 * @file scripts/lib/daemon-rebuild/rebuild-job.mjs
 * @description #4126 (decision 4120, statute `#daemon-jobs`) — the clone rebuild's candidate build + live smoke
 *   run as a DETACHED DURABLE JOB (the shared job runtime, `../daemon-jobs-runtime.mjs`), so an opted-in daemon's
 *   tick never waits on a smoke. Live harm it removes (2026-10-09): the drain ran `rebuildClone` inline between
 *   passes and merged nothing while one smoke took 421 s, 434 s, then 1,002 s.
 *
 *   One file, two roles:
 *   1. TICK SIDE — {@link rebuildCloneAsJob}, what `rebuildClone` delegates to when the caller is opted in
 *      ({@link resolveRebuildAsJob}). Per tick it (a) consumes finished jobs once and logs their outcome, (b) while
 *      a job is in flight runs the runtime's reattach pass and returns `rebuild-job-running` at once, (c) otherwise
 *      runs the ordinary rebuild in ADOPT-ONLY mode — the locked, fast prepare that adopts a ready candidate
 *      (a smoke-passed build the job recorded) or a skip-unrelated move, under the existing match and last-good
 *      rules, unchanged — and when that says a build is due, queues one job. It never builds or smokes.
 *   2. JOB CHILD — this file run as a script (the kind's `entry`) from a pinned code snapshot. Its one step spawns
 *      `daemon-rebuild.mjs --ready-only` as an ASYNC child (the smoke's synchronous children never starve this
 *      process's heartbeat), which runs the unchanged prepare → candidate worktree → live smoke → fallback / hold
 *      logic and, on a pass, records the ready candidate WITHOUT moving the clone. The swap is the daemon's next
 *      tick (step c above): a job never moves the tree a running pass reads.
 *
 *   node scripts/lib/daemon-rebuild/rebuild-job.mjs          # the job child (env from the runtime)
 */
import { spawn as spawnChild, execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineJobKind, kindRegistry } from '../daemon-jobs.mjs';
import {
  createJobStore, createTickClock, enqueueJob, reattachTick, runJob,
} from '../daemon-jobs-runtime.mjs';
import { evictSnapshots, npmCiInstaller } from '../daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES } from '../../operations/job-record.mjs';
import { daemonJobsDir, deleteRun } from '../../operations/run-store.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
import { readGit } from '../proc-read.mjs';

const SELF = fileURLToPath(import.meta.url);
const SETTINGS_PATH = resolve(SELF, '..', '..', 'daemon-rebuild-settings.json');

/** Env override: `1` forces job mode on for every caller, `0` forces it off (rollback). */
export const REBUILD_AS_JOB_ENV = 'WE_DAEMON_REBUILD_AS_JOB';
export const DEFAULT_REBUILD_JOB_MIN_INTERVAL_MS = 5 * 60_000;
export const FINISHED_REBUILD_JOB_KEEP_MS = 24 * 60 * 60_000;
export const RESULT_SUFFIX = '.result';
const CONSUMED_FILE = 'consumed.json';
/** The rebuild child gets this long before the job kills it (one smoke took 1,002 s live; three can run). */
export const REBUILD_CHILD_TIMEOUT_MS = 60 * 60_000;

export const REBUILD_JOB_KIND = defineJobKind({
  kind: 'daemon-rebuild',
  entry: 'scripts/lib/daemon-rebuild/rebuild-job.mjs',
  codeMode: 'readonly-tree',
  serial: true,
  nodeModules: true,
  maxAttempts: 2,
});
export const REBUILD_JOB_KINDS = kindRegistry([REBUILD_JOB_KIND]);

/** The `rebuildAsJob` block of daemon-rebuild-settings.json (missing / unreadable = off). */
export function loadRebuildAsJobSettings(path = SETTINGS_PATH) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))?.rebuildAsJob;
    if (!raw || typeof raw !== 'object') return { entries: [], minIntervalMs: DEFAULT_REBUILD_JOB_MIN_INTERVAL_MS };
    return {
      entries: Array.isArray(raw.entries) ? raw.entries.filter((e) => typeof e === 'string' && e) : [],
      minIntervalMs: Number.isFinite(raw.minIntervalMs) && raw.minIntervalMs >= 0 ? raw.minIntervalMs : DEFAULT_REBUILD_JOB_MIN_INTERVAL_MS,
    };
  } catch {
    return { entries: [], minIntervalMs: DEFAULT_REBUILD_JOB_MIN_INTERVAL_MS };
  }
}

/**
 * PURE-ish: is this caller opted into job mode? The env override wins; otherwise a caller whose `entries` include
 * a script named in `rebuildAsJob.entries` (matched by basename) is on. No entries = off (the gated foreground
 * callers — `daemon-load-overlay.mjs`, the CLI — stay inline).
 */
export function resolveRebuildAsJob({ entries, env = process.env, settings = loadRebuildAsJobSettings() } = {}) {
  const v = env?.[REBUILD_AS_JOB_ENV];
  if (v === '0') return false;
  if (v === '1') return true;
  const want = new Set((settings?.entries || []).map((e) => basename(e)));
  return (entries || []).some((e) => typeof e === 'string' && want.has(basename(e)));
}

/** `<daemonJobsRoot>/rebuild-<cloneKey>` — one clone's rebuild jobs (every daemon sharing the clone shares it). */
export function rebuildJobsDir(root, env = process.env) {
  return daemonJobsDir(`rebuild-${cloneKey(root)}`, env);
}

/** Snapshot `node_modules` installer: an APFS clone of the clone's own tree when the lockfile matches, else npm ci. */
export function cloneNodeModulesInstaller(sourceRoot, { exec = execFileSync, fallback = npmCiInstaller() } = {}) {
  return (into) => {
    const src = join(sourceRoot, 'node_modules');
    let same = false;
    try { same = readFileSync(join(sourceRoot, 'package-lock.json'), 'utf8') === readFileSync(join(into, 'package-lock.json'), 'utf8'); } catch { same = false; }
    if (same && existsSync(src)) {
      try { exec('cp', ['-cR', src, join(into, 'node_modules')], { stdio: 'ignore', timeout: 5 * 60_000 }); return; } catch { /* no clonefile */ }
      rmSync(join(into, 'node_modules'), { recursive: true, force: true });
      exec('cp', ['-R', src, join(into, 'node_modules')], { stdio: 'ignore', timeout: 10 * 60_000 });
      return;
    }
    fallback(into);
  };
}

function readConsumed(dir) {
  try { return new Set(JSON.parse(readFileSync(join(dir, CONSUMED_FILE), 'utf8'))); } catch { return new Set(); }
}
function writeConsumed(dir, set) {
  try { writeFileSync(join(dir, CONSUMED_FILE), `${JSON.stringify([...set])}\n`); } catch { /* best-effort */ }
}
function readResult(dir, id) {
  try { return JSON.parse(readFileSync(join(dir, `${id}${RESULT_SUFFIX}`), 'utf8')); } catch { return null; }
}
function removeJobFiles(dir, id) {
  try { deleteRun(id, dir); } catch { /* gone */ }
  for (const ext of ['.log', RESULT_SUFFIX, '.json.lock']) rmSync(join(dir, `${id}${ext}`), { force: true });
}
function readHead(root) {
  return readGit(['-C', root, 'rev-parse', 'HEAD'], {
    timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

// One tick clock per daemon process (the sleep rule compares consecutive ticks of the SAME process).
const CLOCKS = new Map();
function clockFor(dir) {
  if (!CLOCKS.has(dir)) CLOCKS.set(dir, createTickClock());
  return CLOCKS.get(dir);
}

/**
 * TICK SIDE. Never waits on a smoke. Returns a `rebuildClone`-shaped result (`moved`/`adopted`/`reason`) plus
 * `job` (the in-flight or just-started job) and `finishedJobs` (outcomes consumed this tick).
 * @param {{root: string, env?: object, log?: object, mainOnly?: boolean, entries?: string[],
 *   adopt: (o?: object) => Promise<object>, store?: object, reattach?: Function, clock?: object, now?: () => number,
 *   codeSha?: string, snapshot?: object, settings?: object, evict?: Function}} o
 */
export async function rebuildCloneAsJob({
  root, env = process.env, log = console, mainOnly = false, entries = [], adopt,
  store = createJobStore(rebuildJobsDir(root, env)), reattach = reattachTick, clock, now = () => Date.now(),
  codeSha, snapshot, settings = loadRebuildAsJobSettings(), evict = evictSnapshots,
}) {
  const say = (m) => log.error?.(`daemon-rebuild-job: ${m}`);
  mkdirSync(store.dir, { recursive: true });
  const kind = REBUILD_JOB_KIND.kind;
  const mine = () => store.list().records.filter((r) => r.job.kind === kind);
  const snap = snapshot ?? { repoDir: root, install: cloneNodeModulesInstaller(root) };
  const tickClock = clock ?? clockFor(store.dir);

  // 1. Consume finished jobs once (oldest first) and say what each did — the job's outcome reaches the daemon log.
  const consumed = readConsumed(store.dir);
  const finishedJobs = [];
  for (const r of mine().filter((x) => TERMINAL_JOB_STATUSES.includes(x.job.status) && !consumed.has(x.id))
    .sort((a, b) => Date.parse(a.job.finishedAt || 0) - Date.parse(b.job.finishedAt || 0))) {
    consumed.add(r.id);
    const res = readResult(store.dir, r.id);
    const outcome = r.job.status === 'failed'
      ? { id: r.id, status: 'failed', reason: r.job.error ?? 'unknown' }
      : { id: r.id, status: r.job.status, reason: res?.reason ?? 'no-result', readyRecorded: !!res?.readyRecorded, target: res?.target ?? null };
    finishedJobs.push(outcome);
    say(`job ${r.id} finished (${outcome.status}): ${outcome.reason}${outcome.readyRecorded ? ` — smoke passed, ready candidate ${String(outcome.target ?? '?').slice(0, 9)} is adopted at this tick boundary` : ''}`);
  }
  writeConsumed(store.dir, consumed);

  const pass = async () => {
    try {
      return await reattach({ store, kinds: REBUILD_JOB_KINDS, maxConcurrent: 1, clock: tickClock, snapshot: snap, log: say });
    } catch (e) {
      say(`reattach pass failed (${String(e?.message || e).split('\n')[0]}) — the next tick retries`);
      return null;
    }
  };
  const describe = (r) => (r ? { id: r.id, status: r.job.status, attempts: r.job.attempts, handle: r.job.handle ?? null } : null);
  const housekeeping = () => {
    const after = store.list().records;
    const referenced = after.filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).flatMap((r) => r.job.snapshotKeys || []);
    try { evict({ jobsDir: store.dir, referenced }); } catch (e) { say(`snapshot eviction failed: ${e.message}`); }
    const cons = readConsumed(store.dir);
    for (const r of after) {
      if (r.job.kind !== kind || !TERMINAL_JOB_STATUSES.includes(r.job.status) || !cons.has(r.id)) continue;
      if (now() - Date.parse(r.job.finishedAt || 0) < FINISHED_REBUILD_JOB_KEEP_MS) continue;
      removeJobFiles(store.dir, r.id);
      cons.delete(r.id);
    }
    writeConsumed(store.dir, cons);
  };

  // 2. A job in flight: reattach (launch / stalled / dead handling) and tick on the current tree.
  let inFlight = mine().find((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)) ?? null;
  if (inFlight) {
    await pass();
    const cur = store.read(inFlight.id);
    if (cur && !TERMINAL_JOB_STATUSES.includes(cur.job.status)) {
      return { moved: false, reason: 'rebuild-job-running', job: describe(cur), finishedJobs, alerts: [] };
    }
    inFlight = null; // finished during the pass — fall through, the next tick consumes it
  }

  // 3. Adopt-only: a ready candidate (or a skip-unrelated move) is adopted here, fast, under the existing rules.
  const r = await adopt();
  if (r?.reason !== 'needs-build') {
    housekeeping();
    return { ...r, finishedJobs };
  }

  // 4. A build is due. Space builds by `minIntervalMs` after one that did not record a ready candidate (a
  //    transient hold writes no reject record; without this the job would re-smoke back to back).
  const last = mine().filter((x) => TERMINAL_JOB_STATUSES.includes(x.job.status))
    .sort((a, b) => Date.parse(b.job.finishedAt || 0) - Date.parse(a.job.finishedAt || 0))[0];
  const lastRes = last ? readResult(store.dir, last.id) : null;
  const sinceMs = last ? now() - Date.parse(last.job.finishedAt || 0) : Infinity;
  if (last && !lastRes?.readyRecorded && sinceMs < settings.minIntervalMs) {
    housekeeping();
    return {
      moved: false, reason: 'rebuild-job-spaced', retryInMs: settings.minIntervalMs - sinceMs, plan: r.plan, finishedJobs, alerts: r.alerts ?? [],
    };
  }
  let queued;
  try {
    queued = enqueueJob({
      store, kindDef: REBUILD_JOB_KIND, codeSha: codeSha ?? readHead(root), now: now(),
      input: { root: resolve(root), entries, mainOnly: !!mainOnly, target: r.plan?.finalSha ?? null },
    });
  } catch (e) {
    say(`could not queue a rebuild job (${String(e?.message || e).split('\n')[0]}) — the next tick retries`);
    return { moved: false, reason: 'rebuild-job-queue-failed', finishedJobs, alerts: r.alerts ?? [] };
  }
  say(`queued rebuild job ${queued.id} for ${String(r.plan?.finalSha ?? '?').slice(0, 9)} — build + live smoke run detached; this daemon keeps ticking on its current tree and adopts only a smoke-passed build`);
  await pass();
  housekeeping();
  return {
    moved: false, reason: 'rebuild-job-started', job: describe(store.read(queued.id)), plan: r.plan, finishedJobs, alerts: r.alerts ?? [],
  };
}

// ── job child ────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE: the rebuild CLI argv for a job input. */
export function rebuildChildArgs(input, cliPath) {
  return [
    cliPath, `--clone=${input.root}`, '--ready-only', '--json',
    ...(input.entries || []).map((e) => `--entry=${e}`),
    ...(input.mainOnly ? ['--main-only'] : []),
  ];
}

/** PURE: the last JSON object line of the rebuild CLI's stdout (its `--json` result), or null. */
export function parseRebuildChildOutput(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* not this one */ }
  }
  return null;
}

/** Run the rebuild CLI as an async child; resolves with its parsed result. Kills it on `timeoutMs`. */
export function runRebuildChild({
  input, cwd = process.cwd(), env = process.env, timeoutMs = REBUILD_CHILD_TIMEOUT_MS, spawnFn = spawnChild, onChild = () => {},
}) {
  return new Promise((resolveRun, reject) => {
    const cli = join(cwd, 'scripts', 'lib', 'daemon-rebuild.mjs');
    const child = spawnFn(process.execPath, rebuildChildArgs(input, cli), { cwd, env, stdio: ['ignore', 'pipe', 'inherit'] });
    onChild(child);
    let out = '';
    child.stdout?.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const parsed = parseRebuildChildOutput(out);
      if (parsed) resolveRun(parsed);
      else reject(new Error(`rebuild child exited ${code ?? signal} with no JSON result`));
    });
  });
}

async function jobMain() {
  let child = null;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { try { child?.kill('SIGTERM'); } catch { /* gone */ } process.exit(143); });
  }
  const dir = process.env.OPERATION_RUNS_DIR;
  const out = await runJob({
    steps: [{
      name: 'rebuild',
      run: async ({ jobId, input }) => {
        process.stderr.write(`[rebuild-job ${jobId}] ${new Date().toISOString()} building ${input.target ?? 'main + overlays'} for ${input.root}\n`);
        const childEnv = { ...process.env, [REBUILD_AS_JOB_ENV]: '0' };
        for (const k of ['DAEMON_JOB_ID', 'DAEMON_JOB_ATTEMPT', 'DAEMON_JOB_HEARTBEAT_MS', 'OPERATION_RUNS_DIR']) delete childEnv[k];
        const r = await runRebuildChild({ input, env: childEnv, onChild: (c) => { child = c; } });
        const result = {
          finishedAt: Date.now(), reason: r.reason ?? null, readyRecorded: !!r.readyRecorded, target: r.target ?? r.plan?.finalSha ?? null,
          alerts: (r.alerts || []).map((a) => a.kind),
        };
        writeFileSync(join(dir, `${jobId}${RESULT_SUFFIX}`), `${JSON.stringify(result)}\n`);
        process.stderr.write(`[rebuild-job ${jobId}] ${new Date().toISOString()} done: ${result.reason}${result.readyRecorded ? ' (ready candidate recorded)' : ''}\n`);
        return { reason: result.reason, readyRecorded: result.readyRecorded };
      },
    }],
  });
  process.stderr.write(`[rebuild-job] outcome ${out.outcome}${out.error ? `: ${out.error}` : ''}\n`);
  process.exit(out.outcome === 'succeeded' ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  jobMain().catch((e) => {
    process.stderr.write(`[rebuild-job] fatal: ${String(e?.stack || e)}\n`);
    process.exit(1);
  });
}
