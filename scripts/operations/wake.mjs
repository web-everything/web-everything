#!/usr/bin/env node
/**
 * @file scripts/operations/wake.mjs
 * @description THE WAKER — one pass over every parked run (#x0t9923, ruled by #3070).
 *
 * A suspended run resumes only when someone calls `advance`, and it cannot be the session that dispatched the
 * work: that session is gone. #3070 ruled the host — a dedicated interval job that calls `advance` and nothing
 * else, the converge daemon's SHAPE rather than the converge daemon, awake-only accepted. This is that job's
 * body; scheduling it is the operator's `StartInterval`, not this file's business.
 *
 * ONE PASS, AND IT IS SAFE TO RUN AS OFTEN AS YOU LIKE. `advance`'s no-resume path returns the run unchanged,
 * so polling changes nothing until the work is actually done. That is why #3070 could rule on WHO owns the
 * schedule without costing anything: the frequency is free, the coupling was the whole question.
 *
 * WHAT ONE PASS DOES, per run:
 *   1. read it; skip anything not parked on an in-flight effect;
 *   2. ask the registered observer about each OBSERVABLE in-flight entry (`observeRun`);
 *   3. write the record back if anything resolved — before advancing, so a crash here loses no answer;
 *   4. `advance` while it makes progress, applying any effects the run reaches.
 *
 * FAIL-SOFT PER RUN, ON PURPOSE. A pass touches every parked run in the store, so one unreadable record, one
 * missing observer or one throwing observer must not stop the others — each is collected into the report and
 * the pass continues. The alternative is a waker that stops waking everything the first time one run is odd,
 * which is worse than a waker that reports and carries on.
 *
 * THE TABLE IS INJECTED, exactly like the executor's sinks — this module knows nothing about what any handle
 * means. The CLI block at the bottom registers the ONE observer that exists today, the `claude agents`-backed
 * one that `dispatch-lane` (#3037) dispatches against; before it there was nothing in the repo to watch.
 *
 * IO: reads and writes run records through an INJECTED store, and calls INJECTED observers and sinks. The CLI
 * block at the bottom is the only part that touches the real ones.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { advance, isEffectStepSettleable, runStatus } from './engine.mjs';
import { applyPendingEffects, resolveInFlight } from './effect-executor.mjs';
import { observeRun } from './effect-observer.mjs';
import { withStepFinish, withStepStart } from './run-record.mjs';
import { createFileRunStore } from './run-store.mjs';
import { resolveOperation } from './run.mjs';
import { createDispatchObservers, defaultListAgents, listedSessionIds, normalizeHandle } from './dispatch-lane-io.mjs';
import { createExploreObservers, reclaimExploreScratch } from './explore-io.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';

/**
 * Is this run parked on work someone else is doing? Cheap enough to run over every record in the store.
 * @param {object} run
 * @returns {boolean}
 */
export function isParkedOnDispatch(run) {
  return !!(run && Array.isArray(run.effects) && run.effects.some((e) => e.status === 'in-flight'));
}

/**
 * Is this run suspended on an effect step that `advance` can finish with no sink call and no observation
 * (PR #6584 red-team)? That is the state a crash leaves between a durable write and `advance` clearing
 * `pending`: a persisted permanent guard refusal, or every effect of the step already `applied` (an observer
 * answer written by the waker itself, a last sink write, or a `--resolve` close-out). Nothing is in flight and
 * nothing will ever resolve, so neither the observer path nor `isParkedOnDispatch` sees it. It is the ENGINE's
 * own test ({@link isEffectStepSettleable}), scoped to the pending step, so the waker can never select a run
 * `advance` would leave alone. Terminal runs (`pending` cleared) never match, so a settled run is not picked
 * up — or its refusal reported — a second time.
 * @param {object} run
 * @returns {boolean}
 */
export function isParkedUnsettled(run) {
  return isEffectStepSettleable(run);
}

