/**
 * @file scripts/operations/perf-snapshot-io.mjs
 * @description THE IO SHELL of {@link ./perf-snapshot.mjs}: the reader its `read` step is injected with, and the sink
 *   that runs its one declared effect. See that file's header for what is measured.
 *
 * WHERE IT READS: the coroner's own exported readers (`coroner-extract.mjs#collectInputs` and `#extractMetrics`), so a
 * number here is the coroner's number; plus the build-dispatch tick log (starvation), `gh` (CI job timings and the
 * merged-PR tags). WHERE IT WRITES: the JSONL store (knob `--store` / `WE_PERF_SNAPSHOT_STORE`, default
 * `~/workspace/.operations/metrics/perf/snapshots.jsonl`) and the day's raw coroner JSON beside it at
 * `<store dir>/<YYYY-MM-DD>/coroner-<hours>h-<HHMM>Z.json` (never overwritten). Nothing inside any checkout.
 *
 * IMPURE by construction: fs, child `git`, `gh`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { readGit } from '../lib/proc-read.mjs';
import { CALIBRATION_FROM, collectVelocity, runEstimates, heldCardsPath, estimatesPath } from './perf-velocity-io.mjs';
import { calibrationStats, etParts, hourlyLines, realPointEvents } from './perf-velocity.mjs';
import { collectInputs, extractMetrics, makeGh, readBounded } from './coroner-extract.mjs';
import {
  BASELINE_DATE, BASELINE_TAKEN_AT, OPUS_REPORT, PERF_SNAPSHOT_EFFECT, REPORT_SOURCED, SCHEMA_VERSION,
  buildSnapshot, builderStarvation, ciWallMetrics, deriveChangeRequests, deriveFromCoroner, formatDiff, metric,
  parseStore, pickReferences, standardsSplit,
} from './perf-snapshot.mjs';

const MiB = 1024 * 1024;
const REPO = CONSTELLATION_REPOS.we.slug;

export const defaultStore = (env = process.env, home = homedir()) => env.WE_PERF_SNAPSHOT_STORE || join(home, 'workspace/.operations/metrics/perf/snapshots.jsonl');

/** THE REAL `readFacts`. */
export function createPerfSnapshotReader({ env = process.env, home = homedir(), now = () => new Date().toISOString() } = {}) {
  return ({ store = '' } = {}) => {
    const path = store || defaultStore(env, home);
    let rows = [];
    try { rows = parseStore(readFileSync(path, 'utf8')); } catch { rows = []; }
    const archive = env.WE_PERF_BASELINE_DIR || join(dirname(path), BASELINE_DATE);
    return {
      store: path, dir: dirname(path), now: now(), rows, hasBaseline: rows.some((r) => r.kind === 'baseline'),
      archive, archiveFound: existsSync(join(archive, 'coroner-24h.json')),
    };
  };
}

/** Build-dispatch tick rows ({at, dispatched, inFlight, capacity}) from the log tail and its rotated half. */
export function readTicks({ env = process.env, home = homedir() } = {}) {
  const file = join(env.WE_CORONER_COORD || join(home, 'workspace/.operations/coordination'), 'build-dispatch-daemon.log');
  const lines = [];
  for (const f of [`${file}.1`, file]) lines.push(...readBounded(f, { cap: 48 * MiB, tailOnly: true, maxLine: 2 * MiB }).lines);
  const out = [];
  for (const line of lines) {
    const i = line.indexOf('{"at"');
    if (i < 0) continue;
    let row; try { row = JSON.parse(line.slice(i)); } catch { continue; }
    if (row && typeof row.at === 'string') out.push({ at: row.at, dispatched: row.dispatched, inFlight: row.inFlight, capacity: row.capacity });
  }
  return out;
}

/**
 * CI wall inputs for the pure {@link ciWallMetrics}: up to `maxRuns` successful `CI` runs created in the window, as
 * `{runs, failed}`. `failed` counts runs whose jobs read failed twice (so they are NOT in `runs`): a caller that needs a
 * complete sample must check it, a short sample is never silent. `null` when the run list itself could not be read.
 */
