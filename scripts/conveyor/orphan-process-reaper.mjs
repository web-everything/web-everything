#!/usr/bin/env node
/**
 * @file scripts/conveyor/orphan-process-reaper.mjs
 * @description Automatic cleanup of LOST processes our own jobs left behind — a standalone periodic pass.
 *
 * Live-caught 2026-10-20: 154 orphaned test keep-alives (`node -e` empty-callback setInterval), up to 19 days old,
 * ~864 MB; beside them orphaned `node (vitest)` runners and test fixtures still running out of a dead vitest run's
 * private temp root. Nothing ever stopped them.
 *
 * WHAT IT MAY TOUCH — a CLOSED allowlist ({@link ORPHAN_SIGNATURES}), matched on the PROGRAM node runs (argv[1],
 * resolved against the process's own cwd) or on the whole `-e` program — never on a flag value or on text
 * elsewhere in the arguments. A command line it cannot parse with certainty never matches. A process is reaped
 * only when ALL hold:
 *   - it runs as this user, is not this process, and its parent is gone (ppid 1 — orphaned);
 *   - its program matches one allowlisted signature, and its command line matches none of
 *     {@link NEVER_REAP_PATTERNS} (dev servers, editors, Claude sessions, daemons);
 *   - it is older than that signature's max age;
 *   - the daemon-job lease scan read EVERY job store completely (a missing, unreadable or corrupt store means
 *     "unknown", and unknown never reaps), and no non-terminal job record names its pid;
 *   - its process group leader (when it is not its own leader) is not alive.
 * Anything with a live parent, a live lease or a live group leader is never touched.
 *
 * HOW. Immediately before EACH signal — SIGTERM, then SIGKILL after `termGraceSeconds` — that one process is
 * re-read and the whole eligibility (identity = pid + start time + command, orphaned, age, lease scan, group
 * leader) is re-run; only a still-eligible process with the SAME identity is signalled. The residual window
 * between that re-read and `kill(2)` is a few milliseconds and cannot be closed from user space on macOS (no
 * pidfd). Every reap (and every would-reap in dry-run) is logged with pid, signature, age and reason, to stderr
 * and to the JSONL log.
 *
 * SETTINGS — the shared policy cascade with logged sources (standard → platform → tool → env):
 *   tool file `scripts/settings/orphan-reaper.json` (`orphanReaper`), env `WE_ORPHAN_REAPER_<KEY>`
 *   (e.g. `WE_ORPHAN_REAPER_DRY_RUN=0`). Ships with `dryRun: true` — it only reports what it would reap.
 *
 * CLI:
 *   `node scripts/conveyor/orphan-process-reaper.mjs [--json]`   one pass, ALWAYS a dry run (read-only)
 *   `node scripts/conveyor/orphan-process-reaper.mjs tick`        the periodic entry: cadence-gated on its own
 *       state file, honours the settings (dry-run unless the operator turned it off). Not yet wired into a
 *       daemon — the health-watch hook-in follows once its open health-watch.mjs change lands.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, formatCascadeSourcesLine, readPlatformPreferences } from '../lib/policy-cascade.mjs';
import { daemonJobsRoot } from '../operations/run-store.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MINUTE = 60_000;

/** `scripts/lib/test-keepalive.mjs#KEEPALIVE_MARKER` — the first bytes of every managed keep-alive's `-e` program. */
export const KEEPALIVE_MARKER = '/*we-keepalive*/';

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

/** node options that take NO separate value. Any other option without `=` might swallow the next token, so the
 *  program cannot be resolved with certainty — and an unresolvable program never matches. */
const NODE_BOOLEAN_FLAGS = new Set([
  '--no-warnings', '--no-deprecation', '--trace-warnings', '--trace-deprecation', '--enable-source-maps',
  '--expose-gc', '--experimental-vm-modules', '--preserve-symlinks', '--no-experimental-fetch',
]);

/**
 * PURE: parse a `ps` command line run by node. Returns `{ kind: 'eval', program }` for `node [flags] -e <program>`
 * (the program is the rest of the line), `{ kind: 'script', script }` for `node [flags] <script> …`, or null when
 * it is not node or the program cannot be resolved with certainty.
 */