/**
 * ONE PASS over one run. Returns what happened rather than printing it, so the caller renders and the tests
 * assert on values.
 *
 * @param {object} run
 * @param {object} opts
 * @param {object|Map} opts.observers
 * @param {{read: Function, write: Function}} opts.store
 * @param {object} [opts.registry]
 * @param {object|Map} [opts.sinks] - needed only if advancing reaches a further effect step.
 * @param {string|Date} [opts.now]
 * @param {() => number} [opts.clock] - mints the instant a step (re)entered by THIS pass starts/finishes, as
 *   epoch ms (#3368, PR #1693 review finding 1). Sampled FRESH at each stamp site — never frozen to one
 *   upfront reading — because a step this pass both starts AND finishes (e.g. a `comment.post` sink call
 *   inside `applyPendingEffects`) has REAL elapsed time between those two stamps; a single `now` for both
 *   would silently record it as instantaneous. This is deliberately separate from `now`: `now`/`hoursStuck`
 *   answer "when did we learn a PRE-EXISTING dispatch resolved" (`effect-observer.mjs`'s `observedAt`
 *   approximation, correctly a single per-pass reading), while `clock` answers "how long did work THIS pass
 *   itself performed take" — the same distinction `cli-adapter.mjs`'s `driveRun` already draws by calling
 *   its injected `clock()` fresh at each of its four stamp sites.
 * @returns {Promise<object>} `{runId, resolved, stillRunning, skipped, errors, advanced, status}`
 */
