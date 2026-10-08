/**
 * @file scripts/operations/perf-snapshot.mjs
 * @description THE `perf-snapshot` DECLARATION (held card 119) — a repeatable, no-LLM recompute of the Opus perf
 *   sweep's numbers (`.operations/metrics/perf/2026-10-07/opus-perf-sweep-2026-10-07.md`), kept as one dated,
 *   schema-versioned row per run so gains can be compared over time.
 *
 * WHAT IT MEASURES (every metric is `{ v, unit, source }`; `v` is a number or a `{ lo, hi }` range):
 *   - agent session minutes, minutes inside gate commands, verify-lane median/p90, wait-timeouts, direct vitest;
 *   - heavy-queue (admission) wait p50/p90, gate/vitest/standards phase medians from the lane verify markers;
 *   - standards run time split scoped vs unscoped (a `--files=` check:standards is scoped);
 *   - CI wall per code PR, per test shard, soak shard, `test` job and card-only PRs (gh job timings);
 *   - code vs card-only PR counts and time-to-merge;
 *   - VELOCITY (held card 129, `./perf-velocity.mjs`): story points resolved per day and per hour (ET), read from the card
 *     history through `bornAs` and the `x<hash>` to `NNN` rename (real, sized cards), PRs merged per hour code vs card-only, and
 *     points estimated from the PR brief for PRs with no sized card (`source: "estimated-from-brief"`, kept apart, calibrated
 *     on sized-card PRs; `--estimate` runs the cheap model, rows persist in `perf-estimates.jsonl` beside the store);
 *   - change-request rounds, findings and fix minutes by root cause (the coroner `changeRequests` records, with the
 *     sweep's own keyword pass splitting round-1 findings into "checklist lacked it" vs "reinvented a primitive");
 *   - the attribute predictors of extra rounds (bucket means);
 *   - fix-session outcomes and executor (claude / codex / agy) runs, rounds per task and minutes;
 *   - builder starvation minutes (build-dispatch tick log: free capacity, nothing in flight, nothing dispatched).
 *
 * SOURCES. The numbers come from the same places the report cites, through the coroner's own exported readers
 * (`coroner-extract.mjs`): verify markers, heavy-admission ledgers, the build-dispatch tick log, CI via `gh`, the
 * `changeRequests` rounds, fix outcomes and the executor receipts. `source: "computed"` means this tool derived it
 * from those inputs; `source: "opus-report"` means the value was copied from the Opus report because the inputs no
 * longer exist (the lane markers keep only each lane's last two runs, so the 2026-10-07 scoped/unscoped standards
 * ranges cannot be recomputed). See {@link REPORT_SOURCED}.
 *
 * SCHEDULE. Daily run: `node scripts/operations/run.mjs perf-snapshot --apply` (and once, `--backfill --apply`, to
 * seed the 2026-10-07 baseline). NOT YET WIRED into the scheduled-sweep templates: #4228 (`scheduled-sweep.mjs`,
 * `install-scheduled-sweeps.mjs`, `daemon-manifest.mjs`) was still OPEN when this landed and its files are not edited
 * here. Once #4228 merges, add one daily entry that runs the command above; nothing else needs to change.
 *
 * THIS FILE IS PURE: no fs, no clock, no process, no network. The reader, the gh calls and the store live in
 * `./perf-snapshot-io.mjs`.
 */
import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { velocityLabel } from './perf-velocity.mjs';

export const PERF_SNAPSHOT_OP = 'perf-snapshot';
export const PERF_SNAPSHOT_EFFECT = 'perf-snapshot.run';
export const SCHEMA_VERSION = 1;
export const BASELINE_DATE = '2026-10-07';
/** The instant the baseline's 24 h window ended; PRs merged after it are what a later change is tagged with. */
export const BASELINE_TAKEN_AT = '2026-10-07T14:00:00.000Z';
export const COMPUTED = 'computed';
export const OPUS_REPORT = 'opus-report';

