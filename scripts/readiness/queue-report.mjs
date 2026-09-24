#!/usr/bin/env node
/**
 * @file scripts/readiness/queue-report.mjs
 * @description The single, DECLARED, MECHANICAL classification of the conveyor's held queue (WE #x85oow9). A
 *   hand-produced `/wip` status report (2026-09-06) misclassified a scope-overlap hold (`overlaps lane-<n>`,
 *   `no free lane`) as "not queued" when it is actually a genuine queue member simply waiting its turn for a
 *   lane to free up — a mistake that happened precisely because this classification was re-derived by hand/prose
 *   every time it was needed. This script closes that gap: ONE tested function maps every token of
 *   {@link ../readiness/dispatch-plan.mjs dispatch-plan.mjs}'s `HELD_REASONS` into exactly one of three buckets,
 *   so no caller ever re-derives the mapping.
 *
 *   • `queued-waiting-turn` — a REAL queue member, just waiting on capacity/turn. Nothing to do but wait:
 *     `overlaps lane-<n>` (a running lane, or a higher-ranked rival, owns the same scope), `no free lane`
 *     (every lane is busy), `capacity-cap` (#xupukxa — a free lane exists, but the concurrent-lane ceiling
 *     withheld it), and `dispatch-paused` (#3609 — the item is otherwise launchable; a manual operator
 *     kill-switch is withholding it, cleared via `dispatch-pause.mjs clear`). This is the exact bucket tonight's
 *     mistake put in the wrong place.
 *   • `not-ready` — needs an action (or an external event) before it can ever be picked up, independent of lane
 *     capacity: `blocked`, `unshaped-no-scope`, `needs-slice`, `needs-decision`, `needs-investigation`, `branch-drift-blocked`,
 *     `cleared-but-not-ready`.
 *   • `stale-noise` — not a real held queue member at all; a signal that something should be verified/cleared,
 *     never waited on: `already-done` (a merged PR appears to already close the item out).
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors dispatch-plan.mjs / conveyor-state.mjs — NOT the heavier
 *   `we:scripts/operations/*.mjs` + `run.mjs` declared-operation DSL, which exists for MULTI-STEP operations
 *   with a judge/confirm step; this has no judgment step at all, it is a pure data compose):
 *   • The PURE core ({@link classifyHeld}, {@link buildQueueReport}) has NO fs / git / clock / child_process —
 *     every input (the dispatch-plan `held`/`launch` output, the conveyor-state `lanes`/`unshaped`/`needsSlice`/
 *     `decisions` sections, and a `byNum` title map) is passed IN. Directly unit-tested with plain objects.
 *   • The IO SHELL (`main()`, gated on the main-module check) resolves which checkout the LIVE conveyor runner
 *     is rooted in ({@link ../conveyor/resolve-runner-checkout.mjs resolveRunnerCheckout}) — falling back to the
 *     local cwd, with a logged reason, when no runner is resolved — then shells `dispatch-plan.mjs --json` and
 *     `conveyor-state.mjs --json` IN THAT CHECKOUT (composing the existing single-sourced reads, never
 *     re-deriving queue/lease/lane state), loads the backlog title map via the SAME
 *     `require(src/_data/backlog.js)` → `byNum` idiom `dispatch-plan.mjs` and `conveyor-state.mjs` already each
 *     use (no separate bulk-title resolver exists in this repo; this follows the established idiom rather than
 *     inventing a fourth), and emits the composed report.
 *
 * `active.fixing` / `active.healing` are always `null` ("unavailable"), NEVER a fabricated `0`: a real count
 * needs the conveyor runner's own live, in-process guard bookkeeping (`we:scripts/conveyor/tick-core.mjs`'s
 * `computeTickCounts` — `liveFixGuards` / `liveCiHealGuards`), which is carried tick-to-tick inside
 * `we:skills-src/conveyor/runner.mjs`'s own process and is NEVER persisted to a file an external reader could
 * see cold. Guessing it from PR labels would be exactly the kind of prose-classification mistake this script
 * exists to replace. This mirrors `conveyor-state.mjs`'s own `shapeDaemon` "unavailable" graceful-degrade
 * pattern — an honest absence, not a wrong number.
 *
 * `active.preparing` is a NAMED APPROXIMATION, not a live-in-progress confirmation: it lists every armed
 * (cleared-for-build) item the dispatcher would hold `unshaped-no-scope` / `needs-slice` / `needs-decision` /
 * `needs-investigation` —
 * i.e. an auto-prepare CANDIDATE, not proof an agent is preparing it THIS instant (that too is live guard
 * bookkeeping this script cannot see). Each entry carries its `reason` so a reader is never misled into reading
 * it as ground truth.
 */