export function parseNodeCommand(command) {
  const text = String(command ?? '');
  const tokens = [];
  for (const m of text.matchAll(/\S+/g)) tokens.push({ value: m[0], index: m.index });
  if (!tokens.length || !/^(?:\S*\/)?node$/.test(tokens[0].value)) return null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i].value;
    if (t === '-e' || t === '--eval') {
      const next = tokens[i + 1];
      return next ? { kind: 'eval', program: text.slice(next.index) } : null;
    }
    if (t === '--') return tokens[i + 1] ? { kind: 'script', script: tokens[i + 1].value } : null;
    if (t.startsWith('-')) {
      if (t.startsWith('--') && t.includes('=')) continue;
      if (NODE_BOOLEAN_FLAGS.has(t)) continue;
      return null; // an option that may take a separate value: not certain which token is the program
    }
    return { kind: 'script', script: t };
  }
  return null;
}

const LEGACY_KEEPALIVE_PROGRAM = /^(?:process\.(?:on|once)\([^\n]*?\);\s*)*setInterval\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*,\s*[\d.e_]+\s*\);?\s*$/;
/** A run's private temp root (`scripts/lib/test-tmp-root.mjs`): `<tmp>/we-vitest/<runner pid>-<suffix>/`. */
const VITEST_TMP_ROOT = /\/we-vitest\/(\d+)-[A-Za-z0-9]+\//;
const scriptIs = (suffix) => (p) => p?.kind === 'script' && p.resolved?.endsWith(suffix);

/**
 * The closed allowlist. `match(proc, ctx)` gets `proc.program` = {@link parseNodeCommand} output with
 * `resolved` (argv[1] made absolute against the process cwd, or null) and returns a reason string, or null.
 */
