#!/usr/bin/env node
/**
 * @file scripts/conveyor/orphan-process-reaper.mjs
 * @description Automatic cleanup of LOST processes our own jobs left behind — a health-watch pass.
 *
 * Live-caught 2026-10-20: 154 orphaned test keep-alives (`node -e` empty-callback setInterval), up to 19 days old,
 * ~864 MB; beside them orphaned `node (vitest)` runners and test fixtures still running out of a dead vitest run's
 * private temp root. Nothing ever stopped them. `scripts/lib/test-keepalive.mjs` stops new keep-alives leaking;
 * this pass is the backstop for everything else on the list below, and for the ones already out there.
 *
 * WHAT IT MAY TOUCH — a CLOSED allowlist ({@link ORPHAN_SIGNATURES}). A process is reaped only when ALL hold:
 *   - it runs as this user, is not this process, and its parent is gone (ppid 1 — orphaned);
 *   - its command line matches one allowlisted signature, and none of {@link NEVER_REAP_PATTERNS}
 *     (dev servers, editors, Claude sessions, daemons);
 *   - it is older than that signature's max age;
 *   - no live owner claims it: its pid is not a running daemon-job record's pid, and its process group leader
 *     (when it is not its own leader) is not alive.
 * Anything with a live parent, a live job record or a live group leader is never touched.
 *
 * HOW. SIGTERM by pid, then — after `termGraceSeconds`, and only if the SAME process (same pid, same command,
 * not younger) is still there — SIGKILL. Every reap (and every would-reap in dry-run) is logged with pid,
 * signature, age and reason, to stderr and to `<health dir>/orphan-reaper.jsonl`.
 *
 * SETTINGS — the shared policy cascade with logged sources (standard → platform → tool → env):
 *   tool file `scripts/settings/orphan-reaper.json` (`orphanReaper`), env `WE_ORPHAN_REAPER_<KEY>`
 *   (e.g. `WE_ORPHAN_REAPER_DRY_RUN=0`). Ships with `dryRun: true` — it reports what it would reap until the
 *   operator turns dry-run off.
 *
 * CLI (read-only unless --apply): `node scripts/conveyor/orphan-process-reaper.mjs [--apply] [--json]`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, formatCascadeSourcesLine, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { KEEPALIVE_MARKER } from '../lib/test-keepalive.mjs';
import { daemonJobsRoot } from '../operations/run-store.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';
import { createJobStore } from '../lib/daemon-jobs-runtime.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MINUTE = 60_000;

export const ORPHAN_REAPER_DEFAULTS = Object.freeze({
  enabled: true,
  dryRun: true,
  intervalMinutes: 10,
  termGraceSeconds: 5,
  keepAliveMaxAgeMinutes: 10, // = test-keepalive.mjs KEEPALIVE_MAX_LIFETIME_MS: older is past its own design bound
  vitestFixtureMaxAgeMinutes: 30,
  // The verify gate's ceiling: 30 minutes × the max load factor of 4 (scripts/settings/verify-recovery.json).
  vitestMaxAgeMinutes: 120,
  verifyLaneMaxAgeMinutes: 120,
  codexTaskMaxAgeMinutes: 120,
  reviewJobMaxAgeMinutes: 180,
});

// ── PURE CORE ──────────────────────────────────────────────────────────────────────────────────────────────

/** `node` (any path) followed only by its own flags — so a pattern after it names argv[1] itself. */
const NODE = String.raw`^(?:\S*\/)?node(?:\s+--?[\w-]+(?:=\S+)?)*`;
const script = (path) => new RegExp(`${NODE}\\s+\\S*\\/${path}(?:\\s|$)`);
/** A whole `-e` program that is nothing but an idle interval (after optional process.on/once signal traps). */
const LEGACY_KEEPALIVE = new RegExp(`${NODE}\\s+-e\\s+(?:process\\.(?:on|once)\\([^\\n]*?\\);\\s*)*`
  + String.raw`setInterval\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*,\s*[\d.e_]+\s*\);?\s*$`);
const MARKED_KEEPALIVE = new RegExp(`${NODE}\\s+-e\\s+${KEEPALIVE_MARKER.replace(/[/*]/g, (c) => `\\${c}`)}`);
/** A run's private temp root (`scripts/lib/test-tmp-root.mjs`): `<tmp>/we-vitest/<runner pid>-<suffix>/`. */
const VITEST_TMP_ROOT = /\/we-vitest\/(\d+)-[A-Za-z0-9]+\//;

/**
 * The closed allowlist. `match(proc, ctx)` returns a reason string, or null. Script signatures match argv[1]
 * (the script node runs), never a mention later in the arguments. `leaseFree`: a pure test artifact no daemon
 * job ever owns, so it stays reapable even when the daemon-job lease scan is incomplete.
 */