/** The baseline numbers that cannot be recomputed from archived data, with where the report states them. */
export const REPORT_SOURCED = Object.freeze({
  'std.scoped.sec': { v: { lo: 9, hi: 34 }, unit: 's', note: 'report 1, "check:standards ... 9-34 s (scoped)"' },
  'std.unscoped.sec': { v: { lo: 113, hi: 308 }, unit: 's', note: 'report 1, "113-308 s (the unscoped run)"' },
  'std.unscoped.ciSec': { v: { lo: 18, hi: 30 }, unit: 's', note: 'report 1, CI "Repo health gate" step 18-30 s' },
});

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const r1 = (x) => Math.round(x * 10) / 10;
const stampMs = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);

/** Nearest-rank percentile, the coroner's rule: sorted[ceil(p*n)-1]; empty is 0. PURE. */
export function percentile(values, p) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return xs.length ? xs[Math.max(0, Math.ceil(p * xs.length) - 1)] : 0;
}

/** One metric entry. */
export const metric = (v, unit, source = COMPUTED) => ({ v, unit, source });

/** The value as one number (a range becomes its midpoint). */
export const midpoint = (v) => (v && typeof v === 'object' ? (v.lo + v.hi) / 2 : v);

function put(out, key, v, unit, source = COMPUTED) {
  if (v && typeof v === 'object') out[key] = metric(v, unit, source);
  else if (num(v) !== null) out[key] = metric(v, unit, source);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Root causes and predictors (the report's section 3 and its coroner tables).

const REINVENTED_RE = /shared|existing|reuse/i;
export const ROOT_CAUSE_KEYS = Object.freeze({
  checklist: 'round-1, no reuse hint (checklist / prepare lacked the requirement)',
  reinvented: 'round-1, prevention text says shared/existing/reuse (reinvented a primitive)',
  're-raised': 'the same finding re-raised each round (ruling churn)',
  'fix-introduced': 'finding inside the previous fix push',
  'later-round-find': 'found only in a later round, on original code',
  'flaky-infra': 'CI flake or infra',
  'gate-missed-catching-test': 'local gate did not run the catching test',
  other: 'other',
});

/**
 * Findings and fix minutes by root cause over the code PRs' round records. A round's minutes are split evenly over its
 * findings; a round-1 finding with no deterministic hint goes to `reinvented` when its own Prevention text says
 * shared/existing/reuse, else `checklist` (the keyword pass of rootcauses-48h.md, which this reproduces exactly). PURE.
 * @param {object[]} records `changeRequests.byKind.code.records`
 */
export function rootCauseTotals(records) {
  const acc = Object.fromEntries(Object.keys(ROOT_CAUSE_KEYS).map((k) => [k, { findings: 0, minutes: 0 }]));
  for (const pr of Array.isArray(records) ? records : []) {
    for (const round of pr?.rounds ?? []) {
      const findings = Array.isArray(round?.findings) ? round.findings : [];
      for (const f of findings) {
        const hint = f?.hint;
        const key = hint && acc[hint] ? hint : hint ? 'other' : REINVENTED_RE.test(String(f?.prevention ?? '')) ? 'reinvented' : 'checklist';
        acc[key].findings++;
        acc[key].minutes += (num(round.minutes) ?? 0) / findings.length;
      }
    }
  }
  return acc;
}

/** `pred.<attribute>.<bucket>` = mean extra rounds per bucket, plus `.effect`. `prefix` keeps windows apart. PURE. */
export function predictorMetrics(correlation, prefix = 'pred') {
  const out = {};
  for (const c of Array.isArray(correlation) ? correlation : []) {
    if (typeof c?.attribute !== 'string') continue;
    put(out, `${prefix}.${c.attribute}.effect`, num(c.effect), 'rounds');
    for (const b of c.buckets ?? []) put(out, `${prefix}.${c.attribute}.${b.value}`, num(b.meanExtraRounds), 'rounds');
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The coroner JSON → metrics.

const FIX_OUTCOMES = ['pushed', 'stopped-without-outcome', 'no-op', 'load-flake-hold', 'blocked', 'escalated', 'gate-red-not-pushed', 'other', 'handed-to-harness'];

/**
 * Derive every metric the coroner JSON holds. `crPrefix` is `rc` for the snapshot window and `rc48` for a 48 h
 * root-cause window (the report's predictor and root-cause tables came from 48 h). PURE.
 * @param {object} c the coroner `extractMetrics` result (or a parsed `--json` file)
 */
export function deriveFromCoroner(c) {
  const out = {};
  const s = c?.sessions ?? {};
  put(out, 'sessions.count', num(s.count), 'sessions');
  put(out, 'sessions.minutes', num(s.minutes), 'min');
  for (const [kind, v] of Object.entries(s.byKind ?? {})) put(out, `sessions.${kind}.minutes`, num(v?.minutes), 'min');
  const g = c?.gate ?? {};
  put(out, 'gate.minutesInGate', num(g.minutesInGate), 'min');
  put(out, 'gate.shareInGatePct', num(g.shareInGate) === null ? null : r1(g.shareInGate * 100), '%');
  put(out, 'gate.verifyLane.calls', num(g.verifyLane?.calls), 'calls');
  put(out, 'gate.verifyLane.medianMin', num(g.verifyLane?.medianMin), 'min');
  put(out, 'gate.verifyLane.p90Min', num(g.verifyLane?.p90Min), 'min');
  put(out, 'gate.directVitest.runs', num(g.directVitest?.runs), 'runs');
  put(out, 'gate.directVitest.minutes', num(g.directVitest?.minutes), 'min');
  put(out, 'gate.waitTimeouts.count', num(g.waitTimeouts), 'count');
  put(out, 'gate.waitTimeouts.minutes', num(g.waitTimeoutMinutes), 'min');
  const a = c?.admission ?? {};
  put(out, 'queue.waitP50Sec', num(a.waitMedianSec), 's');
  put(out, 'queue.waitP90Sec', num(a.waitP90Sec), 's');
  put(out, 'marker.gateMedianSec', num(a.markers?.gateMedianSec), 's');
  put(out, 'marker.gateP90Sec', num(a.markers?.gateP90Sec), 's');
  put(out, 'marker.vitestMedianSec', num(a.markers?.vitestMedianSec), 's');
  put(out, 'marker.standardsMedianSec', num(a.markers?.standardsMedianSec), 's');
  for (const [kind, v] of Object.entries(a.holdsByKind ?? {})) put(out, `queue.holds.${kind}.minutes`, num(v?.minutes), 'min');
  put(out, 'queue.reapedWaiterMinutes', num(a.reaped?.waiterMinutes), 'min');

  const er = c?.errorRates ?? {};
  put(out, 'gateRuns.redPct', num(er.gateRuns?.pct), '%');
  put(out, 'ci.redPct', num(er.ci?.pct), '%');
  put(out, 'ci.redHeads', num(er.ci?.redHeads), 'heads');
  put(out, 'builder.launchFailPct', num(er.builderLaunches?.pct), '%');
  put(out, 'builder.launched', num(er.builderLaunches?.launched), 'launches');
  const fix = er.fixSessions ?? {};
  put(out, 'fix.sessions', num(fix.count), 'sessions');
  for (const cause of FIX_OUTCOMES) {
    const v = fix.causes?.[cause];
    put(out, `fix.${cause}.count`, num(v?.count) ?? 0, 'sessions');
    put(out, `fix.${cause}.minutes`, num(v?.minutes) ?? 0, 'min');
  }
  put(out, 'fix.multiRoundPrs', num(fix.rounds?.multiRoundPrs), 'PRs');
  put(out, 'fix.maxRounds', num(fix.rounds?.max), 'rounds');
  const bk = er.byKind ?? {};
  put(out, 'prs.code', num(bk.code?.prsOpened), 'PRs');
  put(out, 'prs.cardOnly', num(bk['card-only']?.prsOpened), 'PRs');
  put(out, 'ttm.code.medianMin', num(bk.code?.timeToMerge?.medianMin), 'min');
  put(out, 'ttm.code.p90Min', num(bk.code?.timeToMerge?.p90Min), 'min');
  put(out, 'ttm.cardOnly.medianMin', num(bk['card-only']?.timeToMerge?.medianMin), 'min');
  put(out, 'ttm.cardOnly.p90Min', num(bk['card-only']?.timeToMerge?.p90Min), 'min');

  for (const [name, v] of Object.entries(c?.executors ?? {})) {
    put(out, `exec.${name}.runs`, num(v?.runs), 'runs');
    put(out, `exec.${name}.roundsPerTask`, num(v?.roundsPerTask), 'rounds');
    put(out, `exec.${name}.medianMin`, num(v?.medianMin), 'min');
    put(out, `exec.${name}.p90Min`, num(v?.p90Min), 'min');
    put(out, `exec.${name}.errorRatePct`, num(v?.errorRatePct), '%');
    if (num(v?.tokens) !== null) put(out, `exec.${name}.tokens`, v.tokens, 'tokens');
  }
  Object.assign(out, deriveChangeRequests(c?.changeRequests, 'rc'));
  return out;
}

/** The `changeRequests` block → rounds, findings, minutes, root causes and predictors under `prefix`. PURE. */
export function deriveChangeRequests(cr, prefix = 'rc') {
  const out = {};
  const code = cr?.byKind?.code, card = cr?.byKind?.['card-only'];
  if (!code) return out;
  put(out, `${prefix}.code.prs`, num(code.prs), 'PRs');
  put(out, `${prefix}.code.prsWithRounds`, num(code.prsWithRounds), 'PRs');
  put(out, `${prefix}.code.rounds`, num(code.rounds), 'rounds');
  put(out, `${prefix}.code.findings`, num(code.findings), 'findings');
  put(out, `${prefix}.code.fixMinutes`, num(code.minutes), 'min');
  put(out, `${prefix}.cardOnly.rounds`, num(card?.rounds), 'rounds');
  if (num(code.prs)) put(out, `${prefix}.code.roundsPerPr`, Math.round((code.rounds / code.prs) * 100) / 100, 'rounds');
  for (const [k, v] of Object.entries(code.byTrigger ?? {})) {
    put(out, `${prefix}.trigger.${k}.rounds`, num(v?.rounds), 'rounds');
    put(out, `${prefix}.trigger.${k}.minutes`, num(v?.minutes), 'min');
  }
  if (Array.isArray(code.records)) {
    for (const [k, v] of Object.entries(rootCauseTotals(code.records))) {
      put(out, `${prefix}.cause.${k}.findings`, v.findings, 'findings');
      put(out, `${prefix}.cause.${k}.minutes`, r1(v.minutes), 'min');
    }
  }
  Object.assign(out, predictorMetrics(code.correlation, `pred${prefix.slice(2)}`));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Metrics the coroner JSON does not hold: scoped/unscoped standards, CI wall, builder starvation.

/** Is this marker's check:standards run scoped (`--files=`)? A marker with no standards phase is neither. */
export function standardsScope(marker) {
  const suites = String(marker?.suites ?? '');
  if (!/check:standards/.test(suites)) return null;
  return /check:standards[^&]*--files=/.test(suites) ? 'scoped' : 'unscoped';
}

/** Standards seconds, split scoped/unscoped, from lane verify markers finished inside the window. PURE. */
export function standardsSplit(markers, window) {
  const seen = new Set(), groups = { scoped: [], unscoped: [] };
  for (const m of Array.isArray(markers) ? markers : []) {
    const at = stampMs(m?.finishedAt);
    if (!(at >= stampMs(window.since) && at < stampMs(window.until))) continue;
    const key = JSON.stringify([m.sha, m.startedAt]);
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = standardsScope(m), ms = num(m?.phases?.standardsMs);
    if (scope && ms !== null && ms >= 0) groups[scope].push(ms);
  }
  const out = {};
  for (const [scope, xs] of Object.entries(groups)) {
    put(out, `std.${scope}.count`, xs.length, 'runs');
    if (xs.length) {
      // `.sec` (the median) is the key the baseline's report-sourced range uses, so `diffSnapshots` can compare the two.
      put(out, `std.${scope}.sec`, r1(percentile(xs, 0.5) / 1000), 's');
      put(out, `std.${scope}.p90Sec`, r1(percentile(xs, 0.9) / 1000), 's');
    }
  }
  return out;
}

/** The `test` job's step that runs the unscoped `npm run check:standards` in CI (`.github/workflows/ci.yml`). */
export const CI_GATE_STEP = 'Repo health gate';

/**
 * CI wall times from completed, successful `CI` runs with their jobs. A run with any `test-shard` job is a code PR;
 * one without is card-only. Per run: wall = run end - run start; slowest unit shard; slowest soak shard; the `test`
 * job; the `test` job's {@link CI_GATE_STEP} step (`std.unscoped.ciSec`, the live twin of the report-sourced baseline
 * key). Medians and p90s over the sampled runs. PURE.
 * @param {{wallMs:number, jobs:{name:string, ms:number, steps?:{name:string, ms:number}[]}[]}[]} runs
 */
export function ciWallMetrics(runs) {
  const code = [], card = [], shard = [], soak = [], testJob = [], unitSpread = [], gateStep = [];
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!Number.isFinite(r?.wallMs) || r.wallMs <= 0) continue;
    const jobs = Array.isArray(r.jobs) ? r.jobs : [];
    const of = (re) => jobs.filter((j) => re.test(j.name) && Number.isFinite(j.ms) && j.ms > 0).map((j) => j.ms);
    const gate = jobs.filter((j) => /^test$/.test(j.name)).flatMap((j) => (Array.isArray(j.steps) ? j.steps : []))
      .filter((s) => s?.name === CI_GATE_STEP && Number.isFinite(s.ms) && s.ms > 0);
    if (gate.length) gateStep.push(gate[0].ms);
    const shards = of(/^test-shard/);
    if (!shards.length) { card.push(r.wallMs); continue; }
    code.push(r.wallMs);
    shard.push(Math.max(...shards));
    unitSpread.push(Math.max(...shards) - Math.min(...shards));
    const soaks = of(/^soak-shard/);
    if (soaks.length) soak.push(Math.max(...soaks));
    const t = of(/^test$/);
    if (t.length) testJob.push(t[0]);
  }
  const out = {}, min = (xs, p) => r1(percentile(xs, p) / 60000);
  put(out, 'ci.sampleRuns', code.length + card.length, 'runs');
  put(out, 'ci.code.runs', code.length, 'runs');
  if (code.length) { put(out, 'ci.code.wallMedianMin', min(code, 0.5), 'min'); put(out, 'ci.code.wallP90Min', min(code, 0.9), 'min'); }
  if (shard.length) put(out, 'ci.slowestShardMedianMin', min(shard, 0.5), 'min');
  if (unitSpread.length) put(out, 'ci.shardSpreadMedianMin', min(unitSpread, 0.5), 'min');
  if (soak.length) put(out, 'ci.slowestSoakMedianMin', min(soak, 0.5), 'min');
  if (testJob.length) put(out, 'ci.testJobMedianMin', min(testJob, 0.5), 'min');
  if (gateStep.length) put(out, 'std.unscoped.ciSec', r1(percentile(gateStep, 0.5) / 1000), 's');
  if (card.length) { put(out, 'ci.cardOnly.runs', card.length, 'runs'); put(out, 'ci.cardOnly.wallMedianMin', min(card, 0.5), 'min'); }
  return out;
}

/**
 * Builder starvation minutes: build-dispatch ticks in the window where capacity was free, nothing was in flight and
 * nothing was dispatched, each counted for the gap to the next tick (a gap over `maxGapMin` counts as `maxGapMin`, so
 * a daemon outage is not read as starvation). The tick rows are compact `{at, dispatched, inFlight, capacity}`. PURE.
 */
export function builderStarvation(ticks, window, { maxGapMin = 15 } = {}) {
  const inWin = (Array.isArray(ticks) ? ticks : []).filter((t) => stampMs(t?.at) >= stampMs(window.since) && stampMs(t?.at) < stampMs(window.until)).sort((a, b) => stampMs(a.at) - stampMs(b.at));
  let starvedMs = 0, starvedTicks = 0;
  for (let i = 0; i < inWin.length; i++) {
    const t = inWin[i];
    const free = t.capacity?.free === true;
    const idle = !(Array.isArray(t.dispatched) && t.dispatched.length) && !(Array.isArray(t.inFlight) && t.inFlight.length);
    if (!free || !idle) continue;
    const next = stampMs(inWin[i + 1]?.at ?? window.until);
    starvedMs += Math.min(Math.max(0, next - stampMs(t.at)), maxGapMin * 60000);
    starvedTicks++;
  }
  const out = {};
  put(out, 'builder.starvedMin', r1(starvedMs / 60000), 'min');
  put(out, 'builder.starvedTicks', starvedTicks, 'ticks');
  put(out, 'builder.ticks', inWin.length, 'ticks');
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Snapshot rows.

/** Assemble one snapshot row. PURE. */
export function buildSnapshot({ kind = 'snapshot', date, takenAt, window, metrics, notes = [], head = null }) {
  return { schema: SCHEMA_VERSION, kind, date, takenAt, window, head, metrics, notes };
}

/** Parse the store text into rows (bad lines and unknown schema versions are skipped, never thrown). PURE. */
export function parseStore(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row && typeof row === 'object' && row.schema === SCHEMA_VERSION && row.metrics && typeof row.metrics === 'object') rows.push(row);
  }
  return rows;
}

/** The baseline row and the last snapshot row (the baseline when there is no snapshot yet). PURE. */
export function pickReferences(rows) {
  const baseline = rows.find((r) => r.kind === 'baseline') ?? null;
  const snaps = rows.filter((r) => r.kind === 'snapshot');
  return { baseline, last: snaps.at(-1) ?? baseline };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Diff and tagging.

/** Metrics where a rise is neither good nor bad (volume, not cost). */
const NEUTRAL_RE = /(^prs\.|\.runs$|\.count$|\.calls$|^sessions\.count$|^ci\.sampleRuns$|\.ticks$|\.launched$|\.tokens$|^std\.\w+\.count$|^pred\d*\.|^rc\d*\.code\.prs$)/;
/** Which merged-PR titles are the likely cause of a change to a metric group. */
const AREA = [
  [/^(std|marker|queue|gate|gateRuns)\b/, /gate|verify|standards|vitest|admission|heavy|queue|lane/i],
  [/^ci\b/, /\bci\b|workflow|shard|soak|integration|test/i],
  [/^(rc\d*|pred|fix)\b/, /fix|review|converge|brief|prepare|ruling|checklist|coroner|round|prevention/i],
  [/^(builder|sessions|exec)\b/, /dispatch|builder|conveyor|daemon|executor|codex|agy|await-verify|session/i],
  [/^(prs|ttm)\b/, /card|backlog|land|merge|drain|conveyor/i],
];

/** Sign convention: `better`, `worse`, or `neutral`. PURE. */
export function judge(key, from, to) {
  // Velocity is output, so a rise is good: points and PRs per time. Merge counts are volume (neutral).
  if (/^velocity\.(points\.|prs\.\w+\.perHour$)/.test(key)) return to > from ? 'better' : to < from ? 'worse' : 'neutral';
  if (/^velocity\.prs\.\w+\.merged$/.test(key)) return 'neutral';
  if (NEUTRAL_RE.test(key) || from === to) return 'neutral';
  return to < from ? 'better' : 'worse';
}

/**
 * Compare two snapshot rows. A change smaller than `minPct` percent (and smaller than `minAbs`) is dropped as noise.
 * A range compares by midpoint, and either side being report-sourced marks the line `~`. PURE.
 * @returns {{key:string, from:*, to:*, delta:number, pct:(number|null), verdict:string, approx:boolean, unit:string}[]}
 */
export function diffSnapshots(ref, cur, { minPct = 5, minAbs = 0.05 } = {}) {
  const changes = [];
  if (!ref || !cur) return changes;
  for (const [key, now] of Object.entries(cur.metrics)) {
    const was = ref.metrics[key];
    if (!was) continue;
    const a = midpoint(was.v), b = midpoint(now.v);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const delta = b - a, pct = a === 0 ? null : (delta / Math.abs(a)) * 100;
    // Predictor buckets are means over a handful of PRs: a move under a quarter of a round is sampling noise.
    if (Math.abs(delta) < (/^pred\d*\./.test(key) ? 0.25 : minAbs) || (pct !== null && Math.abs(pct) < minPct)) continue;
    changes.push({ key, from: was.v, to: now.v, delta: r1(delta * 100) / 100, pct: pct === null ? null : r1(pct), verdict: judge(key, a, b), approx: was.source === OPUS_REPORT || now.source === OPUS_REPORT, unit: now.unit ?? was.unit ?? '', source: now.source ?? was.source ?? '' });
  }
  return changes.sort((x, y) => (x.key < y.key ? -1 : 1));
}

/** Tag a change with the merged PRs (`{number,title,mergedAt}`) most likely to explain it, then a count of the rest. PURE. */
export function tagChange(key, merged, { limit = 5 } = {}) {
  const re = AREA.find(([k]) => k.test(key))?.[1];
  const all = Array.isArray(merged) ? merged : [];
  const hits = re ? all.filter((p) => re.test(String(p.title ?? ''))) : [];
  const shown = hits.slice(0, limit);
  return { prs: shown.map((p) => p.number), more: Math.max(0, all.length - shown.length) };
}

const fmtV = (v) => (v && typeof v === 'object' ? `${v.lo}-${v.hi}` : String(v));

/** The plain-text diff for one reference. PURE. */
export function formatDiff(title, ref, cur, merged, opts = {}) {
  const lines = [title];
  if (!ref) return [...lines, '  (no earlier row to compare with)'];
  const changes = diffSnapshots(ref, cur, opts);
  const compared = Object.keys(cur.metrics).filter((k) => ref.metrics[k]).length;
  if (!changes.length) return [...lines, `  no metric moved by 5% or more (${compared} compared)`];
  for (const c of changes) {
    const tag = tagChange(c.key, merged);
    const prs = tag.prs.length ? ` PRs ${tag.prs.map((n) => `#${n}`).join(' ')}${tag.more ? ` (+${tag.more} others merged)` : ''}` : tag.more ? ` (${tag.more} PRs merged, none match this area)` : '';
    const pct = c.pct === null ? '' : `, ${c.pct > 0 ? '+' : ''}${c.pct}%`;
    lines.push(`  ${c.verdict === 'better' ? 'better' : c.verdict === 'worse' ? 'WORSE ' : 'moved '} ${c.key}${velocityLabel(c.key, c.source)}: ${c.approx ? '~' : ''}${fmtV(c.from)} -> ${fmtV(c.to)} ${c.unit}${pct}${prs}`);
  }
  lines.push(`  (${changes.length} of ${compared} compared metrics moved; "~" = one side is a report-sourced estimate)`);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The declaration.

/** Shape one `readFacts()` result into the `read` finding. PURE. */
export function shapePerfRead(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (!r.store) throw new Error('perf-snapshot.read: no snapshot store path');
  return {
    store: String(r.store),
    dir: String(r.dir || ''),
    now: String(r.now || ''),
    rows: Array.isArray(r.rows) ? r.rows : [],
    hasBaseline: r.hasBaseline === true,
    archive: String(r.archive || ''),
    archiveFound: r.archiveFound === true,
  };
}

/** What a run would do. PURE. A backfill needs the archived baseline data; a snapshot needs nothing but the sources. */
export function planPerfSnapshot(read, { apply = false, backfill = false, hours = 24, noCi = false, estimate = false, estimateCap = 300 } = {}) {
  const refused = backfill && !read.archiveFound ? `no archived baseline data at ${read.archive}` : backfill && read.hasBaseline ? 'the baseline row already exists in the store (backfill is idempotent: nothing to do)' : null;
  const h = Number.isFinite(Number(hours)) && Number(hours) >= 1 ? Math.min(Math.floor(Number(hours)), 168) : 24;
  return {
    apply: apply === true && !refused,
    refused,
    backfill: backfill === true,
    hours: h,
    noCi: noCi === true,
    estimate: estimate === true && !backfill,
    estimateCap: Number.isFinite(Number(estimateCap)) && Number(estimateCap) >= 0 ? Math.min(Math.floor(Number(estimateCap)), 1000) : 300,
    steps: backfill
      ? [`read ${read.archive}/coroner-24h.json + coroner-48h.json`, 'derive the metrics from the raw coroner JSON', 'add the report-sourced standards ranges (source "opus-report")', `append the ${BASELINE_DATE} baseline row to ${read.store}`]
      : [`coroner window: last ${h} h`, 'derive the metrics (verify markers, admission ledgers, tick log, gh, change requests, fix outcomes, executors, velocity from the card history)', ...(estimate ? [`calibrate the size estimator on sized-card PRs, then estimate up to ${estimateCap} unsized merged PRs from their briefs (perf-estimates.jsonl, source "${'estimated-from-brief'}")`] : []), `keep the raw coroner JSON under ${read.dir}/<date>/`, `append one snapshot row to ${read.store}`, 'print the diff vs the baseline and vs the last snapshot'],
    lastDate: read.rows.at(-1)?.date ?? null,
  };
}

/** The command line's output. PURE. */
export function finishPerfSnapshot({ run, code, lines, json = false } = {}) {
  if (json) return { code, lines };
  const plan = run?.verdict;
  if (!plan) return { code, lines };
  if (plan.refused) return { code: plan.backfill && /already exists/.test(plan.refused) ? 0 : 1, lines: [`perf-snapshot: ${plan.refused}`] };
  const eff = (run.effects ?? []).find((e) => e.type === PERF_SNAPSHOT_EFFECT);
  if (!eff || eff.status !== 'applied' || !eff.result) {
    return { code: plan.apply ? 1 : code, lines: [plan.apply ? `perf-snapshot: FAILED${eff?.error ? ` - ${String(eff.error).split('\n')[0]}` : ''}` : `perf-snapshot: dry run - would: ${plan.steps.join('; ')}. Re-run with --apply.`] };
  }
  return { code, lines: eff.result.lines };
}

/**
 * @param {{readFacts: (o: object) => object}} deps
 */
export function perfSnapshotOperation({ readFacts } = {}) {
  if (typeof readFacts !== 'function') throw new TypeError('perf-snapshot: needs a `readFacts({store})` reader; the real one is `we:scripts/operations/perf-snapshot-io.mjs`.');
  return op(PERF_SNAPSHOT_OP, {
    input: {
      apply: { type: 'boolean', required: false, default: false },
      // Write the 2026-10-07 baseline row from the archived data instead of taking a snapshot.
      backfill: { type: 'boolean', required: false, default: false },
      // The knob: the JSONL store. Default `WE_PERF_SNAPSHOT_STORE`, else `<operations root>/metrics/perf/snapshots.jsonl`.
      store: { type: 'string', required: false, default: '' },
      hours: { type: 'number', required: false, default: 24 },
      // Skip every gh read (CI wall, merged-PR tags, coroner CI + rounds). Offline runs are marked in the row's notes.
      noCi: { type: 'boolean', required: false, default: false },
      // Run the cheap-model size estimator (calibration first) for unsized merged PRs; spends a little model budget.
      estimate: { type: 'boolean', required: false, default: false },
      estimateCap: { type: 'number', required: false, default: 300 },
    },
    verdictFrom: 'plan',
    read: compute({ reads: ['input.store'], fn: (view) => shapePerfRead(readFacts({ store: view.input.store })) }),
    plan: compute({
      reads: ['findings.read', 'input.apply', 'input.backfill', 'input.hours', 'input.noCi', 'input.estimate', 'input.estimateCap'],
      fn: (view) => planPerfSnapshot(view.findings.read, { apply: view.input.apply, backfill: view.input.backfill, hours: view.input.hours, noCi: view.input.noCi, estimate: view.input.estimate, estimateCap: view.input.estimateCap }),
    }),
    apply: effectStep({
      reads: ['verdict', 'findings.read'],
      effects: (view) => {
        if (!view.verdict?.apply) return [];
        const r = view.findings.read;
        return [{ type: PERF_SNAPSHOT_EFFECT, idempotent: view.verdict.backfill, payload: { store: r.store, dir: r.dir, now: r.now, archive: r.archive, backfill: view.verdict.backfill, hours: view.verdict.hours, noCi: view.verdict.noCi, estimate: view.verdict.estimate, estimateCap: view.verdict.estimateCap } }];
      },
    }),
  });
}