import { writeLineSync } from '../lib/write-all-sync.mjs';

// ── PURE CORE (no fs / git / clock / child_process — every input is injected) ─────────────────────────────────

/** The three buckets {@link classifyHeld} sorts every `HELD_REASONS` token into. */
export const QUEUE_REPORT_BUCKETS = Object.freeze(['queued-waiting-turn', 'not-ready', 'stale-noise']);

/** Held reasons that are a REAL queue member simply waiting its turn — `overlaps lane-<n>` is matched by
 *  prefix (the `<n>` varies per lease/rival), everything else here is an exact token. */
const QUEUED_WAITING_TURN_PREFIX = 'overlaps lane-';
// `capacity-cap` (#xupukxa) joins `no free lane` here: same bucket, same "nothing to do but wait" semantics —
// a free lane may physically exist, but the concurrent-lane ceiling is what the item is actually waiting on.
// `dispatch-paused` (#3609) joins them too: the item itself is fully ready (dispatch-plan.mjs only assigns this
// reason at the point it would otherwise have launched), so once the manual pause clears it launches same-tick.
const QUEUED_WAITING_TURN_EXACT = Object.freeze(['no free lane', 'capacity-cap', 'dispatch-paused']);

/** Held reasons that need an action (or an external event) before the item can ever be picked up, independent
 *  of lane capacity — see {@link ../readiness/dispatch-plan.mjs}'s own `HELD_REASONS` docblock for what each
 *  one means and what unblocks it. */
export const NOT_READY_REASONS = Object.freeze([
  // `no-size` (#3801 Fork 4 (b), #3849 admission) joins `unshaped-no-scope` here — same semantics: an action
  // (prepare authors the missing size/estimate, the same agent that authors a missing scope, #3842) is needed
  // before the item can ever be picked up, independent of lane capacity.
  'blocked', 'unshaped-no-scope', 'no-size', 'needs-slice', 'needs-decision', 'needs-investigation', 'branch-drift-blocked', 'cleared-but-not-ready',
]);

/** Held reasons that are not a real held queue member at all — a signal to verify/clear, never to wait on. */
export const STALE_NOISE_REASONS = Object.freeze(['already-done']);

/**
 * Classify ONE dispatch-plan `held` reason into exactly one of {@link QUEUE_REPORT_BUCKETS}. REFUSES an
 * unrecognized token rather than silently defaulting it to a bucket — `dispatch-plan.mjs`'s `HELD_REASONS` is
 * the single source of the vocabulary; if it grows, this function must be updated explicitly (mirrors
 * `we:scripts/operations/gap-sweep-status.mjs`'s `shapeRunFinding`, which refuses an unrecognized outcome for
 * the identical reason: guessing a bucket for a signal this function has never seen is exactly the kind of
 * hand-classification mistake this script exists to replace).
 * @param {string} reason
 * @returns {'queued-waiting-turn'|'not-ready'|'stale-noise'}
 */
export function classifyHeld(reason) {
  const r = String(reason ?? '');
  if (QUEUED_WAITING_TURN_EXACT.includes(r) || r.startsWith(QUEUED_WAITING_TURN_PREFIX)) return 'queued-waiting-turn';
  if (NOT_READY_REASONS.includes(r)) return 'not-ready';
  if (STALE_NOISE_REASONS.includes(r)) return 'stale-noise';
  throw new Error(
    `queue-report: unrecognized held reason ${JSON.stringify(reason)} — dispatch-plan.mjs's HELD_REASONS has `
    + 'grown; update classifyHeld (and its three bucket lists) to cover it explicitly before trusting this report.',
  );
}

/** Look up `num`'s title in `byNum` (a `Map`/plain object keyed by stringified num, each value carrying
 *  `.title`), or `null` when absent (a missing enrichment must never throw — the num itself is still reported). */