export async function wakeRun(run, { observers, store, registry, sinks = {}, now = new Date(), clock = () => Date.now() } = {}) {
  const nowIso = () => new Date(clock()).toISOString();
  const observed = await observeRun(run, { observers, now });
  const report = {
    runId: run.id,
    resolved: observed.resolved,
    stillRunning: observed.stillRunning,
    // Terminal for the observer, not actionable by this machine — the dispatch never took, or the answer is
    // ambiguous. "The build failed" no longer lands here (#3085): an observer that knows the outcome answers
    // `resolved` instead, which writes `applied` and lets a later step react. Nothing is written for an
    // `unresolved` entry; a person decides. See `effect-observer.mjs`.
    unresolved: observed.unresolved.map((u) => ({
      ...u,
      hoursStuck: hoursStuck((run.effects || []).find((e) => e.key === u.key), now),
    })),
    skipped: observed.skipped,
    errors: [...observed.errors],
    advanced: false,
    status: null,
  };

  // PERSIST BEFORE ADVANCING. An observation is the only record that the work finished — the observer may not
  // be able to answer twice (a session's transcript is reaped, a build's log rotates), so losing it to a crash
  // during `advance` would strand the run with no way back to the answer.
  // Persist when anything changed — a resolution, or the recorded reason an entry is unresolved. The reason
  // is the only durable trace of why a run is stuck; losing it to the next tick's differing answer is the gap
  // this closes.
  if (observed.resolved.length || observed.unresolved.length) store.write(observed.run);
  let current = observed.run;

  // Nothing resolved → nothing to advance past. Say so and stop, rather than spending an `advance` that the
  // engine would return unchanged anyway. EXCEPT a refusal persisted before the run was finalized: no
  // observation will ever arrive for it, so stopping here would leave it awaiting-effect forever.
  if (!observed.resolved.length && !isParkedUnsettled(current)) {
    report.status = runStatus(current, { registry });
    return report;
  }

  // No special case for a failure, and that is the fix rather than an omission: `unresolved` writes no status,
  // so there is nothing here to special-case. `resolved` (#3085) writes `applied` and is folded into `advance`
  // below on the SAME terms `succeeded` always was — the waker calls `advance` and nothing else (#3070), so a
  // declaration with no step reading the outcome (`reads: ['findings.<step>']`) advances past it silently.
  // THAT IS DELIBERATE, not an omission left for later: ignoring a `resolved` finding is the declaration's own
  // choice, the same as ignoring any other finding the engine ever records. Refusing to advance past one nobody
  // reads would mean the waker judging a declaration by what it declared — a different, bigger call than this
  // item makes, and not this file's to make on its own. Three earlier vocabularies each wrote a status some
  // caller specially acted on — the account is on `OBSERVATIONS` in `we:scripts/operations/effect-observer.mjs`.
  try {
    for (let turn = 0; turn < 64; turn += 1) {
      const status = runStatus(current, { registry });
      const stepIndex = current.cursor;
      if (status === 'awaiting-effect') {
        // `auto`, because this is the timer. The distinction is the whole point of recording it.
        const outcome = await applyPendingEffects(current, { sinks, store, attemptedBy: 'auto' });
        current = outcome.run;
        // A permanent guard refusal is a settled fact, not a halt: it must reach `advance` so the engine ends the
        // run `refused`, exactly as `driveRun` does. Breaking here left it awaiting-effect forever.
        if (outcome.error && outcome.halted?.status !== 'refused') { report.errors.push({ key: outcome.halted?.key, error: String(outcome.error.message ?? outcome.error) }); break; }
        // Parked again on a NEW dispatch — a legitimate outcome, and the next pass picks it up.
        if (outcome.inFlight && outcome.inFlight.length) break;
        // ADVANCE, do not loop back. `applyPendingEffects` does not clear `pending` — only `advance` does — so
        // re-entering the effect branch would apply nothing and spin to the turn cap.
        const settled = advance(current, { registry });
        // A refusal is reported ONCE, here: the run is terminal after this pass, so no later tick repeats it, and
        // the wake CLI exits non-zero exactly as `driveRun` does for `effect-refused`.
        if (outcome.error) {
          report.errors.push({ key: outcome.halted?.key, error: String(outcome.error.message ?? outcome.error) });
          // An advance that cannot settle it would re-apply the same refusal every turn: stop instead of spinning.
          if (settled === current) break;
        }
        current = settled;
        // THE FINISH STAMP a dispatch was missing (#3368): a build that ran 40 minutes now reads as 40
        // minutes, not as absent — `withStepFinish` is a no-op unless `advance` just resolved THIS step.
        current = current.cursor > stepIndex ? withStepFinish(current, { stepIndex, at: nowIso() }) : current;
        store.write(current);
        report.advanced = true;
        continue;
      }
      // A step the waker itself steps THROUGH (e.g. a `compute` right after a resolved effect) still needs a
      // start stamp — the ONLY place besides `cli-adapter.mjs`'s `driveRun` that can newly enter a `running`
      // step. Every other suspend below (a confirm/judge with no answer) is somebody else's stop and was
      // already stamped started when it first suspended, so this is a no-op for those.
      if (status === 'running') {
        const declaration = registry.get(current.op);
        current = withStepStart(current, { step: declaration.steps[stepIndex]?.name, stepIndex, at: nowIso() });
      }
      // Every other suspend is somebody else's stop: a confirm is owed to a person or a policy, a judge needs
      // a spawn. The waker calls `advance` and nothing else (#3070), so it hands those back untouched.
      const next = advance(current, { registry });
      if (next === current) break;
      current = next.cursor > stepIndex ? withStepFinish(next, { stepIndex, at: nowIso() }) : next;
      store.write(current);
      report.advanced = true;
    }
  } catch (e) {
    // PERSIST THE START STAMP EVEN ON A THROW (PR #1693 review, finding 2). A `running` step's declaration
    // fn can throw deterministically (see `cli-adapter.mjs`'s identical `step-refused` handling) — `current`
    // above already carries that step's `withStepStart` row by the time `advance` throws, but nothing had
    // written it to disk yet. Without this, the persisted record shows no trace the step ever started,
    // contradicting this item's own "started, never a fabricated finish" guarantee for exactly this path.
    store.write(current);
    report.errors.push({ error: String(e?.message ?? e) });
  }

  report.status = runStatus(current, { registry });
  return report;
}

/**
 * ONE PASS over every parked run in the store.
 *
 * `resolveFor` maps a run's operation name to its `{registry, sinks}` — injected so this module does not
 * import the operation table and stays testable with two lines of stub.
 *
 * @param {object} opts
 * @param {{read: Function, write: Function, list: Function}} opts.store
 * @param {object|Map} opts.observers
 * @param {(op: string) => {registry: object, sinks: object}} opts.resolveFor
 * @param {string|Date} [opts.now]
 * @param {(o: {store: object}) => {reclaimed: string[], errors: object[]}} [opts.reclaim] - the scratch
 *   housekeeping run AFTER every parked run is handled, so a run this pass completed is reclaimed in it. The CLI
 *   passes `explore-io.mjs#reclaimExploreScratch` (#2304); omitted, nothing is reclaimed. A throw is reported in
 *   `errors`, like every other fault in a pass.
 * @returns {Promise<{scanned: number, parked: number, runs: object[], errors: object[], reclaimed: string[]}>}
 */
