#!/usr/bin/env node
/**
 * @file scripts/operations/scheduled-sweep.mjs
 * @description Card 106 — durable schedules. The PR movement sweep, the coroner sweep and the Opus sweep as
 *   launchd-driven pass jobs, so none of them lives only in a chat session.
 *
 *   Wiring (existing pass-daemon pattern): `skills-src/conveyor/daemon-manifest.mjs` registers
 *   `pr-movement-sweep` (30 min), `coroner-sweep` and `opus-sweep` as NON-default passes
 *   (`defaultLaunch:false`); `skills-src/conveyor/pass-daemon.mjs --pass=<name>` runs `run <job>` here on the
 *   interval. Nothing is installed by merging this: `install-scheduled-sweeps.mjs` writes/prints the plists and
 *   the operator decides.
 *
 *   Where the operator sees results: every run writes `<reports>/<job>/<timestamp>.md` and `latest.md`
 *   (`WE_SWEEP_REPORTS_DIR`, default `~/workspace/.operations/reports/sweeps`) and sends ONE desktop
 *   notification when the attention list changed since the last run. Dry run prints and writes nothing.
 *
 *   BUILDER STARVATION (the 2026-10-07 overnight incident: ~7 h with a queue, free capacity and no launch,
 *   unnoticed because the sweep only looked at PRs). The PR movement report ALSO reports: queued > 0, free
 *   build capacity, and no build or prepare launched for `WE_SWEEP_STARVE_MIN` minutes (default 60). It reads the
 *   build-dispatch daemon's own tick rows. If a `builder-starved` health smell lands on main, read that instead
 *   (see `assessBuilderStarvation`'s one call site).
 *
 *   Usage: node scripts/operations/scheduled-sweep.mjs run <pr-movement|coroner|opus> [--dry-run] [--json]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveCoordinationRoot } from './coordination-root.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { notifyDesktopChecked } from '../conveyor/branch-sync.mjs';

const MIN = 60_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

export const SWEEP_JOBS = {
  'pr-movement': { pass: 'pr-movement-sweep', intervalMs: 30 * MIN },
  coroner: { pass: 'coroner-sweep', intervalMs: 6 * 60 * MIN },
  opus: { pass: 'opus-sweep', intervalMs: 24 * 60 * MIN },
};

const posInt = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// ── builder starvation (pure) ─────────────────────────────────────────────────────────────────────────────────

/** Tick rows from the build-dispatch daemon log text: JSON lines carrying `at` + `status`. */
export function parseTickRows(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const j = JSON.parse(line);
      if (j && typeof j.at === 'string' && Number.isFinite(Date.parse(j.at)) && typeof j.status === 'string') rows.push(j);
    } catch { /* not a tick row */ }
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const launched = (row) => (row.dispatched?.length ?? 0) + (row.prepare?.launched?.length ?? 0) > 0;

/**
 * @param {object[]} rows tick rows (any order)
 * @param {{ now?: number, thresholdMin?: number, buildCap?: number, staleTickMin?: number }} o
 */