function titleOf(byNum, num) {
  if (num == null) return null;
  const key = String(num);
  const it = byNum instanceof Map ? byNum.get(key) : byNum?.[key];
  return it?.title ?? null;
}

/**
 * The pure composer: dispatch-plan's `{launch, held}` + conveyor-state's active-lane/prep sections + a title
 * map → the shaped report. Every held entry is classified via {@link classifyHeld} — an unrecognized reason
 * throws rather than silently landing somewhere.
 * @param {{
 *   held?: Array<{num:*, reason:string}>,
 *   lanes?: Array<{lane:*, num:*}>,
 *   unshaped?: Array<{num:*}>,
 *   needsSlice?: Array<{num:*}>,
 *   decisions?: Array<{num:*, prepared?:boolean}>,
 *   byNum?: Map<string,{title?:string}>|Record<string,{title?:string}>,
 * }} input
 * @returns {{
 *   active: { building: Array<{num:*, title:(string|null), lane:*}>, preparing: Array<{num:*, title:(string|null), reason:string}>, fixing: null, healing: null },
 *   queuedWaitingTurn: Array<{num:*, title:(string|null), reason:string}>,
 *   notReady: { count:number, items: Array<{num:*, title:(string|null), reason:string}> },
 *   staleNoise: { count:number, items: Array<{num:*, title:(string|null), reason:string}> },
 * }}
 */
export function buildQueueReport({ held = [], lanes = [], unshaped = [], needsSlice = [], decisions = [], byNum = new Map() } = {}) {
  const entry = (num, reason) => ({ num, title: titleOf(byNum, num), reason });

  const building = (Array.isArray(lanes) ? lanes : [])
    .filter((l) => l && l.num != null)
    .map((l) => ({ num: l.num, title: titleOf(byNum, l.num), lane: l.lane }));

  const preparing = [
    ...(Array.isArray(unshaped) ? unshaped : []).map((u) => entry(u.num, 'unshaped-no-scope')),
    ...(Array.isArray(needsSlice) ? needsSlice : []).map((s) => entry(s.num, 'needs-slice')),
    ...(Array.isArray(decisions) ? decisions : []).filter((d) => d && d.prepared !== true).map((d) => entry(d.num, 'needs-decision')),
  ];

  const queuedWaitingTurn = [];
  const notReadyItems = [];
  const staleNoiseItems = [];
  for (const h of Array.isArray(held) ? held : []) {
    if (!h || h.num == null) continue;
    const bucket = classifyHeld(h.reason);
    const shaped = entry(h.num, h.reason);
    if (bucket === 'queued-waiting-turn') queuedWaitingTurn.push(shaped);
    else if (bucket === 'not-ready') notReadyItems.push(shaped);
    else staleNoiseItems.push(shaped);
  }

  return {
    active: { building, preparing, fixing: null, healing: null },
    queuedWaitingTurn,
    notReady: { count: notReadyItems.length, items: notReadyItems },
    staleNoise: { count: staleNoiseItems.length, items: staleNoiseItems },
  };
}

// ── IO SHELL (runs only as a CLI — owns all child_process / fs; keeps the pure core import-clean) ──────────────