export const ORPHAN_SIGNATURES = Object.freeze([
  {
    id: 'test-keepalive', maxAgeKey: 'keepAliveMaxAgeMinutes', leaseFree: true,
    match: ({ command }) => (MARKED_KEEPALIVE.test(command) || LEGACY_KEEPALIVE.test(command) ? 'test keep-alive (node -e idle interval)' : null),
  },
  {
    // Any node process whose arguments point into a DEAD vitest run's private temp root: that root is made per
    // run for tests only and removed at teardown, so nothing outside a test run ever runs from or against it.
    id: 'vitest-tmp-fixture', maxAgeKey: 'vitestFixtureMaxAgeMinutes', leaseFree: true,
    match: ({ command }, { isAlive }) => {
      if (!new RegExp(NODE).test(command)) return null;
      const m = VITEST_TMP_ROOT.exec(command);
      if (!m) return null;
      return isAlive(Number(m[1])) ? null : `test fixture inside dead vitest run ${m[1]}'s temp root`;
    },
  },
  {
    id: 'vitest', maxAgeKey: 'vitestMaxAgeMinutes',
    match: ({ command }) => (/^node \(vitest(?: \d+)?\)\s*$/.test(command)
      || new RegExp(`${NODE}\\s+\\S*\\/(?:vitest\\.mjs|\\.bin\\/vitest)\\s+run(?:\\s|$)`).test(command)
      || /^(?:\S*\/)?npm exec vitest(?:\s|$)/.test(command) ? 'vitest runner' : null),
  },
  { id: 'verify-lane', maxAgeKey: 'verifyLaneMaxAgeMinutes', match: ({ command }) => (script(String.raw`scripts\/verify-lane\.mjs`).test(command) ? 'verify-lane gate' : null) },
  { id: 'codex-direct-task', maxAgeKey: 'codexTaskMaxAgeMinutes', match: ({ command }) => (script(String.raw`scripts\/codex-direct-task\.mjs`).test(command) ? 'codex-direct-task wrapper' : null) },
  { id: 'review-job', maxAgeKey: 'reviewJobMaxAgeMinutes', match: ({ command }) => (script(String.raw`scripts\/operations\/review-job\.mjs`).test(command) ? 'review-job' : null) },
]);

/** Never reaped, even if an allowlisted signature also matches (defence in depth). */
export const NEVER_REAP_PATTERNS = Object.freeze([
  /(^|[\s/])vite(\s|$)/, /\.bin\/vite(\s|$)/, /\bnpm (run )?(start|dev)\b/, /\bwebpack-dev-server\b/,
  /(^|\/)claude(\s|$)/, /\bClaude\b/, /\bCode Helper\b/, /Visual Studio Code/, /\bCursor\b/,
  /-daemon\.mjs(\s|$)/, /\/launchd\//,
]);

/** `ps` etime `[[dd-]hh:]mm:ss` → ms; null when unparseable. */
export function parseEtime(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime ?? '').trim());
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return (((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s)) * 1000;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/;
/** Parse `ps -axww -o pid=,ppid=,pgid=,uid=,etime=,lstart=,command=`. `started` (lstart) pins identity. */
export function parseReaperPs(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = PS_LINE.exec(raw);
    if (!m) continue;
    const ageMs = parseEtime(m[5]);
    if (ageMs === null) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), ageMs,
      started: m[6].replace(/\s+/g, ' '), command: m[7].trim() });
  }
  return out;
}

/** One process, not one pid: pid + start time + command line (a recycled pid differs in at least one). */
export const processIdentity = (p) => `${p.pid}|${p.started ?? ''}|${p.command}`;

/**
 * PURE: which processes to reap. `ctx`: { uid, selfPid, settings, isAlive(pid), jobPids:Set }.
 * Returns { reap: [{pid, signature, ageMs, reason, command}], skipped: {reason: count} }.
 */
export function planOrphanReap(procs, { uid, selfPid, settings, isAlive, jobPids = new Set(), leaseScanComplete = true }) {
  const reap = [];
  const skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  for (const p of procs) {
    if (p.uid !== uid || p.pid <= 1 || p.pid === selfPid) continue;
    let sig = null; let why = null;
    for (const s of ORPHAN_SIGNATURES) { why = s.match(p, { isAlive }); if (why) { sig = s; break; } }
    if (!sig) continue;
    if (NEVER_REAP_PATTERNS.some((re) => re.test(p.command))) { skip('never-reap-pattern'); continue; }
    if (p.ppid !== 1) { skip('live-parent'); continue; }
    const maxAgeMs = settings[sig.maxAgeKey] * MINUTE;
    if (!(p.ageMs >= maxAgeMs)) { skip('younger-than-max-age'); continue; }
    if (jobPids.has(p.pid)) { skip('live-job-record'); continue; }
    if (!leaseScanComplete && !sig.leaseFree) { skip('lease-scan-incomplete'); continue; }
    if (p.pgid > 1 && p.pgid !== p.pid && isAlive(p.pgid)) { skip('live-group-leader'); continue; }
    reap.push({ pid: p.pid, signature: sig.id, ageMs: p.ageMs, started: p.started, command: p.command,
      reason: `${why}; orphaned (ppid 1); age ${Math.round(p.ageMs / 1000)}s >= ${settings[sig.maxAgeKey]}min` });
  }
  return { reap, skipped };
}