export function assessBuilderStarvation(rows, { now = Date.now(), thresholdMin = 60, buildCap = 1, staleTickMin = 30 } = {}) {
  const sorted = [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = sorted.at(-1);
  if (!last) return { starved: false, noData: true, summary: 'no build-dispatch tick rows found' };
  const tickAgeMin = Math.round((now - Date.parse(last.at)) / MIN);
  const queued = Number(/(\d+)\s+queued/.exec(last.status)?.[1] ?? 0);
  // The tick's own status line is the truth about running builds: a real row carries `2 building` with an empty
  // `inFlight` list, so counting only `inFlight` reported a busy builder as starved.
  const building = Number(/(\d+)\s+building/.exec(last.status)?.[1] ?? 0);
  const inFlight = Math.max(last.inFlight?.length ?? 0, building);
  const itemRoom = last.openItems ? Math.max(0, (last.openItems.cap ?? Infinity) - (last.openItems.count ?? 0)) : Infinity;
  const freeSlots = Math.max(0, Math.min(buildCap - inFlight, itemRoom));
  const lastLaunch = [...sorted].reverse().find(launched);
  const sinceMs = now - Date.parse(lastLaunch ? lastLaunch.at : sorted[0].at);
  const minutesSinceLaunch = lastLaunch ? Math.round(sinceMs / MIN) : null;
  const coverageMin = Math.round((now - Date.parse(sorted[0].at)) / MIN);
  const quiet = sinceMs >= thresholdMin * MIN;
  const daemonStale = tickAgeMin > staleTickMin;
  const frozen = Boolean(last.freeze?.frozen);
  const starved = !daemonStale && !frozen && queued > 0 && freeSlots > 0 && quiet;
  const since = minutesSinceLaunch != null ? `${minutesSinceLaunch} min` : `at least ${coverageMin} min (none in the log)`;
  return {
    starved, daemonStale, queued, freeSlots, inFlight, minutesSinceLaunch, coverageMin, tickAgeMin, thresholdMin,
    summary: daemonStale
      ? `build-dispatch daemon looks down: newest tick ${tickAgeMin} min old`
      : `${starved ? 'BUILDER STARVED' : 'builder ok'}: ${queued} queued, ${freeSlots} free slot(s), last build/prepare launch ${since} ago (threshold ${thresholdMin} min)`,
  };
}

// ── PR movement (pure) ────────────────────────────────────────────────────────────────────────────────────────

const labelNames = (pr) => (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
// A rollup entry is a CheckRun (`conclusion`) or a legacy commit-status StatusContext (`state`); red in either shape.
const RED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);
const RED_STATES = new Set(['FAILURE', 'ERROR']);
const isRedCheck = (c) => RED_CONCLUSIONS.has(String(c?.conclusion ?? '').toUpperCase()) || RED_STATES.has(String(c?.state ?? '').toUpperCase());
export function classifyPrMovement(prs, { now = Date.now(), stalledMin = 90 } = {}) {
  const out = { moving: [], stalled: [], conflicting: [], red: [], changesRequested: [] };
  for (const pr of prs) {
    const ageMin = (now - Date.parse(pr.updatedAt)) / MIN;
    const flagged = [];
    if (pr.mergeable === 'CONFLICTING') { out.conflicting.push(pr); flagged.push(1); }
    if ((pr.statusCheckRollup ?? []).some(isRedCheck)) { out.red.push(pr); flagged.push(1); }
    if (labelNames(pr).includes('review:changes')) { out.changesRequested.push(pr); flagged.push(1); }
    if (ageMin >= stalledMin && !pr.isDraft) { out.stalled.push(pr); flagged.push(1); }
    if (!flagged.length) out.moving.push(pr);
  }
  return out;
}

export function renderSweepReport({ job, at, attention = [], sections = [] }) {
  const lines = [`# ${job} sweep — ${at}`, ''];
  lines.push(attention.length ? '## Needs attention' : '## Needs attention: nothing', ...attention.map((a) => `- ${a}`), '');
  for (const s of sections) lines.push(`## ${s.title}`, ...s.lines.map((l) => `- ${l}`), '');
  return lines.join('\n');
}

// ── launchd templates + install plan (pure) ───────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
export function buildLaunchdPlist({ pass, repoRoot, nodePath, home }) {
  const label = `com.we.conveyor-pass-daemon.${pass}`;
  const log = `${home}/workspace/.operations/logs/${pass}.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${esc(label)}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${esc(nodePath)}</string>
		<string>${esc(repoRoot)}/skills-src/conveyor/pass-daemon.mjs</string>
		<string>--pass=${esc(pass)}</string>
	</array>
	<key>WorkingDirectory</key><string>${esc(repoRoot)}</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>10</integer>
	<key>StandardOutPath</key><string>${esc(log)}</string>
	<key>StandardErrorPath</key><string>${esc(log)}</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>WE_DAEMON_RESTART_MIN_INTERVAL_MS</key><string>120000</string>
		<key>PATH</key><string>${esc(dirname(nodePath))}:${esc(home)}/.claude/github-app-token/gh-shim:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
</dict>
</plist>
`;
}

/** Default off: `apply:false` plans no writes. Never runs launchctl; it only lists the commands for the operator. */
export function installPlan({ repoRoot, nodePath, home, apply = false }) {
  const files = Object.values(SWEEP_JOBS).map(({ pass }) => ({
    pass, path: `${home}/Library/LaunchAgents/com.we.conveyor-pass-daemon.${pass}.plist`,
    xml: buildLaunchdPlist({ pass, repoRoot, nodePath, home }),
  }));
  return {
    writes: apply ? files : [],
    commands: files.map((f) => `launchctl bootstrap gui/$(id -u) ${f.path}`),
    files,
  };
}

/**
 * Performs a plan's writes through an injectable `fs`. Never overwrites an existing file and never executes
 * anything (no launchctl): the operator loads the plists themselves. The installer script is a thin caller.
 */
export function applyInstallPlan({ plan, fs, home }) {
  const wrote = [];
  const skipped = [];
  for (const f of plan.writes) {
    if (fs.existsSync(f.path)) { skipped.push(f.path); continue; }
    fs.mkdirSync(dirname(f.path), { recursive: true });
    fs.mkdirSync(`${home}/workspace/.operations/logs`, { recursive: true });
    // `wx` is exclusive-create: it refuses an existing file AND a dangling symlink (existsSync follows links and
    // would call that path free, then write through it to the link's target).
    try { fs.writeFileSync(f.path, f.xml, { flag: 'wx' }); } catch (e) { if (e?.code === 'EEXIST') { skipped.push(f.path); continue; } throw e; }
    wrote.push(f.path);
  }
  return { wrote, skipped };
}

// ── notification de-dup (pure) ────────────────────────────────────────────────────────────────────────────────

/**
 * Signature of an attention list for "notify only when it changed": digits are masked so a persisting condition
 * keeps one signature. A condition appearing or clearing still changes it.
 */
export function attentionSignature(attention) {
  // Every count drifts run to run (minutes, queue depth, free slots, PRs ageing past a threshold): sign the SHAPE of
  // the list (which conditions hold), not the numbers, so a persisting condition notifies once.
  const stable = attention.map((a) => String(a).replace(/\d+/g, 'N'));
  return createHash('sha1').update(stable.join('\n')).digest('hex');
}

/** @returns {{ notify: boolean, sig: string }} notify only for a non-empty list whose signature differs from `prevSig`. */
export function decideNotify({ attention, prevSig = '' }) {
  const sig = attentionSignature(attention);
  return { notify: attention.length > 0 && sig !== prevSig, sig };
}

// ── IO shell ──────────────────────────────────────────────────────────────────────────────────────────────────

function readTickRows(coordRoot) {
  const text = ['build-dispatch-daemon.log.2', 'build-dispatch-daemon.log.1', 'build-dispatch-daemon.log']
    .map((n) => { try { return readFileSync(join(coordRoot, n), 'utf8'); } catch { return ''; } }).join('\n');
  return parseTickRows(text);
}

function runPrMovement({ now, env }) {
  const repo = env.WE_SWEEP_REPO || CONSTELLATION_REPOS.we.slug;
  const attention = [];
  const sections = [];
  const star = assessBuilderStarvation(readTickRows(resolveCoordinationRoot()), {
    now, thresholdMin: posInt(env.WE_SWEEP_STARVE_MIN, 60), buildCap: posInt(env.WE_SWEEP_BUILD_CAP, 1),
  });
  if (star.starved || star.daemonStale || star.noData) attention.push(star.summary);
  sections.push({ title: 'Builder starvation', lines: [star.summary] });
  let prs = [];
  try {
    prs = JSON.parse(execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json',
      'number,title,isDraft,updatedAt,labels,mergeable,statusCheckRollup'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 90_000 }));
  } catch (e) { attention.push(`gh pr list failed: ${String(e.message).split('\n')[0]}`); }
  const c = classifyPrMovement(prs, { now, stalledMin: posInt(env.WE_SWEEP_STALLED_MIN, 90) });
  const fmt = (list) => list.map((p) => `#${p.number} ${p.title.slice(0, 70)}`);
  for (const [title, list] of [['Stalled', c.stalled], ['Conflicting', c.conflicting], ['CI red', c.red], ['Send-back (review:changes)', c.changesRequested]]) {
    if (list.length) { attention.push(`${list.length} PR(s) ${title.toLowerCase()}`); sections.push({ title, lines: fmt(list) }); }
  }
  sections.push({ title: 'Totals', lines: [`${prs.length} open PR(s), ${c.moving.length} moving`] });
  return { attention, sections, data: { starvation: star, counts: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.length])) } };
}

