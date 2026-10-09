/**
 * @file scripts/lib/review-ledger-history.mjs
 * @description #3930 — the RUN HISTORY of `review-ledger-check`, read back as a query.
 *
 * Every check run already appends one run record (`op: 'review-ledger-check'`) to the shared runs folder. This
 * module turns that pile of records into the one answer the ledger rollout waits on (plan §4 F3, ruling D4
 * condition 2): "has the checker shown 7 clean days PER LABEL FAMILY?" — so it is a query, never a judgement.
 *
 * WHAT A CLEAN DAY IS (per family, per America/New_York calendar day):
 *   • every expected repo (default: all constellation repos) has at least one run record that day, AND
 *   • every one of those runs has `disagree === 0` for that family, AND
 *   • every one of those runs has `unreadable === 0` (an unread PR is unknown, and unknown is never clean).
 * A day where some expected repo has no run is `incomplete`; a day with no run at all is `missing`. Both break
 * a streak: "7 clean days" means 7 consecutive days with evidence, not 7 scattered ones.
 *
 * A run counts as complete only when its record says the PR list was not truncated by `--limit` (`scan.truncated
 * === false`) and `unreadable` is a validated zero. Records without that evidence are unknown.
 * Only runs for the QUERIED repos shape a day: another repo's run never starts, ends or resets the streak.
 *
 * THE STREAK counts back from today. If today has no run yet, or is still `incomplete` (some repo has not run
 * yet), it starts from yesterday, so the morning before the runs finish does not reset a week of evidence. A
 * `drift` or `unknown` today does count.
 *
 * Pure except `readCheckRuns`, whose IO is injectable.
 */

import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { listRunIds, resolveRunsDir, tryReadRun } from '../operations/run-store.mjs';

export const CHECK_OP = 'review-ledger-check';
export const REQUIRED_CLEAN_DAYS = 7;
export const HISTORY_TZ = 'America/New_York';

/** The gh slugs of every constellation repo — the default set a clean day must cover. */
export const DEFAULT_REPOS = Object.freeze(Object.values(CONSTELLATION_REPOS).map((r) => r.slug));

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: HISTORY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** `YYYY-MM-DD` of an instant, in America/New_York. `null` for an unparseable time. Pure. */
export function etDay(at) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : dayFmt.format(d);
}

/** The ET day `n` days before `day` (`YYYY-MM-DD`). Calendar arithmetic, so DST never skips or repeats a day. Pure. */
export function dayBefore(day, n = 1) {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - n));
  // utc-day-slice-ok: pure calendar arithmetic — `t` is built AT UTC midnight of an ET calendar day, never a wall-clock read.
  return t.toISOString().slice(0, 10);
}

/**
 * Read every check run record. A corrupt record is skipped and counted (never fatal, never evidence).
 * @returns {{runs: object[], corrupt: number}}
 */
export function readCheckRuns({ dir = resolveRunsDir(), listIds = listRunIds, read = tryReadRun } = {}) {
  const runs = [];
  let corrupt = 0;
  for (const id of listIds(dir)) {
    if (!id.startsWith(`${CHECK_OP}-`)) continue;
    let rec;
    try { rec = read(id, dir); } catch { corrupt += 1; continue; }
    if (rec?.op === CHECK_OP) runs.push(rec);
  }
  return { runs, corrupt };
}

const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * One run's per-family verdict: `clean` | `drift` | `unknown`. Pure. Clean needs POSITIVE evidence of a complete
 * scan: a validated zero `unreadable`, and a `scan` that says the PR list was not cut off by `--limit`. A record
 * that omits either (older, hand-built, or a partial scan) is unknown, never clean.
 */
export function runFamilyVerdict(run, family) {
  const derived = run?.findings?.derived;
  const fam = derived?.perFamily?.[family];
  if (!fam || !isCount(fam.disagree)) return 'unknown';
  if (fam.disagree > 0) return 'drift';
  if (!isCount(derived.unreadable) || derived.unreadable > 0) return 'unknown';
  if (run.findings.scan?.truncated !== false) return 'unknown';
  return 'clean';
}

/** Every family named by any run, in first-seen order, unioned with `families`. Pure. */
function familiesOf(runs, families = []) {
  const out = [...families];
  for (const r of runs) for (const f of Object.keys(r?.findings?.derived?.perFamily ?? {})) if (!out.includes(f)) out.push(f);
  return out;
}