export async function wakePass({ store, observers, resolveFor, now = new Date(), reclaim = null } = {}) {
  // FAIL-SOFT AT THE FRONT DOOR TOO (PR #1186 review, NB-4). The header promises per-run fail-soft and the
  // scan sat outside every `try`, so a store whose `list` throws took the whole pass down. It is still a real
  // fault — the caller sees it in `errors` and the CLI exits non-zero — but it is reported in the same shape
  // as everything else rather than as an exception the caller has to know to catch.
  const runs = [];
  const errors = [];
  let parked = 0;
  let ids;
  try {
    ids = store.list();
    // A `list()` that RETURNS a non-array takes the pass down exactly as a throwing one used to — the first
    // fix wrapped the call and left the use outside it (PR #1186 round 2, NB2-2).
    if (!Array.isArray(ids)) throw new TypeError(`store.list() returned ${typeof ids}, not an array`);
  } catch (e) {
    return { scanned: 0, parked: 0, runs, errors: [{ error: String(e?.message ?? e) }], reclaimed: [] };
  }

  for (const id of ids) {
    let run;
    try { run = store.read(id); } catch (e) { errors.push({ runId: id, error: String(e?.message ?? e) }); continue; }
    if (!run || !(isParkedOnDispatch(run) || isParkedUnsettled(run))) continue;
    parked += 1;
    let bindings;
    try { bindings = resolveFor(run.op); } catch (e) { errors.push({ runId: id, error: String(e?.message ?? e) }); continue; }
    try {
      runs.push(await wakeRun(run, { observers, store, registry: bindings.registry, sinks: bindings.sinks, now }));
    } catch (e) {
      // NOT belt-and-braces, though it was labelled that for four review rounds. It is the ONLY thing
      // catching what escapes `wakeRun`'s own try — a throwing `store.write`, a null observers table, a
      // malformed record — each of which would otherwise stop the pass for every other run.
      errors.push({ runId: id, error: String(e?.message ?? e) });
    }
  }

  const reclaimed = [];
  if (reclaim) {
    try {
      const swept = reclaim({ store });
      reclaimed.push(...(swept?.reclaimed || []));
      errors.push(...(swept?.errors || []).map((x) => ({ runId: x.runId, error: `scratch reclaim: ${x.error}` })));
    } catch (e) {
      errors.push({ error: `scratch reclaim: ${String(e?.message ?? e)}` });
    }
  }

  return { scanned: ids.length, parked, runs, errors, reclaimed };
}

/**
 * How long an unresolved entry has been going, in hours, from the `startedAt` the dispatch already records.
 * No new state: the escalation the reviewer asked for needs nothing durable that is not already there.
 */
export function hoursStuck(entry, now = new Date()) {
  const started = entry?.startedAt ? Date.parse(entry.startedAt) : NaN;
  const at = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (Number.isNaN(started) || Number.isNaN(at)) return null;
  return Math.max(0, (at - started) / 3_600_000);
}

/**
 * After this many hours, an unresolved entry stops being reported and starts being ESCALATED — a non-zero
 * exit, so a supervisor watching exit codes learns something. It is a REPORTING bound, never a retry bound:
 * nothing is re-dispatched at any age. Retry is #3083 and has no owner yet.
 */
export const STUCK_ESCALATION_HOURS = 6;

/** Unresolved entries whose age has passed `hours`. PURE — the age is already on the report. */
export function stuckPast(pass, hours = STUCK_ESCALATION_HOURS) {
  return (pass.runs || []).flatMap((r) => (r.unresolved || [])
    .filter((u) => typeof u.hoursStuck === 'number' && u.hoursStuck >= hours)
    .map((u) => ({ runId: r.runId, ...u })));
}