export function fetchCiWallRuns(window, gh, { maxRuns = 40 } = {}) {
  if (typeof gh !== 'function') return null;
  const created = encodeURIComponent(`${window.since}..${window.until}`);
  const listArgs = ['api', `repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&status=success&created=${created}&per_page=100`];
  // One retry: the first gh call of a run is the one that meets a cold connection (a 45 s timeout reads as null).
  const data = gh(listArgs) ?? gh(listArgs);
  if (!data || !Array.isArray(data.workflow_runs)) return null;
  const runs = [];
  let failed = 0;
  // The newest `maxRuns` of however many the window held: `total` lets the caller say so instead of reading as the whole window.
  const total = Math.max(Number.isFinite(data.total_count) ? data.total_count : 0, data.workflow_runs.length);
  for (const r of data.workflow_runs.slice(0, maxRuns)) {
    const jobsArgs = ['api', `repos/${REPO}/actions/runs/${r.id}/jobs?per_page=100`];
    const jobs = gh(jobsArgs) ?? gh(jobsArgs);
    // A jobs list longer than one page would drop jobs (and shards) silently, so it counts as a failed read.
    if (!jobs || !Array.isArray(jobs.jobs) || jobs.total_count > jobs.jobs.length) { failed++; continue; }
    runs.push({
      wallMs: Date.parse(r.updated_at) - Date.parse(r.run_started_at || r.created_at),
      jobs: jobs.jobs.map((j) => ({
        name: j.name,
        ms: Date.parse(j.completed_at) - Date.parse(j.started_at),
        steps: Array.isArray(j.steps) ? j.steps.map((s) => ({ name: s.name, ms: Date.parse(s.completed_at) - Date.parse(s.started_at) })) : [],
      })),
    });
  }
  return { runs, failed, total };
}

/**
 * PRs merged after `sinceIso`, or `null` when gh failed. Reads closed PRs newest-updated first through the REST list
 * (not a search-backed list, which rate-limits separately) and keeps those with a `merged_at` after the cut; stops at the first page
 * whose oldest update is before the cut. Bounded to `maxPages` pages of 100.
 */
export function fetchMergedSince(sinceIso, gh, { maxPages = 5 } = {}) {
  if (typeof gh !== 'function') return null;
  const out = [];
  let reachedCut = false;
  for (let page = 1; page <= maxPages; page++) {
    const data = gh(['api', `repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`]);
    // A later page failing must not hand back a short list: tags missing PRs would misattribute a change, so say "unavailable".
    if (!Array.isArray(data)) return null;
    for (const p of data) if (p.merged_at && Date.parse(p.merged_at) > Date.parse(sinceIso)) out.push({ number: p.number, title: p.title, mergedAt: p.merged_at });
    if (data.length < 100 || Date.parse(data.at(-1)?.updated_at) < Date.parse(sinceIso)) { reachedCut = true; break; }
  }
  // `maxPages` full pages and the cut never reached: the list is short, so it is "unavailable" too, never a quiet truncation.
  return reachedCut ? out.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)) : null;
}

