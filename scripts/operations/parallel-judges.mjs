/**
 * @file scripts/operations/parallel-judges.mjs
 * @description RUN INDEPENDENT JUROR SEATS AT THE SAME TIME (`review.parallelSeats`).
 *
 * THE COST THIS REMOVES. `driveRun` (`we:scripts/operations/cli-adapter.mjs`) spawns one `judge` step, waits for it,
 * resumes the run, and only then reaches the next `judge` step. `review-pr` declares up to six juror seats in a row
 * and none of them reads another's answer, so a review paid the SUM of its seats' wall time (live, PR #4689,
 * 2026-10-10: five seats, 97+90+32+74+42 s, 335 s end to end) when the slowest seat (97 s) was all it needed.
 *
 * NO ENGINE CHANGE, NO NEW STEP KIND. The engine (`./engine.mjs`) still steps one record one step at a time, and
 * the run record is still written in declared order. This module only looks AHEAD: from a run suspended on a judge
 * step, it walks the following steps while they are `judge` steps whose declared `reads` name none of the seats
 * already in the batch, and asks the engine — on a throwaway copy of the record — what each would request. Those
 * requests are spawned together. The answers are then fed back ONE AT A TIME, in declared order, through the
 * ordinary resume path, so findings, verdict and telemetry are the same bytes the sequential drive would have
 * written for the same answers. Only the step timings differ: they record when each seat really ran, which is the
 * point.
 *
 * A seat's request is computed twice (once here, once when the engine reaches it for real). The two are compared,
 * and a mismatch throws the early answer away and spawns again — a safe fallback, never a guess. A request fn is
 * pure over its declared reads, and the reads exclude every batch member, so this does not happen in practice.
 *
 * ONE LANE PER TOOL-BEARING SEAT. A seat that carries `allowedTools` may run commands in its working tree. Two of them
 * must not share one tree at the same time, so: the first tool-bearing seat runs in the caller's lane (the judge's
 * own `cwd`); each further tool-bearing seat asks `seatLanes.acquire()` for a lane of its own and runs concurrently
 * there. When no lane is available (no provider, or the pool is full) that seat waits for the primary lane instead —
 * the old sequential behaviour for that seat only, never two tool-bearing seats in one tree. Tool-free seats (Codex,
 * agy) never need a tree and always start at once. Every leased lane is released when the batch settles.
 *
 * IMPURE only through what it is handed (the judge, the clock, the lane provider); it imports the pure engine.
 */

import { advance } from './engine.mjs';

/** Does a step's declared `reads` list depend on any step named in `names`? PURE. */
export function readsAnyStep(reads, names, declaration) {
  for (const path of Array.isArray(reads) ? reads : []) {
    const [root, leaf] = String(path).split('.');
    if (root === 'findings' && (leaf === undefined || names.has(leaf))) return true;
    if (root === 'verdict' && declaration?.verdictFrom && names.has(declaration.verdictFrom)) return true;
  }
  return false;
}

/** Does this judge request carry tools (and therefore need a working tree of its own)? PURE. */
export function isToolBearingRequest(request) {
  return Array.isArray(request?.allowedTools) && request.allowedTools.length > 0;
}

/**
 * THE BATCH a run suspended on a `judge` step could run now. PURE (it calls the pure engine on a copy).
 *
 * Starts with the pending seat and adds each following step while it is a `judge` step whose reads do not depend on
 * a seat already in the batch. Stops at the first step that is not (a `compute`, a `confirm`, an `effect`, a
 * dependent judge) or that the engine refuses to step — the ordinary drive then reaches it and reports it exactly as
 * it always has.
 *
 * @param {object} run - a run record whose `pending.kind` is `judge`.
 * @param {{registry: object}} o
 * @returns {Array<{stepIndex: number, step: string, request: object}>} empty when the run is not on a judge step.
 */