/** One pass as operator-facing lines. PURE. Quiet when there is nothing parked — this runs on a timer. */
export function renderPass(pass) {
  const reclaimed = pass.reclaimed || [];
  const reclaimLine = reclaimed.length
    ? [`  reclaimed the explore scratch directory of ${reclaimed.length} completed run(s): ${reclaimed.join(', ')}`]
    : [];
  if (!pass.parked && !pass.errors.length) {
    return [`wake: ${pass.scanned} run(s) scanned, none parked on a dispatch.`, ...reclaimLine];
  }
  const lines = [`wake: ${pass.scanned} run(s) scanned, ${pass.parked} parked.`, ...reclaimLine];
  for (const r of pass.runs) {
    const bits = [
      r.resolved.length ? `resolved ${r.resolved.map((x) => `${x.key}→${x.status}`).join(', ')}` : '',
      r.stillRunning.length ? `still running ${r.stillRunning.join(', ')}` : '',
      r.unresolved?.length ? `NEEDS A PERSON — terminal but not actionable: ${r.unresolved.map((x) => `${x.key}${x.error ? ` (${x.error})` : ''}`).join(', ')}`
        + ` · close it out: \`node scripts/operations/wake.mjs --resolve=${r.runId} --key=<effectKey>`
        + ' --status=failed` (nothing landed → the next run re-dispatches) or `--status=applied` (it did land).'
        + ' The same call is `resolveInFlight(run, key, { status })` from a script' : '',
      r.skipped.length ? `SKIPPED ${r.skipped.map((x) => `${x.key} (${x.reason})`).join(', ')}` : '',
      r.errors.length ? `ERRORS ${r.errors.map((x) => x.error).join(' | ')}` : '',
      r.advanced ? 'advanced' : '',
      r.status ? `now ${r.status}` : '',
    ].filter(Boolean);
    lines.push(`  ${r.runId}: ${bits.join(' · ')}`);
  }
  for (const e of pass.errors) lines.push(`  ${e.runId ?? '?'}: ERROR ${e.error}`);
  const stuck = stuckPast(pass);
  for (const u of stuck) {
    lines.push(`  ESCALATED — ${u.runId}:${u.key} has been unresolved for ${u.hoursStuck.toFixed(1)}h `
      + `(over ${STUCK_ESCALATION_HOURS}h). Nothing is being retried; this needs a person.`);
  }
  return lines;
}

/**
 * CLOSE ONE IN-FLIGHT ENTRY OUT — the CLI surface `resolveInFlight` never had (PR #1211 review, F1).
 *
 * WHY IT LIVES HERE. The waker is the process that discovers a stuck entry and the only thing that prints its
 * key, so it is where the operator already is when they need to act. Until now the answer printed by
 * `renderPass` was "no CLI surface yet, so a short script" — and for `dispatch-lane` that mattered more than it
 * looked: its observer could not answer `succeeded` at all (`claude agents` reports liveness, not outcome), so
 * EVERY completed dispatch needed a person, and "write some node" once per build is not a remedy.
 *
 * IT IS NO LONGER THE ONLY WAY OUT, AND IS UNCHANGED BY THAT (#x9ylkp7). The observer now also reads the
 * entry's PR and resolves a MERGED one on its own, so the clean case closes itself. This surface stays exactly
 * as it was, because the cases it exists for are the ones the machine still cannot rule on: a PR that was
 * closed unmerged, one parked mid-review, a build that never opened one at all, and a match that can only be
 * attributed to an earlier attempt. The two paths coexist and neither needs the other.
 *
 * IT OWNS EXACTLY ONE RULE, AND `resolveInFlight` OWNS EVERY OTHER. The status rules — terminal only,
 * `in-flight` only, no rewriting a settled entry — are `resolveInFlight`'s and are called first, so a malformed
 * close-out is refused before anything else happens. The one rule that lives HERE is liveness, because it is
 * the one `resolveInFlight` structurally cannot know: see {@link assertHandleNotLive}.
 *
 * @param {object} o
 * @param {string} o.runId
 * @param {string} o.key - the effect key, exactly as the pass printed it.
 * @param {'applied'|'failed'} o.status
 * @param {string} [o.note] - what the person found out. Recorded, never interpreted.
 * @param {boolean} [o.force] - close out even though the handle is still listed (or cannot be checked).
 * @param {() => object[]} [o.listAgents] - injectable `claude agents --json` reader.
 * @param {{read: Function, write: Function}} o.store
 * @returns {string} one operator-facing line.
 */