const isRate = (m) => m && typeof m === 'object' && Number.isFinite(m.count) && Number.isFinite(m.total) && Number.isFinite(m.pct);

/** One line per metric that carries count/total/pct, walking nested groups (`byKind.code.ci`); other shapes are skipped. */
export function formatErrorRates(errorRates, prefix = '') {
  const lines = [];
  for (const [k, m] of Object.entries(errorRates ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isRate(m)) lines.push(`${path}: ${m.count}/${m.total} (${m.pct}%)`);
    else if (m && typeof m === 'object' && !Array.isArray(m)) lines.push(...formatErrorRates(m, path));
  }
  return lines;
}

const CORONER_FALLBACK_WINDOW_MS = 24 * 60 * MIN;

/** `--since=last` needs a state file; on a fresh machine fall back once to a bounded window (a non-dry run then saves the state). */
export function runCoronerJob({ env, dryRun, now = Date.now(), spawn = spawnSync }) {
  const run = (since) => spawn(process.execPath, [join(HERE, 'coroner-extract.mjs'), `--since=${since}`, '--json', ...(dryRun ? ['--no-save'] : [])],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * MIN, env });
  let r = run('last');
  // No state, or a state file the extractor rejects (invalid / future `lastEnd`): either way bound the window and let a non-dry run rewrite it.
  if (r.status !== 0 && /no previous run|valid ISO --since/.test(String(r.stderr))) r = run(new Date(now - CORONER_FALLBACK_WINDOW_MS).toISOString());
  if (r.status !== 0) return { attention: [`coroner extract failed (exit ${r.status}): ${String(r.stderr).split('\n')[0]}`], sections: [] };
  let j; try { j = JSON.parse(r.stdout); } catch { return { attention: ['coroner extract returned non-JSON'], sections: [] }; }
  const lines = formatErrorRates(j.errorRates);
  return { attention: [], sections: [{ title: 'Error rates', lines: lines.length ? lines : ['none reported'] }], data: { keys: Object.keys(j) } };
}