/**
 * Per family, per ET day: `clean` | `drift` | `unknown` | `incomplete` (an expected repo has no run that day).
 * Days with no run at all are absent from the map. Pure.
 * @returns {{families: string[], days: Record<string, Record<string, {status: string, repos: Record<string, string>}>>}}
 */
export function dailyFamilyStatus(runs = [], { repos = DEFAULT_REPOS, families = [] } = {}) {
  const fams = familiesOf(runs, families);
  const wanted = new Set(repos.map((r) => r.toLowerCase()));
  const byDay = new Map();
  for (const r of runs) {
    const day = etDay(r?.input?.at);
    const repo = r?.input?.repo;
    if (!day || !repo) continue;
    if (!wanted.has(String(repo).toLowerCase())) continue; // a repo outside the query never creates or shapes a day
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const rank = { drift: 3, unknown: 2, clean: 1 };
  const days = {};
  for (const [day, dayRuns] of [...byDay.entries()].sort()) {
    days[day] = {};
    for (const family of fams) {
      const perRepo = {};
      for (const repo of repos) {
        const verdicts = dayRuns.filter((r) => String(r.input.repo).toLowerCase() === repo.toLowerCase()).map((r) => runFamilyVerdict(r, family));
        perRepo[repo] = verdicts.length ? verdicts.reduce((a, b) => (rank[b] > rank[a] ? b : a)) : 'missing';
      }
      const vals = Object.values(perRepo);
      // unknown outranks missing: a repo that already ran with unreadable/truncated evidence breaks the streak even
      // while another repo has not run yet (a merely `incomplete` day is treated as still in progress).
      const status = vals.includes('drift') ? 'drift' : vals.includes('unknown') ? 'unknown' : vals.includes('missing') ? 'incomplete' : 'clean';
      days[day][family] = { status, repos: perRepo };
    }
  }
  return { families: fams, days };
}

/**
 * THE QUERY: clean days per label family. `streak` is consecutive clean days ending today (or yesterday when today
 * has no run yet); `ready` is `streak >= required`. `window` lists the last `windowDays` days, oldest first. Pure.
 */
export function cleanDaysPerFamily(runs = [], { repos = DEFAULT_REPOS, families = [], now = new Date(), windowDays = REQUIRED_CLEAN_DAYS, required = REQUIRED_CLEAN_DAYS } = {}) {
  const { families: fams, days } = dailyFamilyStatus(runs, { repos, families });
  const today = etDay(now);
  const result = {};
  for (const family of fams) {
    const statusOn = (day) => days[day]?.[family]?.status ?? 'missing';
    // Today is still being filled in while it is `incomplete` (a repo has not run yet) or absent, so the streak
    // starts from yesterday. A `drift` or `unknown` today is real evidence against the streak and counts now.
    const todayStatus = statusOn(today);
    let cursor = todayStatus === 'incomplete' || todayStatus === 'missing' ? dayBefore(today) : today;
    let streak = 0;
    while (statusOn(cursor) === 'clean') { streak += 1; cursor = dayBefore(cursor); }
    const window = [];
    for (let i = windowDays - 1; i >= 0; i -= 1) { const day = dayBefore(today, i); window.push({ day, status: statusOn(day) }); }
    result[family] = { streak, cleanInWindow: window.filter((w) => w.status === 'clean').length, ready: streak >= required, window };
  }
  return { today, repos: [...repos], required, families: result };
}

/** Human lines for the query. Pure. */
export function renderCleanDays(q, { corrupt = 0, runCount = 0 } = {}) {
  const lines = [`review-ledger-check history · ${runCount} run record(s) · repos: ${q.repos.join(', ')} · today ${q.today} ET`];
  const mark = { clean: '✓', drift: 'x', unknown: '?', incomplete: '~', missing: '·' };
  for (const [family, f] of Object.entries(q.families)) {
    lines.push(`  ${family.padEnd(15)} streak ${String(f.streak).padStart(2)}/${q.required} · clean in window ${f.cleanInWindow}/${f.window.length}`
      + `  [${f.window.map((w) => mark[w.status]).join('')}]${f.ready ? '  READY' : ''}`);
  }
  if (!Object.keys(q.families).length || !runCount) lines.push('  no run records yet — run `npm run review:ledger-check` first.');
  lines.push('  legend: ✓ clean · x drift · ? unreadable PRs · ~ a repo has no run · · no run');
  if (corrupt) lines.push(`  ${corrupt} corrupt run record(s) skipped`);
  return lines.join('\n');
}