export function closeOutEntry({ runId, key, status, note = '', force = false, store, listAgents = defaultListAgents } = {}) {
  if (!runId || !key) {
    throw new Error('wake --resolve: needs both --resolve=<runId> and --key=<effectKey> (the pass prints the key).');
  }
  const run = store.read(runId);
  if (!run) throw new Error(`wake --resolve: no run record for ${JSON.stringify(runId)}`);
  const said = String(note || '').trim();
  // FIRST, so a bad status or an unknown key is refused before a subprocess is spawned to check liveness.
  const next = resolveInFlight(run, key, status === 'failed'
    // WHY THE NOTE LANDS IN DIFFERENT FIELDS: `resolveInFlight` records `error` on a failure and `result` on a
    // success, and putting a person's sentence anywhere else would make it invisible to the same readers.
    ? { status, error: said || 'closed out by an operator: the work did not land' }
    : { status, result: { closedOutBy: 'operator', note: said || null } });
  if (!force) assertHandleNotLive((run.effects || []).find((e) => e.key === key), { listAgents });
  store.write(next);
  return `wake: ${runId}:${key} closed out as \`${status}\`${said ? ` — ${said}` : ''}${force ? ' (--force: liveness not checked)' : ''}.`;
}

/**
 * REFUSE to close out an entry whose agent is still listed by `claude agents --json` (PR #1211 round 2, G2).
 *
 * WHAT WENT WRONG WITHOUT IT. `--resolve --status=failed` performed no liveness check at all, so running it on
 * a five-minute-old, still-live dispatch un-parked the run; `failed` is retried by the executor with no cap;
 * and the retry started a SECOND agent under the same deterministic session slug. Two live agents, one lane,
 * and — before the executor kept `supersededHandles` — only one of them findable at all.
 *
 * WHY THIS RULE CANNOT LIVE IN `resolveInFlight`. That function is pure and knows nothing about what a handle
 * MEANS; asking whether a session is alive is io, and `dispatch` is the only effect kind in the repo whose
 * handle can be asked about. So the check lives at the operator's surface, where the io already is.
 *
 * FAIL CLOSED, WITH THE DOOR ONE FLAG AWAY. A listing that cannot be read is not evidence the agent is dead,
 * so it refuses too — but `--force` always gets through, because `--resolve` remains the operator's answer for
 * every dispatch the observer cannot rule on (#x9ylkp7 resolves the merged-PR case and no other), and an
 * environment with no working `claude` must not wedge it. A handle-less INDETERMINATE entry is passed straight
 * through: there is nothing to ask about.
 *
 * @param {object} entry - the in-flight effect entry being closed out.
 * @param {{listAgents?: () => object[]}} [o]
 */
export function assertHandleNotLive(entry, { listAgents } = {}) {
  const handle = normalizeHandle(entry?.handle);
  if (!handle) return; // INDETERMINATE — no handle exists to check, and that is why a person is here.
  const advice = `Stop that session first, or re-run with --force if you know it is not running. Closing out a LIVE `
    + 'dispatch un-parks the run, and the executor then retries it — which for a dispatch means starting a SECOND agent '
    + 'on the same lane, under the same session slug.';
  let sessions;
  try {
    sessions = listAgents();
  } catch (e) {
    throw new Error(
      `wake --resolve: could not read \`claude agents --json\` to check whether ${handle} is still running `
      + `(${String(e?.message ?? e).split('\n')[0]}) — refusing to close out an entry whose agent MIGHT be alive. ${advice}`,
    );
  }
  if (!Array.isArray(sessions)) {
    throw new Error(
      `wake --resolve: \`claude agents --json\` did not return an array, so whether ${handle} is still running `
      + `cannot be told — refusing to close out an entry whose agent MIGHT be alive. ${advice}`,
    );
  }
  // PARSED FINE, YIELDED NOTHING MATCHABLE. A listing with elements in it but no usable `sessionId` on any of
  // them was READ and NOT UNDERSTOOD — it says nothing about this handle. Without this branch the `.some()`
  // below returns false and `--resolve` closes the entry out on the strength of that read, un-parking a run
  // whose agent may be alive; the executor then retries, which for a dispatch means a SECOND agent in the same
  // lane clone. Refuse exactly as the not-an-array branch does, and leave `--force` as the way through
  // (PR #1211 round-3 review, H1/H2).
  const listed = listedSessionIds(sessions);
  if (sessions.length && !listed.size) {
    throw new Error(
      `wake --resolve: \`claude agents --json\` returned ${sessions.length} element(s) but not one carried a usable `
      + `\`sessionId\`, so whether ${handle} is still running cannot be told — refusing to close out an entry whose `
      + `agent MIGHT be alive. ${advice}`,
    );
  }
  if (listed.has(handle)) {
    throw new Error(
      `wake --resolve: session ${handle} is STILL LISTED by \`claude agents\` — the agent is ALIVE. ${advice}`,
    );
  }
}