export const ORPHAN_SIGNATURES = Object.freeze([
  {
    id: 'test-keepalive', maxAgeKey: 'keepAliveMaxAgeMinutes',
    match: ({ program: p }) => (p?.kind === 'eval'
      && (p.program.startsWith(KEEPALIVE_MARKER) || LEGACY_KEEPALIVE_PROGRAM.test(p.program)) ? 'test keep-alive (node -e idle program)' : null),
  },
  {
    // The program itself lives in, or (for `-e`) names, a DEAD vitest run's private temp root: that root is made
    // per run for tests only and removed at teardown, so nothing outside a test run ever runs from it.
    id: 'vitest-tmp-fixture', maxAgeKey: 'vitestFixtureMaxAgeMinutes',
    match: ({ program: p }, { isAlive }) => {
      const where = p?.kind === 'eval' ? p.program : p?.kind === 'script' ? p.resolved : null;
      const m = where ? VITEST_TMP_ROOT.exec(where) : null;
      if (!m) return null;
      return isAlive(Number(m[1])) ? null : `test fixture of dead vitest run ${m[1]}`;
    },
  },
  {
    id: 'vitest', maxAgeKey: 'vitestMaxAgeMinutes',
    match: ({ command, program: p }) => (/^node \(vitest(?: \d+)?\)\s*$/.test(command)
      || (p?.kind === 'script' && /\/(?:vitest\/vitest\.mjs|node_modules\/\.bin\/vitest)$/.test(p.resolved ?? '') && p.next === 'run')
      ? 'vitest runner' : null),
  },
  { id: 'verify-lane', maxAgeKey: 'verifyLaneMaxAgeMinutes', match: (x) => (scriptIs('/scripts/verify-lane.mjs')(x.program) ? 'verify-lane gate' : null) },
  { id: 'codex-direct-task', maxAgeKey: 'codexTaskMaxAgeMinutes', match: (x) => (scriptIs('/scripts/codex-direct-task.mjs')(x.program) ? 'codex-direct-task wrapper' : null) },
  { id: 'review-job', maxAgeKey: 'reviewJobMaxAgeMinutes', match: (x) => (scriptIs('/scripts/operations/review-job.mjs')(x.program) ? 'review-job' : null) },
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
/** Parse `ps -o pid=,ppid=,pgid=,uid=,etime=,lstart=,command=`. `started` (lstart) pins identity. */
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

/** PURE: the program a process runs — argv[1] resolved against `cwd` (null when it cannot be). */
export function resolveProgram(command, cwd) {
  const p = parseNodeCommand(command);
  if (!p) return null;
  if (p.kind === 'eval') return p;
  const resolved = isAbsolute(p.script) ? resolve(p.script) : (cwd ? resolve(cwd, p.script) : null);
  const after = String(command).slice(String(command).indexOf(p.script) + p.script.length).trim().split(/\s+/)[0] || null;
  return { ...p, resolved, next: after };
}

/**
 * PURE: decide for ONE process. ctx: { uid, selfPid, settings, isAlive(pid), lease: {pids:Set, complete:bool},
 * cwdOf(pid) }. Returns { reap: {pid, signature, ageMs, started, command, reason} } or { skip: reason } or {}.
 */
export function judgeProcess(p, { uid, selfPid, settings, isAlive, lease, cwdOf = () => null }) {
  if (p.uid !== uid || p.pid <= 1 || p.pid === selfPid) return {};
  // Cheap pre-filter before any cwd lookup: only node processes (or vitest's own title) can match.
  if (!/^node \(vitest/.test(p.command) && !parseNodeCommand(p.command)) return {};
  const needsCwd = parseNodeCommand(p.command)?.kind === 'script' && !isAbsolute(parseNodeCommand(p.command).script);
  const proc = { ...p, program: resolveProgram(p.command, needsCwd ? cwdOf(p.pid) : null) };
  let sig = null; let why = null;
  for (const s of ORPHAN_SIGNATURES) { why = s.match(proc, { isAlive }); if (why) { sig = s; break; } }
  if (!sig) return {};
  if (NEVER_REAP_PATTERNS.some((re) => re.test(p.command))) return { skip: 'never-reap-pattern' };
  if (p.ppid !== 1) return { skip: 'live-parent' };
  if (!(p.ageMs >= settings[sig.maxAgeKey] * MINUTE)) return { skip: 'younger-than-max-age' };
  if (!lease?.complete) return { skip: 'lease-scan-incomplete' };
  if (lease.pids.has(p.pid)) return { skip: 'live-job-record' };
  if (p.pgid > 1 && p.pgid !== p.pid && isAlive(p.pgid)) return { skip: 'live-group-leader' };
  return { reap: { pid: p.pid, signature: sig.id, ageMs: p.ageMs, started: p.started, command: p.command,
    reason: `${why}; orphaned (ppid 1); age ${Math.round(p.ageMs / 1000)}s >= ${settings[sig.maxAgeKey]}min` } };
}

/** PURE: judge every process. Returns { reap: [...], skipped: {reason: count} }. */
export function planOrphanReap(procs, ctx) {
  const reap = []; const skipped = {};
  for (const p of procs) {
    const v = judgeProcess(p, ctx);
    if (v.reap) reap.push(v.reap);
    else if (v.skip) skipped[v.skip] = (skipped[v.skip] ?? 0) + 1;
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

const PS_FIELDS = 'pid=,ppid=,pgid=,uid=,etime=,lstart=,command=';
export function listProcesses({ exec = execFileSync } = {}) {
  return parseReaperPs(exec('ps', ['-axww', '-o', PS_FIELDS], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 }));
}
/** Re-read ONE process; null when it is gone. */
export function readProcess(pid, { exec = execFileSync } = {}) {
  try { return parseReaperPs(exec('ps', ['-ww', '-o', PS_FIELDS, '-p', String(pid)], { encoding: 'utf8', timeout: 15_000 }))[0] ?? null; } catch { return null; }
}
/** A process's cwd via lsof; null when unknown (an unknown cwd never resolves a relative program). */
export function readCwd(pid, { exec = execFileSync } = {}) {
  try {
    const out = exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 15_000 });
    const line = out.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch { return null; }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Pids named by a non-terminal record in any daemon's job store — a live lease on that process. FAIL CLOSED:
 * `complete` is false when the root is missing or unreadable, or any store or `*.json` file in it cannot be
 * read or parsed — a lease we cannot read is never proof of no lease. Parseable JSON that is not a job record
 * (a kind's own sidecar) is skipped.
 */
export function readLiveJobPids({ root = daemonJobsRoot(), fs = { readdirSync, readFileSync } } = {}) {
  const pids = new Set();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { pids, complete: false }; }
  let complete = true;
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(join(root, d.name)); } catch { complete = false; continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(join(root, d.name, f), 'utf8')); } catch { complete = false; continue; }
      const job = r && typeof r === 'object' && !Array.isArray(r) ? r.job : null;
      if (job && typeof job === 'object' && !TERMINAL_JOB_STATUSES.includes(job.status) && Number.isInteger(job.pid)) pids.add(job.pid);
    }
  }
  return { pids, complete };
}

/**
 * One reap pass. Returns { dryRun, planned, reaped:[{pid,signature,ageMs,reason,signal}], failed, skipped }.
 * `dryRun` never sends a signal. Before EACH signal, that process is re-read and fully re-judged
 * ({@link judgeProcess}, with a fresh lease scan); only the same identity, still eligible, is signalled.
 */
