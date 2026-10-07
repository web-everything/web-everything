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
  const inFlight = last.inFlight?.length ?? 0;
  const itemRoom = last.openItems ? Math.max(0, (last.openItems.cap ?? Infinity) - (last.openItems.count ?? 0)) : Infinity;
  const freeSlots = Math.max(0, Math.min(buildCap - inFlight, itemRoom));
  const lastLaunch = [...sorted].reverse().find(launched);
  const sinceMs = now - Date.parse(lastLaunch ? lastLaunch.at : sorted[0].at);
  const minutesSinceLaunch = lastLaunch ? Math.round(sinceMs / MIN) : null;
  const coverageMin = Math.round((now - Date.parse(sorted[0].at)) / MIN);
  const quiet = sinceMs >= thresholdMin * MIN;
  const daemonStale = tickAgeMin > staleTickMin;
  const starved = !daemonStale && queued > 0 && freeSlots > 0 && quiet;
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
export function classifyPrMovement(prs, { now = Date.now(), stalledMin = 90 } = {}) {
  const out = { moving: [], stalled: [], conflicting: [], red: [], changesRequested: [] };
  for (const pr of prs) {
    const ageMin = (now - Date.parse(pr.updatedAt)) / MIN;
    const flagged = [];
    if (pr.mergeable === 'CONFLICTING') { out.conflicting.push(pr); flagged.push(1); }
    if ((pr.statusCheckRollup ?? []).some((c) => ['FAILURE', 'TIMED_OUT'].includes(String(c.conclusion).toUpperCase()))) { out.red.push(pr); flagged.push(1); }
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

// ── IO shell ──────────────────────────────────────────────────────────────────────────────────────────────────

function readTickRows(coordRoot) {
  const text = ['build-dispatch-daemon.log.2', 'build-dispatch-daemon.log.1', 'build-dispatch-daemon.log']
    .map((n) => { try { return readFileSync(join(coordRoot, n), 'utf8'); } catch { return ''; } }).join('\n');
  return parseTickRows(text);
}

function runPrMovement({ now, env }) {
  const repo = env.WE_SWEEP_REPO || 'web-everything/web-everything';
  const attention = [];
  const sections = [];
  const star = assessBuilderStarvation(readTickRows(resolveCoordinationRoot()), {
    now, thresholdMin: posInt(env.WE_SWEEP_STARVE_MIN, 60), buildCap: posInt(env.WE_SWEEP_BUILD_CAP, 1),
  });
  if (star.starved || star.daemonStale) attention.push(star.summary);
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

function runCoroner({ env, dryRun }) {
  const args = [join(HERE, 'coroner-extract.mjs'), '--since=last', '--json', ...(dryRun ? ['--no-save'] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * MIN, env });
  if (r.status !== 0) return { attention: [`coroner extract failed (exit ${r.status}): ${String(r.stderr).split('\n')[0]}`], sections: [] };
  let j; try { j = JSON.parse(r.stdout); } catch { return { attention: ['coroner extract returned non-JSON'], sections: [] }; }
  const lines = Object.entries(j.errorRates ?? {}).map(([k, m]) => `${k}: ${m.count}/${m.total} (${m.pct}%)`);
  return { attention: [], sections: [{ title: 'Error rates', lines: lines.length ? lines : ['none reported'] }], data: { keys: Object.keys(j) } };
}

function opusCommand() {
  return { cmd: 'claude', args: ['-p', '--model', 'opus', '--allowedTools', 'Read,Grep,Glob', '--add-dir', REPO_ROOT],
    briefPath: join(REPO_ROOT, 'skills-src/conveyor/opus-sweep-brief.md') };
}
function runOpus({ dryRun }) {
  const { cmd, args, briefPath } = opusCommand();
  if (dryRun) return { attention: [], sections: [{ title: 'Would run', lines: [`${cmd} ${args.join(' ')} < ${briefPath}`] }] };
  const r = spawnSync(cmd, args, { input: readFileSync(briefPath, 'utf8'), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30 * MIN, cwd: REPO_ROOT });
  if (r.status !== 0) return { attention: [`opus sweep failed (exit ${r.status})`], sections: [] };
  return { attention: [], sections: [{ title: 'Opus findings', lines: String(r.stdout).split('\n').filter(Boolean).slice(0, 80) }] };
}

export function runJob(job, { dryRun = false, now = Date.now(), env = process.env } = {}) {
  const fn = { 'pr-movement': runPrMovement, coroner: runCoroner, opus: runOpus }[job];
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
  const sig = createHash('sha1').update(report.attention.join('\n')).digest('hex');
  const sigFile = join(dir, 'last-attention.sha');
  let prev = ''; try { prev = readFileSync(sigFile, 'utf8'); } catch { /* first run */ }
  let notified = false;
  if (report.attention.length && sig !== prev) notified = notifyDesktopChecked({ title: `${report.job} sweep`, body: report.attention.slice(0, 3).join(' | ') }).ok;
  writeFileSync(sigFile, sig);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