/**
 * The unattended Opus sweep's tool surface. `--allowedTools` only PRE-APPROVES tools and removes nothing, so the
 * built-in set is restricted with `--restricted --tools`, the mutating/networked tools are denied by name as a
 * second wall, user/project settings are ignored (`--restricted`) and the permission mode is pinned to default.
 */
export function opusCommand() {
  return {
    cmd: 'claude',
    args: ['-p', '--model', 'opus', '--restricted', '--tools', 'Read,Grep,Glob',
      '--allowedTools', 'Read,Grep,Glob', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch',
      '--permission-mode', 'default', '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', '5', '--add-dir', REPO_ROOT],
    briefPath: join(REPO_ROOT, 'skills-src/conveyor/opus-sweep-brief.md'),
  };
}
function runOpus({ dryRun }) {
  const { cmd, args, briefPath } = opusCommand();
  if (dryRun) return { attention: [], sections: [{ title: 'Would run', lines: [`${cmd} ${args.join(' ')} < ${briefPath}`] }] };
  const r = spawnSync(cmd, args, { input: readFileSync(briefPath, 'utf8'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30 * MIN, cwd: REPO_ROOT });
  if (r.status !== 0) return { attention: [`opus sweep failed (exit ${r.status}): ${r.error?.message ?? String(r.stderr ?? '').split('\n')[0]}`], sections: [] };
  return { attention: [], sections: [{ title: 'Opus findings', lines: String(r.stdout).split('\n').filter(Boolean).slice(0, 80) }] };
}

export function runJob(job, { dryRun = false, now = Date.now(), env = process.env } = {}) {
  const fn = { 'pr-movement': runPrMovement, coroner: runCoronerJob, opus: runOpus }[job];
  if (!fn) throw new Error(`unknown sweep job "${job}" (known: ${Object.keys(SWEEP_JOBS).join(', ')})`);
  const result = fn({ now, env, dryRun });
  const at = new Date(now).toISOString();
  return { job, at, ...result, markdown: renderSweepReport({ job, at, ...result }) };
}

function post(report, { env = process.env } = {}) {
  const dir = join(env.WE_SWEEP_REPORTS_DIR || join(homedir(), 'workspace', '.operations', 'reports', 'sweeps'), report.job);
  mkdirSync(dir, { recursive: true });
  const dated = join(dir, `${report.at.replace(/[:.]/g, '-')}.md`);
  writeFileSync(dated, report.markdown);
  copyFileSync(dated, join(dir, 'latest.md'));
  const sigFile = join(dir, 'last-attention.sha');
  let prev = ''; try { prev = readFileSync(sigFile, 'utf8'); } catch { /* first run */ }
  const { notify, sig } = decideNotify({ attention: report.attention, prevSig: prev });
  let notified = false;
  if (notify) notified = notifyDesktopChecked({ title: `${report.job} sweep`, body: report.attention.slice(0, 3).join(' | ') }).ok;
  // A failed notification keeps the OLD signature so the next run tries again; an empty list always records itself.
  if (!notify || notified) writeFileSync(sigFile, sig);
  return { dated, notified };
}

export function main(argv = process.argv.slice(2)) {
  const [verb, job, ...rest] = argv;
  if (verb !== 'run' || !job) { console.error('usage: scheduled-sweep.mjs run <pr-movement|coroner|opus> [--dry-run] [--json]'); return 2; }
  const dryRun = rest.includes('--dry-run');
  const report = runJob(job, { dryRun });
  const posted = dryRun ? null : post(report);
  if (rest.includes('--json')) console.log(JSON.stringify({ ...report, markdown: undefined, posted }));
  else console.log(report.markdown + (posted ? `\nposted: ${posted.dated}` : '\n(dry run: nothing written or notified)'));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