export function planJudgeBatch(run, { registry } = {}) {
  if (!run?.pending || run.pending.kind !== 'judge') return [];
  const declaration = registry.get(run.op);
  const batch = [{ stepIndex: run.pending.stepIndex, step: run.pending.step, request: run.pending.request }];
  const names = new Set([run.pending.step]);
  // The throwaway copy: the pending seat is treated as answered WITHOUT an answer (its finding stays absent), which
  // is safe exactly because no step admitted below reads it.
  let spec = { ...run, pending: null, cursor: run.pending.stepIndex + 1 };
  while (spec.cursor < declaration.steps.length) {
    const entry = declaration.steps[spec.cursor];
    if (entry.step.kind !== 'judge') break;
    if (readsAnyStep(entry.step.reads, names, declaration)) break;
    let next;
    try { next = advance(spec, { registry }); } catch { break; }
    if (!next?.pending || next.pending.kind !== 'judge' || next.pending.stepIndex !== entry.index) break;
    batch.push({ stepIndex: entry.index, step: entry.name, request: next.pending.request });
    names.add(entry.name);
    spec = { ...next, pending: null, cursor: entry.index + 1 };
  }
  return batch;
}

/** Same request, byte for byte? PURE. */
export function sameJudgeRequest(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

/**
 * SPAWN A BATCH CONCURRENTLY. Never throws: every seat settles to `{ok, value|error, startedAt, finishedAt, cwd}`.
 *
 * @param {object} o
 * @param {Array<{stepIndex: number, step: string, request: object}>} o.batch - from {@link planJudgeBatch}.
 * @param {(request: object, opts?: {cwd: string}) => Promise<*>} o.judge - the run's judge. A seat given its own
 *   lane is called with `{cwd}` as the second argument; every other seat is called with the request alone.
 * @param {() => number} [o.clock] - epoch ms.
 * @param {{acquire: (seat: {step: string, lens: (string|undefined)}) => (Promise<{cwd: string, release?: Function}|null>|{cwd: string, release?: Function}|null)}|null} [o.seatLanes]
 * @param {(line: string) => void} [o.log]
 * @returns {Promise<Array<{step: string, stepIndex: number, request: object, ok: boolean, value?: *, error?: *,
 *   startedAt: number, finishedAt: number, cwd: (string|null)}>>} in batch order.
 */
export async function runJudgeBatch({ batch, judge, clock = () => Date.now(), seatLanes = null, log = () => {} } = {}) {
  const results = new Array(batch.length);
  const leases = [];
  const launch = (k, cwd) => {
    const seat = batch[k];
    const startedAt = clock();
    log(`parallel seats: ${seat.step} started${cwd ? ` in its own lane ${cwd}` : ''}`);
    return Promise.resolve()
      .then(() => (cwd ? judge(seat.request, { cwd }) : judge(seat.request)))
      .then(
        (value) => { results[k] = { ...seat, ok: true, value, startedAt, finishedAt: clock(), cwd: cwd ?? null }; },
        (error) => { results[k] = { ...seat, ok: false, error, startedAt, finishedAt: clock(), cwd: cwd ?? null }; },
      )
      .then(() => log(`parallel seats: ${seat.step} ${results[k].ok ? 'returned' : 'failed'} after ${results[k].finishedAt - startedAt} ms`));
  };

  const running = [];
  const needsLane = [];
  let primary = null; // the chain of seats that run in the caller's own lane, one after another
  batch.forEach((seat, k) => {
    if (!isToolBearingRequest(seat.request)) { running.push(launch(k)); return; }
    if (!primary) { primary = launch(k); return; }
    needsLane.push(k);
  });
  for (const k of needsLane) {
    let lease = null;
    try { lease = seatLanes ? await seatLanes.acquire({ step: batch[k].step, lens: batch[k].request?.lens }) : null; } catch (e) {
      log(`parallel seats: no own lane for ${batch[k].step} (${String(e?.message ?? e)}) — it waits for the primary lane`);
      lease = null;
    }
    if (lease && typeof lease.cwd === 'string' && lease.cwd) {
      leases.push(lease);
      running.push(launch(k, lease.cwd));
    } else {
      // No lane of its own: run after the seats already queued on the primary lane, never beside them.
      primary = (primary ?? Promise.resolve()).then(() => launch(k));
    }
  }
  if (primary) running.push(primary);
  try {
    await Promise.all(running);
  } finally {
    for (const lease of leases) {
      try { await lease.release?.(); } catch (e) { log(`parallel seats: releasing ${lease.cwd} failed (${String(e?.message ?? e)})`); }
    }
  }
  return results;
}