// ── SETTINGS ───────────────────────────────────────────────────────────────────────────────────────────────

const envKey = (k) => `WE_ORPHAN_REAPER_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
export function resolveOrphanReaperSettings({ config = {}, env = process.env, read = readFileSync, log = console.error } = {}) {
  const errors = []; let tool = {};
  try { tool = JSON.parse(read(join(ROOT, 'scripts/settings/orphan-reaper.json'), 'utf8')).orphanReaper ?? {}; } catch (e) { errors.push(`settings: ${e.message}`); }
  const envValues = {};
  for (const k of Object.keys(ORPHAN_REAPER_DEFAULTS)) {
    const raw = env?.[envKey(k)];
    if (raw === undefined) continue;
    envValues[k] = typeof ORPHAN_REAPER_DEFAULTS[k] === 'boolean'
      ? (['1', 'true'].includes(raw) ? true : ['0', 'false'].includes(raw) ? false : raw) : Number(raw);
  }
  const valid = Object.fromEntries(Object.keys(ORPHAN_REAPER_DEFAULTS).map((k) => [k,
    (v) => (typeof ORPHAN_REAPER_DEFAULTS[k] === 'boolean' ? typeof v === 'boolean' : Number.isFinite(v) && v > 0)]));
  const platform = readPlatformPreferences({ env, readFile: read }); errors.push(...platform.errors);
  const out = cascadePolicy('orphanReaper', { ...tool, ...config.orphanReaper }, {
    standard: ORPHAN_REAPER_DEFAULTS, envValues, valid, platform: platform.prefs.orphanReaper ?? {}, env,
  });
  log(formatCascadeSourcesLine('orphanReaper', out));
  return { ...out, errors: [...errors, ...(out.invalid ?? [])] };
}

// ── IO SHELL ───────────────────────────────────────────────────────────────────────────────────────────────

export function listProcesses({ exec = execFileSync } = {}) {
  return parseReaperPs(exec('ps', ['-axww', '-o', 'pid=,ppid=,pgid=,uid=,etime=,lstart=,command='], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }));
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Pids named by a non-terminal record in any daemon's job store — a live lease on that process. `complete` is
 * false when any store could not be read or holds a corrupt record: a lease we cannot read is not proof of none.
 */
export function readLiveJobPids({ root = daemonJobsRoot() } = {}) {
  const pids = new Set();
  let complete = true;
  if (!existsSync(root)) return { pids, complete };
  let names;
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return { pids, complete: false }; }
  for (const name of names) {
    try {
      const { records, corrupt } = createJobStore(join(root, name)).list();
      if (corrupt?.length) complete = false;
      for (const r of records) {
        if (!TERMINAL_JOB_STATUSES.includes(r?.job?.status) && Number.isInteger(r?.job?.pid)) pids.add(r.job.pid);
      }
    } catch { complete = false; }
  }
  return { pids, complete };
}

const asLeaseScan = (v) => (v instanceof Set ? { pids: v, complete: true } : v);

/**
 * One reap pass. Returns { dryRun, planned, reaped:[{pid,signature,ageMs,reason,signal}], failed, skipped }.
 * `dryRun` never sends a signal. Before EACH signal the host is re-scanned and the full eligibility re-run, and
 * only a process with the SAME identity (pid + start time + command) that is still eligible is signalled.
 */
export async function reapOrphans({
  settings, dryRun = settings.dryRun, list = listProcesses, isAlive = pidAlive, jobPids = readLiveJobPids,
  kill = (pid, sig) => process.kill(pid, sig), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  uid = process.getuid(), selfPid = process.pid, logPath = null, log = console.error, now = Date.now(),
} = {}) {
  const scan = () => {
    const lease = asLeaseScan(typeof jobPids === 'function' ? jobPids() : jobPids);
    const procs = list();
    const plan = planOrphanReap(procs, { uid, selfPid, settings, isAlive, jobPids: lease.pids, leaseScanComplete: lease.complete });
    return { plan, eligible: new Map(plan.reap.map((c) => [processIdentity(c), c])), present: new Set(procs.map(processIdentity)) };
  };
  const record = (entry) => {
    const line = `orphan-reaper: ${dryRun ? 'would reap' : `reaped (${entry.signal})`} pid=${entry.pid} signature=${entry.signature} age=${Math.round(entry.ageMs / 1000)}s reason="${entry.reason}"`;
    log(line);
    if (logPath) {
      try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, `${JSON.stringify({ at: new Date(now).toISOString(), dryRun, ...entry, command: entry.command.slice(0, 300) })}\n`); } catch { /* best effort */ }
    }
  };
  const first = scan();
  const reaped = []; const failed = [];
  if (dryRun) {
    for (const c of first.plan.reap) { record({ ...c, signal: null }); reaped.push({ ...c, signal: null }); }
    return { dryRun, planned: first.plan.reap.length, reaped, failed, skipped: first.plan.skipped };
  }
  const signal = (c, sig) => {
    try { kill(c.pid, sig); return true; } catch (e) {
      if (e.code !== 'ESRCH') failed.push({ pid: c.pid, signal: sig, error: e.code || e.message });
      return false;
    }
  };
  const beforeTerm = first.plan.reap.length ? scan() : first;
  const termed = [];
  for (const c of first.plan.reap) {
    const fresh = beforeTerm.eligible.get(processIdentity(c));
    if (fresh && signal(fresh, 'SIGTERM')) termed.push(fresh);
  }
  if (termed.length) await sleep(settings.termGraceSeconds * 1000);
  const beforeKill = termed.length ? scan() : beforeTerm;
  for (const c of termed) {
    const id = processIdentity(c);
    if (beforeKill.eligible.has(id)) {
      if (!signal(c, 'SIGKILL')) continue;
      const entry = { ...c, signal: 'SIGKILL' }; record(entry); reaped.push(entry);
    } else if (beforeKill.present.has(id)) {
      // Still there but no longer eligible (e.g. a lease appeared): never escalate.
      log(`orphan-reaper: kept pid=${c.pid} signature=${c.signature} after SIGTERM — no longer eligible, not escalating`);
      const entry = { ...c, signal: 'SIGTERM' }; record(entry); reaped.push(entry);
    } else {
      const entry = { ...c, signal: 'SIGTERM' }; record(entry); reaped.push(entry);
    }
  }
  return { dryRun, planned: first.plan.reap.length, reaped, failed, skipped: first.plan.skipped };
}

/** Flags a real health-watch tick may carry. Any other flag (a fixture, a state root, an injected clock) is a test
 *  or a replay — never the place to signal processes on the real host. */
export const REAL_TICK_FLAGS = Object.freeze(['dry-run', 'no-gh', 'no-notify', 'json', '_']);
/** A real host tick only: never under any non-real flag, and never from inside a test run unless the pass is injected. */
export function orphanReaperTickAllowed(flags = {}, { injected = false, env = process.env } = {}) {
  if (injected) return true;
  if (env.WE_UNDER_TEST === '1') return false;
  return !Object.entries(flags).some(([k, v]) => v && !REAL_TICK_FLAGS.includes(k));
}

/** The health-watch pass: cadence-gated by `intervalMinutes` on `state.lastRunAt`. */
export async function runOrphanReaperPass({ now = Date.now(), state = {}, settings, forceDryRun = false, logPath, ...deps } = {}) {
  const cfg = settings.value;
  if (!cfg.enabled) return { state, result: null };
  const last = Number(state?.lastRunAt);
  if (Number.isFinite(last) && last <= now && now - last < cfg.intervalMinutes * MINUTE) return { state, result: null };
  const result = await reapOrphans({ settings: cfg, dryRun: forceDryRun || cfg.dryRun, logPath, now, ...deps });
  return {
    state: { lastRunAt: now, dryRun: result.dryRun, planned: result.planned, reaped: result.reaped.length, failed: result.failed.length, skipped: result.skipped },
    result,
  };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_CLI) {
  const args = new Set(process.argv.slice(2));
  const settings = resolveOrphanReaperSettings();
  const result = await reapOrphans({ settings: settings.value, dryRun: !args.has('--apply') });
  const out = { dryRun: result.dryRun, planned: result.planned, skipped: result.skipped, failed: result.failed,
    reaped: result.reaped.map(({ command, ...r }) => ({ ...r, command: command.slice(0, 160) })) };
  if (args.has('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    const bySig = {};
    for (const r of result.reaped) bySig[r.signature] = (bySig[r.signature] ?? 0) + 1;
    console.log(`orphan-reaper ${result.dryRun ? 'DRY RUN' : 'APPLIED'}: ${result.planned} candidate(s) ${JSON.stringify(bySig)}; skipped ${JSON.stringify(result.skipped)}; failed ${result.failed.length}`);
  }
}