/** One `--name` / `--name=value` flag out of an argv. `''` when present with no value, `undefined` when absent. */
export function flagValue(argv, name) {
  const hit = (argv || []).find((a) => a === `--${name}` || String(a).startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq = String(hit).indexOf('=');
  return eq === -1 ? '' : String(hit).slice(eq + 1);
}

/**
 * THE OBSERVERS, one per dispatching effect type, and each arrived with the thing that dispatches it: the
 * delivery agent (#3037) and the committee panelist (#3150). Until the first of them this table was empty on
 * purpose — an observer with no work to watch is an implementation with no caller. Any OTHER in-flight type is
 * still reported as `no-observer` rather than silently ignored.
 *
 * EXPORTED, and the CLI calls THIS rather than spreading inline, because the safety of the spread — that the
 * two tables are keyed by DISTINCT effect types, so neither can shadow the other — was asserted in a comment
 * and defended by nothing (review-pr correctness juror on #1457: CONFIRMED, `impactIfUnfixed: broken`). A
 * shadowed observer does not fail loudly; it watches the wrong work, which is the shape that never announces
 * itself. A test can hold that line only if it can call the same merge the CLI runs — so the merge is a
 * function, not four words inside an `if`.
 */
export function createWakeObservers() {
  return { ...createDispatchObservers(), ...createExploreObservers() };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const observers = createWakeObservers();
  const argv = process.argv.slice(2);
  const resolveId = flagValue(argv, 'resolve');
  if (resolveId !== undefined) {
    // THE CLOSE-OUT PATH. It observes nothing and advances nothing: a person has already found out what
    // happened, and this records it. The next pass is what picks the run up again.
    try {
      writeAllSync(1, `${closeOutEntry({
        runId: resolveId,
        key: flagValue(argv, 'key'),
        status: flagValue(argv, 'status'),
        note: flagValue(argv, 'note') || '',
        // PRESENT AT ALL IS ENOUGH — `--force` takes no value, and requiring `--force=true` would be a footgun
        // on the one flag an operator reaches for when everything else has already refused them.
        force: flagValue(argv, 'force') !== undefined,
        store: createFileRunStore(),
      })}\n`);
    } catch (e) {
      writeAllSync(1, `error: ${String(e?.message ?? e)}\n`);
      process.exitCode = 1;
    }
  } else {
    wakePass({
      store: createFileRunStore(),
      observers,
      resolveFor: (op) => {
        const { registry, sinks } = resolveOperation(op);
        return { registry, sinks };
      },
      // THE ONLY RECLAIMER of an explore committee's panelist reports — see `explore-io.mjs`'s header.
      reclaim: ({ store }) => reclaimExploreScratch({ store }),
    })
      .then((pass) => {
        writeAllSync(1, `${renderPass(pass).join('\n')}\n`);
        // AN INTERVAL JOB'S EXIT CODE IS THE ONLY THING A SUPERVISOR SEES, so two things earn a non-zero one:
        // a pass that could not read a run or resolve its operation, and a run stuck unresolved past
        // `STUCK_ESCALATION_HOURS`. Before the second, a permanently unresolvable run reported at exit 0 on
        // every tick forever and nothing watching exit codes ever learned. Per-run OBSERVER errors stay at 0:
        // those are the fail-soft case, already reported, and the next pass asks again.
        process.exitCode = (pass.errors.length || stuckPast(pass, STUCK_ESCALATION_HOURS).length) ? 1 : 0;
      })
      .catch((e) => {
        writeAllSync(1, `error: ${String(e?.message ?? e)}\n`);
        process.exitCode = 1;
      });
  }
}
