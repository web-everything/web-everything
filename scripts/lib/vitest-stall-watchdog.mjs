/**
 * @file scripts/lib/vitest-stall-watchdog.mjs
 * @description Test hygiene (2026-10-21) — a vitest reporter that turns a SILENT hung run into a loud, bounded failure.
 *
 * WHY. Per-test `testTimeout`/`hookTimeout` only bound a test that is running. They do not bound a file stuck while it
 * is being imported, or a pool worker that never reports back. Both happened on this host: two `vitest run` processes
 * sat at 0% CPU for 6.7 h and 9.3 h with one or two test files never reported (e.g. policy-cascade.test.mjs and
 * merge-gate-check-pr-event-candidacy.test.mjs, which each pass in milliseconds alone). Their one remaining thread
 * did not answer the inspector. Every agent and verify job that waited on such a run lost its heavy-queue slot for
 * hours, and the hang showed up in `ps` under whatever file came first on the command line (often a bun-trial/ copy).
 *
 * WHAT. Activity means any reporter event: a file collected, a task update, or console output. If NO activity happens
 * for `stallMs` while some files have not finished, the watchdog names those files on stderr and exits the run with
 * SIGKILL (see {@link hardExit}). It never changes what runs and never touches a healthy run: its timer is unref'd and cleared in `onFinished`.
 * The limit is never below the config's own `testTimeout + hookTimeout + 60s`, so a long but live test is never cut.
 *
 * Knob: `WE_VITEST_STALL_MS` (milliseconds; `0`/`off` disables). Default 15 minutes.
 */

import { execFileSync } from 'node:child_process';
import { writeSync } from 'node:fs';

export const STALL_ENV = 'WE_VITEST_STALL_MS';
export const DEFAULT_STALL_MS = 15 * 60_000;
const FINISHED_STATES = new Set(['pass', 'fail', 'skip', 'todo']);

/** PURE: the configured stall limit in ms, or 0 when disabled. A bad value keeps the default (never fails open). */
export function resolveStallMs(env = process.env) {
  const raw = env?.[STALL_ENV];
  if (raw === undefined || raw === '') return DEFAULT_STALL_MS;
  if (String(raw).trim().toLowerCase() === 'off') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STALL_MS;
  return Math.floor(n);
}

/** PURE: the effective limit — never below what the config itself allows one test plus its hooks to take. */
export function effectiveStallMs(stallMs, config = {}) {
  if (!(stallMs > 0)) return 0;
  const floor = (Number(config.testTimeout) || 0) + (Number(config.hookTimeout) || 0) + 60_000;
  return Math.max(stallMs, floor);
}

/**
 * PURE: has the run stalled? `paths` are every file the run means to execute, `files` the vitest File tasks seen so far
 * (`{ filepath, result: { state } }`). Returns null while healthy, else `{ idleMs, unfinished }`.
 */
export function stallVerdict({ paths = [], files = [], lastActivityMs, nowMs, stallMs }) {
  if (!(stallMs > 0) || !Number.isFinite(lastActivityMs)) return null;
  const idleMs = nowMs - lastActivityMs;
  if (idleMs < stallMs) return null;
  const finished = new Set(files.filter((f) => FINISHED_STATES.has(f?.result?.state)).map((f) => f.filepath));
  const all = [...new Set([...paths, ...files.map((f) => f?.filepath).filter(Boolean)])];
  const unfinished = all.filter((p) => !finished.has(p)).sort();
  return unfinished.length ? { idleMs, unfinished } : null;
}

export function formatStall({ idleMs, unfinished }, root = '') {
  const rel = (p) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  return [
    `\n[vitest-stall-watchdog] no test activity for ${Math.round(idleMs / 1000)}s with ${unfinished.length} file(s) unfinished — the run is hung, failing it instead of waiting forever.`,
    ...unfinished.map((p) => `  stuck: ${rel(p)}`),
    `  (limit ${STALL_ENV}; see scripts/lib/vitest-stall-watchdog.mjs)`,
  ].join('\n');
}

/** PURE: every descendant pid of `rootPid` in a `ps -Ao pid=,ppid=` listing, deepest first. */
export function descendantPids(psOutput, rootPid) {
  const children = new Map();
  for (const line of String(psOutput).split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = []; const seen = new Set([rootPid]);
  const walk = (pid) => { for (const c of children.get(pid) ?? []) if (!seen.has(c)) { seen.add(c); walk(c); out.push(c); } };
  walk(rootPid);
  return out;
}

/**
 * IO: end the hung run for certain. NOT `process.exit`: on exit Node joins every worker thread, and the stuck worker
 * this exists for never finishes, so `process.exit` would hang too. Kill the whole child tree (fork workers, spawned
 * daemons, esbuild), then this process, with SIGKILL — the run ends with a signal exit, never silently.
 */
export function hardExit() {
  try {
    const ps = execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 8 << 20 });
    for (const pid of descendantPids(ps, process.pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  } catch { /* still kill ourselves below */ }
  process.kill(process.pid, 'SIGKILL');
}

export default class StallWatchdogReporter {
  /** @param {{ env?: object, now?: () => number, exit?: (code: number) => void, write?: (s: string) => void, setInterval?: Function, clearInterval?: Function }} [deps] */
  constructor(deps = {}) {
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? Date.now;
    this.exit = deps.exit ?? hardExit;
    // Synchronous: the process is SIGKILLed right after, and an async stderr pipe write would be lost.
    this.write = deps.write ?? ((s) => { try { writeSync(2, `${s}\n`); } catch { /* nothing else to do */ } });
    this.setIntervalFn = deps.setInterval ?? setInterval;
    this.clearIntervalFn = deps.clearInterval ?? clearInterval;
    this.paths = [];
    this.timer = null;
    this.fired = false;
  }

  onInit(ctx) {
    this.ctx = ctx;
    this.stallMs = effectiveStallMs(resolveStallMs(this.env), ctx?.config);
    if (ctx?.config?.watch) this.stallMs = 0; // idle between watch reruns is normal
    this.touch();
  }

  onPathsCollected(paths = []) {
    this.paths = [...paths];
    this.touch();
    this.arm();
  }

  onCollected() { this.touch(); }
  onTaskUpdate() { this.touch(); }
  onUserConsoleLog() { this.touch(); }

  onFinished() { this.disarm(); }

  touch() { this.lastActivityMs = this.now(); }

  arm() {
    if (this.timer || !(this.stallMs > 0)) return;
    const every = Math.max(1_000, Math.min(30_000, Math.floor(this.stallMs / 4)));
    this.timer = this.setIntervalFn(() => this.check(), every);
    this.timer?.unref?.();
  }

  disarm() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  check() {
    if (this.fired) return null;
    let files = [];
    try { files = this.ctx?.state?.getFiles?.() ?? []; } catch { files = []; }
    const verdict = stallVerdict({ paths: this.paths, files, lastActivityMs: this.lastActivityMs, nowMs: this.now(), stallMs: this.stallMs });
    if (!verdict) return null;
    this.fired = true;
    this.disarm();
    this.write(formatStall(verdict, this.ctx?.config?.root));
    this.exit(1);
    return verdict;
  }
}