export async function reapOrphans({
  settings, dryRun = settings.dryRun, list = listProcesses, readOne = readProcess, cwdOf = readCwd,
  isAlive = pidAlive, leaseScan = readLiveJobPids,
  kill = (pid, sig) => process.kill(pid, sig), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  uid = process.getuid(), selfPid = process.pid, logPath = null, log = console.error, now = Date.now(),
} = {}) {
  const ctx = () => ({ uid, selfPid, settings, isAlive, cwdOf, lease: leaseScan() });
  const record = (entry) => {
    log(`orphan-reaper: ${dryRun ? 'would reap' : `reaped (${entry.signal})`} pid=${entry.pid} signature=${entry.signature} age=${Math.round(entry.ageMs / 1000)}s reason="${entry.reason}"`);
    if (logPath) {
      try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, `${JSON.stringify({ at: new Date(now).toISOString(), dryRun, ...entry, command: entry.command.slice(0, 300) })}\n`); } catch { /* best effort */ }
    }
  };
  const plan = planOrphanReap(list(), ctx());
  const reaped = []; const failed = [];
  if (dryRun) {
    for (const c of plan.reap) { const e = { ...c, signal: null }; record(e); reaped.push(e); }
    return { dryRun, planned: plan.reap.length, reaped, failed, skipped: plan.skipped };
  }
  /** Re-read + re-judge this one process right now; signal only if it is the same process and still eligible. */
  const signalIfStillEligible = (c, sig) => {
    const fresh = readOne(c.pid);
    if (!fresh || processIdentity(fresh) !== processIdentity(c)) return 'gone';
    const verdict = judgeProcess(fresh, ctx());
    if (!verdict.reap) return `ineligible:${verdict.skip ?? 'no-signature'}`;
    try { kill(c.pid, sig); return 'sent'; } catch (e) {
      if (e.code === 'ESRCH') return 'gone';
      failed.push({ pid: c.pid, signal: sig, error: e.code || e.message });
      return 'failed';
    }
  };
  const termed = [];
  for (const c of plan.reap) {
    const r = signalIfStillEligible(c, 'SIGTERM');
    if (r === 'sent') termed.push(c);
    else if (r.startsWith('ineligible')) log(`orphan-reaper: kept pid=${c.pid} signature=${c.signature} — ${r} at SIGTERM`);
  }
  if (termed.length) await sleep(settings.termGraceSeconds * 1000);
  for (const c of termed) {
    const r = signalIfStillEligible(c, 'SIGKILL');
    if (r === 'failed') continue;
    if (r.startsWith('ineligible')) log(`orphan-reaper: kept pid=${c.pid} signature=${c.signature} after SIGTERM — ${r}, not escalating`);
    const entry = { ...c, signal: r === 'sent' ? 'SIGKILL' : 'SIGTERM' }; record(entry); reaped.push(entry);
  }
  return { dryRun, planned: plan.reap.length, reaped, failed, skipped: plan.skipped };
}

/** The periodic pass: cadence-gated by `intervalMinutes` on `state.lastRunAt`. */
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

/** `<WE_ORPHAN_REAPER_STATE_DIR || ~/.claude/orphan-reaper>` — the tick's own cadence state and JSONL log. */
export function reaperStateDir(env = process.env) {
  const v = env?.WE_ORPHAN_REAPER_STATE_DIR;
  return v && String(v).trim() ? resolve(String(v).trim()) : join(homedir(), '.claude', 'orphan-reaper');
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const settings = resolveOrphanReaperSettings();
  if (argv[0] === 'tick') {
    if (process.env.WE_UNDER_TEST === '1') { console.error('orphan-reaper: refusing a real tick inside a test run'); process.exit(2); }
    const dir = reaperStateDir();
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'state.json');
    let state = {};
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first run */ }
    const out = await runOrphanReaperPass({ state, settings, logPath: join(dir, 'orphan-reaper.jsonl') });
    if (out.result) {
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(out.state, null, 2)); renameSync(tmp, statePath);
    }
    console.log(JSON.stringify(out.result ? out.state : { skipped: 'not due or disabled' }));
  } else {
    const result = await reapOrphans({ settings: settings.value, dryRun: true });
    const summary = { dryRun: true, planned: result.planned, skipped: result.skipped,
      reaped: result.reaped.map(({ command, ...r }) => ({ ...r, command: command.slice(0, 160) })) };
    if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
    else {
      const bySig = {};
      for (const r of result.reaped) bySig[r.signature] = (bySig[r.signature] ?? 0) + 1;
      console.log(`orphan-reaper DRY RUN: ${result.planned} candidate(s) ${JSON.stringify(bySig)}; skipped ${JSON.stringify(result.skipped)}`);
    }
  }
}