// Lazily required so importing the pure core pulls in NO node built-ins beyond scope-lease.mjs.
async function main(argv) {
  const { execFileSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const HERE = dirname(fileURLToPath(import.meta.url));
  const LOCAL_ROOT = join(HERE, '..', '..'); // scripts/readiness → repo root, used only as a fallback

  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const log = (m) => process.stderr.write(m + '\n');
  const fail = (m) => { process.stderr.write(`✗ ${m}\n`); process.exit(1); };

  // 1. WHICH CHECKOUT — reuse resolveRunnerCheckout() rather than assuming the local cwd is the live runner's
  //    checkout (they can differ: a lane pool, a fresh clone, an operator session next to a headless runner
  //    elsewhere). Fall back to the local root when no live runner is resolved, logging why so a caller can
  //    tell the difference between "reported the runner's own queue" and "reported this checkout's own queue".
  let root = LOCAL_ROOT;
  if (!flags['no-runner-resolve']) {
    const { resolveRunnerCheckout } = await import('../conveyor/resolve-runner-checkout.mjs');
    const resolved = resolveRunnerCheckout();
    if (resolved.status === 'resolved') {
      root = resolved.cwd;
    } else {
      log(`  ⚠ could not resolve the live conveyor runner's checkout (${resolved.status}: ${resolved.reason}) — reporting the local checkout instead`);
    }
  }
  const BACKLOG_CLI_ROOT = root;
  const DISPATCH_PLAN_CLI = join(BACKLOG_CLI_ROOT, 'scripts', 'readiness', 'dispatch-plan.mjs');
  const CONVEYOR_STATE_CLI = join(BACKLOG_CLI_ROOT, 'scripts', 'readiness', 'conveyor-state.mjs');

  const runJson = (cmd, args, what) => {
    let out;
    try {
      out = execFileSync(cmd, args, { cwd: BACKLOG_CLI_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      fail(`${what} failed: ${String(e.message || e).split('\n')[0]}`);
    }
    try { return JSON.parse(out); }
    catch (e) { fail(`could not parse ${what} JSON: ${String(e.message || e).split('\n')[0]}`); }
  };

  // 2. THE HELD/LAUNCH PICTURE — reuse dispatch-plan.mjs wholesale (the single source of HELD_REASONS).
  const plan = runJson('node', [DISPATCH_PLAN_CLI, '--json'], 'dispatch-plan');

  // 3. THE ACTIVE-LANE / AUTO-PREPARE PICTURE — reuse conveyor-state.mjs wholesale (the single source of the
  //    lanes/unshaped/needsSlice/decisions sections; never re-derived here).
  const state = runJson('node', [CONVEYOR_STATE_CLI, '--json'], 'conveyor-state');

  // 4. TITLES — the SAME require(src/_data/backlog.js) → byNum idiom dispatch-plan.mjs and conveyor-state.mjs
  //    already each use independently; no separate bulk-title resolver exists in this repo, so this follows
  //    the established idiom rather than inventing a fourth copy of it.
  let byNum = new Map();
  try {
    const require = createRequire(import.meta.url);
    const loadBacklog = require(join(BACKLOG_CLI_ROOT, 'src', '_data', 'backlog.js'));
    const items = typeof loadBacklog === 'function' ? loadBacklog() : [];
    byNum = new Map(items.map((it) => [String(it.num), it]));
  } catch (e) {
    log(`  ⚠ could not load backlog for title enrichment (${String(e.message || e).split('\n')[0]}) — items reported without titles`);
  }

  const report = buildQueueReport({
    held: plan?.held,
    lanes: state?.lanes,
    unshaped: state?.unshaped,
    needsSlice: state?.needsSlice,
    decisions: state?.decisions,
    byNum,
  });

  // --full expands notReady/staleNoise from a lean count into the full item listing (default stays lean per
  // this item's spec: a caller knows the buckets exist without every one enumerated).
  if (!flags.full) {
    report.notReady = { count: report.notReady.count };
    report.staleNoise = { count: report.staleNoise.count };
  }

  if (flags.json) {
    // Drain synchronously before exit — same truncation hazard dispatch-plan.mjs's own header documents.
    writeLineSync(1, JSON.stringify(report, null, 2));
  } else {
    log(
      `queue report: ${report.active.building.length} building · ${report.active.preparing.length} preparing `
      + `(fixing/healing unavailable — live runner bookkeeping) · ${report.queuedWaitingTurn.length} queued-waiting-turn `
      + `· ${report.notReady.count} not-ready · ${report.staleNoise.count} stale-noise`,
    );
    for (const b of report.active.building) log(`  ⟳ #${b.num} ${b.title ? `"${b.title}" ` : ''}→ lane-${b.lane}`);
    for (const p of report.active.preparing) log(`  ◐ #${p.num} ${p.title ? `"${p.title}" ` : ''}(${p.reason})`);
    for (const q of report.queuedWaitingTurn) log(`  ⏳ #${q.num} ${q.title ? `"${q.title}" ` : ''}— ${q.reason} (waiting its turn)`);
    if (flags.full) {
      for (const n of report.notReady.items) log(`  ⏸ #${n.num} ${n.title ? `"${n.title}" ` : ''}— ${n.reason} (not ready)`);
      for (const s of report.staleNoise.items) log(`  ⚠ #${s.num} ${s.title ? `"${s.title}" ` : ''}— ${s.reason} (verify/clear — stale noise)`);
    }
  }
  process.exit(0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}