/** The short HEAD of `cwd`'s checkout, or null. */
export const headSha = (cwd = process.cwd()) => { try { return readGit(['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The metrics gh and the logs add on top of the coroner JSON, for one window. */
function extras({ window, markers, gh, env, home, notes, gaps = [] }) {
  const out = {};
  if (markers) Object.assign(out, standardsSplit(markers, window));
  try {
    const starved = builderStarvation(readTicks({ env, home }), window);
    Object.assign(out, starved);
    notes.push(`builder.starvedMin is a lower bound: the tick log tail held ${starved['builder.ticks']?.v ?? 0} ticks for this window`);
  } catch (e) { notes.push(`builder starvation unavailable: ${e.message}`); }
  if (gh) {
    const ci = fetchCiWallRuns(window, gh);
    if (!ci) { notes.push('CI wall unavailable: gh read failed'); gaps.push('the CI wall read failed (gh)'); }
    else {
      Object.assign(out, ciWallMetrics(ci.runs));
      if (ci.failed) {
        const why = `CI wall is incomplete: ${ci.failed} of ${ci.runs.length + ci.failed} jobs reads failed (gh); the CI metrics cover only the runs that read`;
        notes.push(why); gaps.push(why);
      }
      if (!ci.runs.length) gaps.push('no CI run was sampled in the window');
      const read = ci.runs.length + ci.failed;
      if (ci.total > read) notes.push(`CI wall is a sample: the newest ${read} of ${ci.total} successful CI runs in the window`);
    }
  } else notes.push('CI wall skipped (--no-ci)');
  return out;
}

/** The baseline row, from the archived raw coroner JSON plus the report-sourced ranges. */
export function backfillBaseline({ archive, gh, env = process.env, home = homedir() }) {
  const j24 = readJson(join(archive, 'coroner-24h.json'));
  const f48 = join(archive, 'coroner-48h.json');
  const metrics = deriveFromCoroner(j24);
  const notes = [`derived from ${join(archive, 'coroner-24h.json')} (window ${j24.window.since} to ${j24.window.until})`];
  if (existsSync(f48)) {
    const j48 = readJson(f48);
    Object.assign(metrics, deriveChangeRequests(j48.changeRequests, 'rc48'));
    notes.push(`rc48.* / pred48.* from coroner-48h.json (window ${j48.window.since} to ${j48.window.until}): the report's root-cause and predictor tables are 48 h`);
  }
  const gaps = [];
  Object.assign(metrics, extras({ window: j24.window, markers: null, gh, env, home, notes, gaps }));
  // After the live reads: a report-sourced key shares its name with a live one (`std.unscoped.ciSec`), and the report's range wins.
  for (const [key, v] of Object.entries(REPORT_SOURCED)) metrics[key] = metric(v.v, v.unit, OPUS_REPORT);
  notes.push(`source "opus-report": ${Object.keys(REPORT_SOURCED).join(', ')} (lane markers keep only each lane's last two runs, so the scoped/unscoped standards split cannot be recomputed)`);
  // A baseline with a silent gap (the run list failed, some jobs reads failed, or nothing was sampled) would make every
  // later CI diff read "no baseline": refuse instead (re-run, or --no-ci to accept one).
  if (gh && gaps.length) throw new Error(`perf-snapshot: CI wall: ${gaps.join('; ')}; not writing a baseline with a gap. Re-run, or pass --no-ci to accept one.`);
  return buildSnapshot({ kind: 'baseline', date: BASELINE_DATE, takenAt: BASELINE_TAKEN_AT, window: j24.window, metrics, notes, head: headSha() });
}

function append(store, row) {
  mkdirSync(dirname(store), { recursive: true });
  appendFileSync(store, `${JSON.stringify(row)}\n`, 'utf8');
}

/** The velocity block of the run output: today and yesterday, real vs estimated, the calibration error, the cost. */
export function velocityReport({ col, calibration, spent, now, file }) {
  const m = col.metrics, v = (k) => m[k]?.v ?? 0;
  const lines = ['velocity (ET days; "real" = sized cards resolved, "estimated" = estimated-from-brief for PRs with no sized card):'];
  lines.push(`  points/day today     real ${v('velocity.points.today.real')}   estimated ${v('velocity.points.today.estimated')}`);
  lines.push(`  points/day yesterday real ${v('velocity.points.yesterday.real')}   estimated ${v('velocity.points.yesterday.estimated')}`);
  lines.push(`  points/hour (window) real ${v('velocity.points.perHour.real')}   estimated ${v('velocity.points.perHour.estimated')}`);
  lines.push(`  PRs merged/hour (window) code ${v('velocity.prs.code.perHour')} (${v('velocity.prs.code.merged')})   card-only ${v('velocity.prs.cardOnly.perHour')} (${v('velocity.prs.cardOnly.merged')})`);
  lines.push(`  PRs still without an estimate: ${v('velocity.estimate.missingPrs')}`);
  lines.push(calibration.n ? `  estimator calibration on ${calibration.n} sized-card PRs: mean absolute error ${calibration.mae} pts, bias ${calibration.bias > 0 ? '+' : ''}${calibration.bias} pts (estimate - actual)` : '  estimator calibration: no calibration rows yet (run with --estimate)');
  if (spent) lines.push(`  estimates this run: ${spent.newEstimates} new + ${spent.newCalibration} calibration, ${spent.failures} failed, ${spent.remaining} over the cap, model cost $${spent.costUsd} (rows in ${file})`);
  lines.push(...hourlyLines(realPointEvents(col.events).filter((e) => etParts(e.at)?.date === etParts(now)?.date), 'real points today'));
  return lines;
}

/** THE SINK MAP for the one effect. */
export function createPerfSnapshotSinks({ env = process.env, home = homedir(), gh: ghIn } = {}) {
  return {
    [PERF_SNAPSHOT_EFFECT]: async (p) => {
      const gh = p.noCi ? null : (ghIn ?? makeGh({ home, env }));
      if (p.backfill) {
        const row = backfillBaseline({ archive: p.archive, gh, env, home });
        const existing = (() => { try { return parseStore(readFileSync(p.store, 'utf8')); } catch { return []; } })();
        if (existing.some((r) => r.kind === 'baseline')) return { lines: ['perf-snapshot: baseline already present; nothing written'] };
        append(p.store, row);
        const reportSourced = Object.entries(row.metrics).filter(([, m]) => m.source === OPUS_REPORT).map(([k]) => k);
        return { lines: [`perf-snapshot: wrote the ${BASELINE_DATE} baseline (${Object.keys(row.metrics).length} metrics) to ${p.store}`, `perf-snapshot: report-sourced (source "${OPUS_REPORT}"): ${reportSourced.join(', ')}`, ...row.notes.map((n) => `  note: ${n}`)], row };
      }
      const until = p.now, since = new Date(Date.parse(until) - p.hours * 3600 * 1000).toISOString();
      const window = { since, until };
      const inputs = collectInputs(window, { env, home, gh });
      const coroner = extractMetrics(inputs);
      const notes = [];
      if (!gh) notes.push('run with --no-ci: gh-backed metrics (CI, change requests, PR kinds) are absent or partial');
      const metrics = { ...deriveFromCoroner(coroner), ...extras({ window, markers: inputs.markers, gh, env, home, notes }) };
      const velocityLines = [];
      try {
        const root = readGit(['rev-parse', '--show-toplevel'], { cwd: process.cwd() }).trim();
        const col = collectVelocity({ root, window, now: until, storePath: p.store });
        let calibration = calibrationStats([...col.calibration.values()]), spent = null;
        if (p.estimate) {
          if (!gh) notes.push('velocity estimates skipped: --no-ci means no gh to read PR briefs');
          else {
            let held = ''; try { held = readFileSync(heldCardsPath(env, home), 'utf8'); } catch { /* none */ }
            const calCol = collectVelocity({ root, window, now: until, storePath: p.store, ref: col.ref, since: CALIBRATION_FROM });
            spent = await runEstimates({ collected: col, calibrationCollected: calCol, storePath: p.store, gh, cap: p.estimateCap, heldText: held });
            calibration = spent.calibration;
          }
        }
        const fresh = spent ? collectVelocity({ root, window, now: until, storePath: p.store, ref: col.ref }) : col;
        Object.assign(metrics, fresh.metrics);
        velocityLines.push(...velocityReport({ col: fresh, calibration, spent, now: until, file: estimatesPath(p.store) }));
        notes.push(`velocity: card history read from ${fresh.ref}; real points are sized cards, estimated points are ${'estimated-from-brief'} rows in ${estimatesPath(p.store)}`);
      } catch (e) { notes.push(`velocity unavailable: ${String(e.message).split('\n')[0]}`); }
      const date = until.slice(0, 10);
      const rawDir = join(p.dir, date);
      const rawFile = join(rawDir, `coroner-${p.hours}h-${until.slice(11, 16).replace(':', '')}Z.json`);
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(rawFile, JSON.stringify(coroner), { flag: 'wx' });
      const row = buildSnapshot({ date, takenAt: until, window, metrics, notes: [...notes, `raw coroner JSON: ${rawFile}`], head: headSha() });
      const rows = (() => { try { return parseStore(readFileSync(p.store, 'utf8')); } catch { return []; } })();
      const { baseline, last } = pickReferences(rows);
      const merged = gh ? fetchMergedSince(baseline?.takenAt ?? BASELINE_TAKEN_AT, gh) : null;
      const after = (iso) => (merged ?? []).filter((m) => Date.parse(m.mergedAt) > Date.parse(iso));
      append(p.store, row);
      const lines = [`perf-snapshot: ${date} ${p.hours} h window ${since} to ${until}: ${Object.keys(metrics).length} metrics, appended to ${p.store} (schema ${SCHEMA_VERSION})`, `perf-snapshot: raw coroner JSON kept at ${rawFile}`];
      if (!baseline) lines.push('perf-snapshot: no baseline row yet; run once with --backfill --apply');
      else {
        const note = merged === null ? ' (merged-PR tags unavailable: gh read failed or --no-ci)' : '';
        lines.push('', ...formatDiff(`vs baseline ${baseline.date}${note}`, baseline, row, after(baseline.takenAt)));
        if (last && last !== baseline) lines.push('', ...formatDiff(`vs last snapshot ${last.date} (${last.takenAt})`, last, row, after(last.takenAt)));
        else lines.push('', 'vs last snapshot: this is the first snapshot after the baseline');
      }
      if (velocityLines.length) lines.push('', ...velocityLines);
      for (const n of notes) lines.push(`  note: ${n}`);
      return { lines, row };
    },
  };
}
