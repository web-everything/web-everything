/**
 * @file scripts/operations/effect-executor.mjs
 * @description THE EFFECT EXECUTOR — the only thing in the engine that touches the world (#3032, epic #3029).
 *
 * An `effect` step DECLARES effects; this applies them, **keyed by run + step + ordinal**, so re-running
 * after a partial failure is safe and no caller has to hand-order two non-atomic writes. It is the
 * mechanism the statute (#operations-declared-once-callers-generated, #3031) says subsumes both the
 * *"a non-zero exit means re-run the same command"* instruction and the [#2964] write-ordering rule.
 *
 * HOW IT BEATS #2964, WHICH IS THE BAR. #2964 (resolved) is `runReviewLabelCli` splitting one logical act
 * across two `gh` calls with the UNSAFE half first: the label swap landed, then the comment carrying the
 * `reviewed-sha` marker failed, and `acceptanceCoversHead` fails OPEN on a missing marker. Its fix was to
 * REORDER the two calls by hand — the safe half first. This executor gives three guarantees, and the first
 * alone is what #2964 bought:
 *
 *   1. **Declared order is applied order.** Effects run strictly ascending by ordinal, `await`ed one at a
 *      time, and the executor HALTS at the first one that does not land. Effect N+1 is never attempted
 *      before N is `applied`. The declaration is therefore the ordering, in one readable place, instead of
 *      an ordering rule maintained by hand at every call site.
 *   2. **The half-done state is recoverable, not just avoided.** #2964's reordering still leaves the act
 *      half-done on a crash — it only chooses WHICH half. Here the run record remembers exactly which
 *      ordinals landed, so a replay finishes the act instead of restarting or abandoning it.
 *   3. **Replay never double-applies.** An `applied` entry is skipped, so the safe half is not re-posted
 *      while the unsafe half is retried.
 *
 * THE THIRD OUTCOME NOBODY WANTS TO WRITE DOWN: INDETERMINATE. A sink that throws may still have written.
 * So the executor marks an entry `pending` BEFORE calling the sink and only marks it `applied` after; an
 * entry left `pending` is an attempt whose outcome is unknown. On replay such an entry is:
 *   - **re-applied** when the effect declared `idempotent: true` (re-doing it is harmless by construction), or
 *   - **REFUSED** otherwise — the run stops and a person decides, which is the fail-closed answer. Guessing
 *     here is how you double-post a comment or double-merge a PR.
 * A sink that KNOWS nothing landed says so by throwing an error built with {@link notApplied}; that entry is
 * marked `failed` and is retried on the next pass.
 *
 * THE LEDGER SEAM — deliberately empty here. {@link LEDGER_EFFECT_TYPE} is the reserved effect type the
 * **verdict ledger** (#3007) lands behind: an append-only JSONL of review verdicts, keyed by repo + PR +
 * append order, which #3007 PHASE 1 now writes in SHADOW (labels are still what the drain merges on; Phase 2
 * flips the authority and is unbuilt). Two details this comment used to state are corrected in
 * `we:scripts/lib/verdict-ledger.mjs`'s header and were wrong: the records are NOT keyed on the diff
 * content-hash (that digest has two proven divergence defects, #3046 and `#3052`, open under `#3054`), and
 * the drain lease does NOT make the writers single — the ledger takes its own lock. This executor SHIPS NO
 * SINK FOR IT and owns no durable outcome store of its own — it only routes to a sink the caller registers.
 * That is the producer→store relationship: the run record is the transient working state, the ledger is the
 * durable authority, and #3032 must not invent a competitor to it (see the `run-record.mjs` header).
 *
 * IO: this file writes the run record through an INJECTED store handle and calls INJECTED sinks. It imports
 * no `fs` and no `child_process` itself, so the whole executor is testable with an in-memory store and stub
 * sinks — no process, no network.
 */

import { effectsForStep } from './engine.mjs';
import { assertRunRecord, isPollableHandle, PERMANENT_GUARD_REFUSAL_MARKERS } from './run-record.mjs';

/**
 * The reserved effect type for an append to the #3007 verdict ledger. Named here so #3035/#3036 declare
 * against a stable string and #3007 can register the writer behind it without touching this file.
 */
export const LEDGER_EFFECT_TYPE = 'verdict-ledger.append';

/**
 * Build the error a sink throws when it is CERTAIN nothing landed (a refused connection, a pre-flight
 * validation failure, a 4xx before any write). Marks the entry `failed`, which is retried on replay —
 * unlike a bare throw, which is treated as indeterminate.
 *
 * @param {string} message
 * @param {object} [extra]
 * @returns {Error}
 */
export function notApplied(message, extra = {}) {
  return Object.assign(new Error(message), { ...extra, notApplied: true });
}

/** A permanent guard refusal proves nothing landed and names a recognized guard. */
export function isPermanentGuardRefusal(error) {
  return error?.notApplied === true && typeof error.message === 'string'
    && PERMANENT_GUARD_REFUSAL_MARKERS.some((marker) => error.message.includes(marker));
}

/**
 * The marker a sink returns to say **"I started something that outlives this run"** (#3073).
 *
 * WHY A FOURTH STATE, AND WHY `applied` IS NOT IT. `applied` means the sink RAN, not that the work it started
 * FINISHED — and for every effect until now those were the same event. A dispatch breaks that: the sink starts
 * a build and returns in a second, so marking it `applied` records a completion that has not happened, and the
 * run advances past a step whose work is still going.
 *
 * WHY IT IS NOT `pending` EITHER, which is the confusion the #3030 spike named. `pending` means *attempted,
 * outcome UNKNOWN* — the process died mid-sink — and the replay guard rightly REFUSES a non-idempotent one
 * rather than risk a double-apply. In-flight means *started ON PURPOSE, outcome arrives later*, and refusing
 * it would be exactly wrong: it is the one state a replay is supposed to resume from. One status cannot mean
 * both without the guard being wrong half the time.
 *
 * THE DECLARATION SAYS SO FIRST. An effect opts in with `dispatch: true`, and the executor writes `in-flight`
 * BEFORE calling the sink.
 *
 * WHAT THAT ORDERING BUYS, and only for a PROCESS DEATH. It does NOT make a dispatch crash resumable: the
 * no-handle case below is REFUSED on replay, same as `pending`. What it buys is that a process killed between
 * starting the work and hearing back lands in a state a person can see and act on:
 *   - `inFlightEntries` reports it under `unknown` — "something may be running and cannot be observed" — where
 *     a `pending` entry says only "an attempt was made", losing the fact that work may still be out there.
 *   - `resolveInFlight` accepts it, so there is a supported way to close it out. `pending` has none, and the
 *     operator's only option is to hand-edit the run record.
 * Writing `in-flight` after the sink returned would put a process-killed dispatch back in `pending`, invisible
 * to both. A sink that THROWS is a different path and does not need the ordering — the catch branch below
 * records `in-flight` on its own.
 *
 * The sink then supplies what only it can know, by returning `inFlight({ handle, expectedBy })`:
 *   - `handle` is what a later observer polls. The spike established `sessionId` is durable and `pid` is NOT
 *     (the OS reuses it), so a handle must never be a pid.
 *   - `expectedBy` is an ISO timestamp — the earliest point at which "still running" becomes "probably dead".
 *     Without it a waker can tell finished from not-finished but not RUNNING from STALLED, which are the two
 *     that need opposite responses. Optional, because some work genuinely has no estimate; an entry without
 *     one is honestly unbounded rather than falsely bounded.
 *
 * AND A LOST HANDLE IS NOT "STILL RUNNING". Resumability rests entirely on being observable, so an in-flight
 * entry with no handle — the sink died before reporting one — has degraded back into "might have started,
 * cannot check", and {@link applyPendingEffects} refuses it exactly as it refuses an indeterminate `pending`.
 * {@link inFlightEntries} reports it under `unknown`, never `running`.
 */
export function inFlight({ handle, expectedBy = null, dispatch } = {}) {
  if (!isPollableHandle(handle)) {
    throw new TypeError('operations: `inFlight` needs a durable `handle` with a visible character — a pid is not one (the OS reuses it)');
  }
  if (expectedBy !== null && !(typeof expectedBy === 'string' && !Number.isNaN(Date.parse(expectedBy)))) {
    throw new TypeError('operations: `inFlight.expectedBy` must be an ISO timestamp or null');
  }
  // #3717/#3906 — an optional `dispatch` record (the route, the executed provider, the worker model) the
  // executor persists beside the handle. Plain JSON only: it lands in the run record as-is.
  if (dispatch !== undefined && dispatch !== null) {
    const plain = (v) => v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
    const visit = (v, seen = new Set()) => {
      if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
      if ((!Array.isArray(v) && !plain(v)) || seen.has(v) || Reflect.ownKeys(v).some((k) => typeof k === 'symbol')) throw new TypeError('operations: dispatch must be plain JSON');
      seen.add(v);
      for (const x of Object.values(v)) visit(x, seen);
      seen.delete(v);
    };
    if (!plain(dispatch)) throw new TypeError('operations: dispatch must be a plain JSON object or null');
    visit(dispatch);
    dispatch = JSON.parse(JSON.stringify(dispatch));
  }
  return { [IN_FLIGHT]: true, handle: handle.trim(), expectedBy, ...(dispatch === undefined ? {} : { dispatch }) };
}

/**
 * The brand `inFlight` stamps and the executor reads.
 *
 * A MODULE-LOCAL `Symbol()`, not `Symbol.for()`. The global-registry version could be carried by any object
 * without importing this module; a local one cannot. It is NOT unforgeable — the symbol can still be lifted
 * off a real marker with `Object.getOwnPropertySymbols` and stamped on a hand-built object, which needs a
 * sink that bypasses `inFlight()` entirely.
 */
const IN_FLIGHT = Symbol('operations.effect.inFlight');

/** Is this sink return value an in-flight marker? Pure. */
export function isInFlightResult(value) {
  return !!value && typeof value === 'object' && value[IN_FLIGHT] === true;
}

/** Normalize a sinks map (plain object or `Map`) into a lookup fn. */
function sinkLookup(sinks) {
  if (sinks instanceof Map) return (type) => sinks.get(type);
  if (sinks && typeof sinks === 'object') return (type) => sinks[type];
  throw new TypeError('operations: `sinks` must be an object or a Map of effect type → async fn');
}

/** The step whose effects are being applied, refusing anything that is not actually waiting on effects. */
function targetStepIndex(run, stepIndex) {
  if (stepIndex != null) {
    if (!Number.isInteger(stepIndex) || stepIndex < 0) throw new TypeError(`operations: invalid stepIndex ${JSON.stringify(stepIndex)}`);
    return stepIndex;
  }
  if (!run.pending || run.pending.kind !== 'effect') {
    throw new Error(
      `operations: run ${run.id} is not suspended on an effect step (${run.pending ? `pending \`${run.pending.kind}\`` : 'nothing pending'}) — ` +
      'nothing to apply. Pass an explicit `stepIndex` only if you mean to replay a step the run has moved past.',
    );
  }
  return run.pending.stepIndex;
}

/** Replace one effect entry by key, returning a new run record. */
function withEntry(run, key, patch) {
  return { ...run, effects: run.effects.map((e) => (e.key === key ? { ...e, ...patch } : e)) };
}

/**
 * THE HANDLES A RETRIED DISPATCH LEAVES BEHIND — the entry's existing list, plus the handle it is about to
 * stop carrying. PURE.
 *
 * WHY THIS IS NOT BOOKKEEPING FOR ITS OWN SAKE (PR #1211 round 2, G2). Retrying a `dispatch: true` effect does
 * not re-run something harmless: it starts a SECOND agent. The pre-sink write blanks `handle` so the new
 * session's id can land there, and before this the old id was simply gone — the record then said one agent
 * existed where two did, and the first was unobservable (the observer only ever reads `handle`) and
 * uncloseable (`wake --resolve` resolves one entry, whose handle is now the other session's). An escape hatch
 * that destroys the evidence of what it escaped from is worse than no escape hatch.
 *
 * The list is EVIDENCE, not state: nothing decides on it. It is what an operator greps for when two agents are
 * in one lane clone and only one of them is on the books.
 *
 * @param {object} entry - the effect entry as it stands before the re-attempt.
 * @returns {Array<{handle: string, startedAt: (string|null), expectedBy: (string|null), supersededAt: string}>}
 */
export function supersededHandles(entry) {
  const kept = Array.isArray(entry?.supersededHandles) ? entry.supersededHandles : [];
  if (!isPollableHandle(entry?.handle)) return kept;
  return [...kept, {
    handle: String(entry.handle),
    startedAt: entry.startedAt ?? null,
    expectedBy: entry.expectedBy ?? null,
    supersededAt: new Date().toISOString(),
  }];
}

/**
 * APPLY THE EFFECTS a run has declared for its current (or a named) effect step.
 *
 * Persists the run record through `store` after EVERY status transition, so a crash at any point leaves a
 * record that says exactly what was attempted. Returns rather than throwing when a SINK fails — the run
 * simply stays suspended, which `advance` already refuses to move past. It THROWS only on structural
 * refusals: an unknown effect type, an indeterminate non-idempotent entry, or a run that is not waiting on
 * effects at all.
 *
 * @param {object} run - the run record.
 * @param {object} opts
 * @param {Record<string, Function>|Map<string, Function>} opts.sinks - effect type → `async (payload, ctx) => result`.
 * @param {{read: Function, write: Function}} opts.store - the run store handle (see `run-store.mjs`).
 * @param {number} [opts.stepIndex] - apply a specific step's effects instead of the pending one.
 * @param {'human'|'auto'|'unknown'} [opts.attemptedBy] - who re-entered. Recorded, never acted on.
 *
 *   DEFAULTS TO `unknown`, NOT `human` (PR #1195 review, blocking). The earlier default was justified by
 *   "every caller that existed before the waker was one", and that sentence was false the moment it was
 *   written: `driveRun` is also reached by the HTTP adapter, where the caller is a network client the
 *   adapter cannot identify. Every request-driven attempt was being filed as human.
 *
 *   There is no safe guess, so the third value is the honest one: `unknown` is excluded from BOTH
 *   populations rather than padding either. A thin dataset is recoverable; a mislabelled one is not.
 * @returns {Promise<{run: object, applied: string[], skipped: string[], halted: (object|null), error: (Error|null)}>}
 */
export async function applyPendingEffects(run, { sinks, store, stepIndex = null, attemptedBy = 'unknown' } = {}) {
  assertRunRecord(run, 'run record passed to applyPendingEffects');
  if (!store || typeof store.write !== 'function') {
    throw new TypeError('operations: applyPendingEffects needs a `store` handle — the record must be durable between effects');
  }
  const lookup = sinkLookup(sinks);
  const index = targetStepIndex(run, stepIndex);
  const entries = effectsForStep(run, index);

  // ── PRE-FLIGHT: refuse the whole batch before applying ANY of it ────────────────────────────────────────
  // Discovering an unknown type after effect 0 has landed is precisely the half-done state this exists to
  // prevent, so the checks run over the entire list first.
  for (const entry of entries) {
    if (entry.status === 'applied' || entry.status === 'refused') continue;
    // IN-FLIGHT IS RESUMABLE, NOT REFUSED — the one status a replay exists to continue from. Skipped BEFORE
    // the sink check on purpose: reporting "still going" needs no sink, because the sink's job was to START
    // the work and it did. Requiring one would strand genuinely-running work behind an unregistered type.
    //
    // UNLESS THE HANDLE IS LOST, which is the case the whole distinction rests on: in-flight is resumable
    // because it can be OBSERVED. A handle-less entry cannot be, so it has degraded back into "might have
    // started, cannot check" — the definition of `pending` — and falls under the same refusal.
    if (entry.status === 'in-flight' && isPollableHandle(entry.handle)) continue;
    if (entry.status === 'in-flight' && !entry.idempotent) {
      throw new Error(
        `operations: effect ${entry.key} (${entry.type}) was dispatched but has NO handle, so whether it is still running ` +
        'cannot be observed — it is indistinguishable from an unknown outcome. It is not declared idempotent, so ' +
        'restarting it could double-apply. Refusing. Find out what happened to it, then close it out with ' +
        `\`node scripts/operations/wake.mjs --resolve=${run.id} --key=${entry.key} --status=applied|failed\` ` +
        '(or `resolveInFlight(run, key, { status })` from a script) and re-run.',
      );
    }
    if (typeof lookup(entry.type) !== 'function') {
      throw new Error(
        `operations: no sink registered for effect type ${JSON.stringify(entry.type)} (run ${run.id}, step ${index}, ordinal ${entry.index}) — refusing to apply any of this step's effects.` +
        (entry.type === LEDGER_EFFECT_TYPE
          ? ` \`${LEDGER_EFFECT_TYPE}\` is the seam for the #3007 verdict ledger, which is still open and is NOT implemented by this executor; register a sink for it.`
          : ''),
      );
    }
    if (entry.status === 'pending' && !entry.idempotent) {
      const sink = lookup(entry.type);
      if (typeof sink.provablyNotApplied === 'function' && sink.provablyNotApplied(entry) === true) {
        run = withEntry(run, entry.key, { ...entry, status: 'failed' });
        store.write(run);
        continue;
      }
      throw new Error(
        `operations: effect ${entry.key} (${entry.type}) was attempted and its outcome is UNKNOWN — it is not declared ` +
        'idempotent, so replaying it could double-apply. Refusing. Resolve it by hand (mark the entry `applied` or ' +
        '`failed` on the run record) and re-run.',
      );
    }
  }

  const applied = [];
  const skipped = [];
  const inFlightKeys = [];
  let current = run;

  for (const entry of entries) {
    const live = current.effects.find((e) => e.key === entry.key);
    if (live.status === 'applied') { skipped.push(live.key); continue; }
    // Permanent refusals are settled facts. Preserve the halt for the engine to settle,
    // without requiring or invoking the sink again.
    if (live.status === 'refused') {
      return { run: current, applied, skipped, inFlight: inFlightKeys, halted: live,
        error: new Error(live.error || 'effect permanently refused') };
    }
    // Only an OBSERVABLE in-flight entry is reported and left alone. A handle-less one reached here because it
    // is idempotent, and falls through to be dispatched again — which is what `idempotent` licenses.
    if (live.status === 'in-flight' && isPollableHandle(live.handle)) {
      // Still going. Report and HALT — the same ordering rule a failure gets. Re-calling the sink would start
      // the work a SECOND time, which is the double-apply the `pending` refusal exists to prevent; here we can
      // avoid it outright because the entry says the first attempt is still alive. Something outside this
      // executor resolves the entry to `applied` or `failed` once the work reports back.
      inFlightKeys.push(live.key);
      return { run: current, applied, skipped, inFlight: inFlightKeys, halted: live, error: null };
    }

    // MARK THE ATTEMPT BEFORE MAKING IT, and persist. Which mark depends on what the declaration says the
    // effect IS, because the pre-sink write is the only one a crash cannot skip:
    //   - an ordinary effect gets `pending` — attempted, outcome unknown, refused on replay;
    //   - a DISPATCH gets `in-flight` with no handle yet. That does NOT make a crash here resumable — a
    //     handle-less entry is refused on replay exactly as `pending` is. What it buys is VISIBILITY: the
    //     crash lands in `inFlightEntries().unknown` and is closable through `resolveInFlight`, where a
    //     `pending` entry is invisible to both and can only be hand-edited. See the `inFlight` docblock.
    // COUNT THE ATTEMPT, and record WHO made it. This is instrumentation, not policy: nothing reads these to
    // decide anything, and #3083 — where retry gets a cap, a backoff and an owner — is unruled. They are here
    // now because they cannot be recovered later. The corpus held zero retry observations when this landed
    // (nothing dispatched yet — `dispatch-lane`, #3037, is the first), so every one that ever exists has been
    // accumulating from that point.
    //
    // `attemptedBy` separates two populations that a naive count conflates and that mean OPPOSITE things:
    // an AUTOMATIC retry succeeding says the failure was flaky and a small budget would have caught it; a
    // HUMAN retry succeeding usually says someone fixed the cause, and no budget would ever have helped.
    // Averaging them yields a default that is too high. One field, unrecoverable if omitted.
    // PER POPULATION, not one count plus a last-writer label (PR #1195 review, blocking 1). The first cut
    // kept a cumulative `attempts` and OVERWROTE `attemptedBy` on each attempt, so an effect retried by both
    // populations was filed wholly into whichever went last, carrying the other's attempts in its count.
    // Both directions corrupt the corpus:
    //   - human, human, then auto succeeds → filed as an automatic success at attempt 3. The truth is that
    //     exactly ONE automatic attempt was made and it worked first time. That is the pooled inflation this
    //     whole file exists to prevent.
    //   - auto, auto, then a human fixes the cause → filed as human, and TWO genuine automatic failures —
    //     evidence that a budget buys nothing — vanish from the automatic population entirely.
    // Counting each population separately means a mixed entry contributes honestly to both.
    const by = attemptedBy === 'auto' || attemptedBy === 'human' ? attemptedBy : 'unknown';
    // THE INVARIANT, so #3083's reader does not have to guess its own denominator: for any entry created at
    // or after this change, `attempts === autoAttempts + humanAttempts + unknownAttempts`. Every attempt
    // increments exactly one population, and `by` is always one of the three.
    //
    // It can only be violated by an entry that already carries `attempts` and no per-population fields —
    // reachable from an INTERMEDIATE build of this branch, which wrote a cumulative `attempts` plus a
    // last-writer `attemptedBy`, and whose records survive locally because `.operations/` is gitignored.
    // On a record written before any of this the four are all absent, all start at 0 together, and nothing
    // is misfiled. The old `attemptedBy` key is dropped rather than left beside `lastAttemptBy`, so such a
    // record cannot present two answers to the same question.
    const attempted = {
      attempts: (Number(live.attempts) || 0) + 1,
      autoAttempts: (Number(live.autoAttempts) || 0) + (by === 'auto' ? 1 : 0),
      humanAttempts: (Number(live.humanAttempts) || 0) + (by === 'human' ? 1 : 0),
      unknownAttempts: (Number(live.unknownAttempts) || 0) + (by === 'unknown' ? 1 : 0),
      lastAttemptAt: new Date().toISOString(),
      // NAMED for what it is. `attemptedBy` read as "who attempted this", which is false for a mixed entry;
      // it has only ever meant who attempted it LAST, and the last attempt is the one whose outcome settled.
      lastAttemptBy: by,
      attemptedBy: undefined,
    };
    current = live.dispatch
      ? withEntry(current, live.key, {
        ...attempted,
        status: 'in-flight',
        // THE HANDLE THE PREVIOUS ATTEMPT MINTED IS KEPT, not overwritten into oblivion (PR #1211 round 2,
        // G2). A dispatch retry starts a NEW session with a NEW id, and this line used to blank `handle`
        // before the sink ran — so after one retry the FIRST agent's handle existed nowhere on the record.
        // Neither the observer nor `wake --resolve` could reach it again: a live agent orphaned by the very
        // act of retrying, with only one of the two on the books. See {@link supersededHandles}.
        supersededHandles: supersededHandles(live),
        handle: null,
        startedAt: new Date().toISOString(),
        expectedBy: null,
        error: null,
      })
      : withEntry(current, live.key, { ...attempted, status: 'pending', error: null });
    store.write(current);

    try {
      const result = await lookup(live.type)(live.payload, {
        key: live.key, runId: current.id, type: live.type, stepIndex: live.stepIndex, step: live.step, index: live.index,
        // A read-only handle on THIS executor's store, so a sink that recovers from the run record reads the
        // record this executor writes, never a store it chose on its own (#6661).
        readRun: (id) => store.read(id),
      });
      if (isInFlightResult(result)) {
        if (!live.dispatch) {
          throw new Error(
            `operations: sink for ${live.key} (${live.type}) returned an in-flight marker, but the effect was not declared ` +
            '`dispatch: true`. The declaration has to say so BEFORE the sink runs — otherwise a crash mid-dispatch records ' +
            'running work as an unknown outcome. Refusing.',
          );
        }
        // Re-read after the sink: a fast child can already have settled this effect. Never replace
        // that terminal fact (or another entry's fresh state) with the parent's pre-spawn snapshot.
        current = store.read(current.id);
        const fresh = current.effects.find((entry) => entry.key === live.key);
        if (fresh?.status === 'in-flight') {
          current = withEntry(current, live.key, { handle: result.handle, expectedBy: result.expectedBy,
            ...(result.dispatch === undefined ? {} : { dispatch: result.dispatch }) });
          store.write(current);
          inFlightKeys.push(live.key);
        }
        // A child failure must halt the driver too, otherwise it can retry this failed effect immediately.
        const settled = current.effects.find((entry) => entry.key === live.key);
        if (settled?.status === 'applied') applied.push(live.key);
        return { run: current, applied, skipped, inFlight: inFlightKeys, halted: settled,
          error: settled?.status === 'failed' ? new Error(settled.error || 'dispatch child failed') : null };
      }
      // A dispatch sink that returns an ordinary value finished synchronously after all. Recording `applied`
      // supersedes the pre-sink `in-flight` and is honest: the work is done, so there is nothing to observe.
      current = withEntry(current, live.key, { status: 'applied', result: result === undefined ? null : result, error: null });
      store.write(current);
      applied.push(live.key);
    } catch (e) {
      const certainlyNotApplied = e && e.notApplied === true;
      // A dispatch that threw WITHOUT saying "nothing started" stays `in-flight` with a null handle — started,
      // unobservable. `inFlightEntries` reports that as `unknown` and the replay guard refuses it, so it is
      // never mistaken for healthy running work.
      const indeterminate = live.dispatch ? 'in-flight' : 'pending';
      current = withEntry(current, live.key, {
        status: isPermanentGuardRefusal(e) ? 'refused' : certainlyNotApplied ? 'failed' : indeterminate,
        error: String(e?.message ?? e),
      });
      store.write(current);
      // HALT. Effect N+1 is never attempted while N has not landed — guarantee 1 in the header.
      return { run: current, applied, skipped, inFlight: inFlightKeys, halted: current.effects.find((x) => x.key === live.key), error: e };
    }
  }

  return { run: current, applied, skipped, inFlight: inFlightKeys, halted: null, error: null };
}

/**
 * Resolve an `in-flight` entry once the work it started reports back (#3073) — the only supported way out of
 * that status. #3070's waker is the first caller, and it also exposes the operator's surface:
 * `node scripts/operations/wake.mjs --resolve=<runId> --key=<effectKey> --status=applied|failed`
 * (`we:scripts/operations/wake.mjs#closeOutEntry`). No HTTP route reaches it.
 *
 * REFUSES on any other status. Resolving an entry that is `pending` would be a guess about an unknown outcome,
 * which is exactly what the replay guard refuses; resolving one that is `applied` would rewrite a settled fact.
 *
 * @param {object} run
 * @param {string} key - the effect key.
 * @param {{status: 'applied'|'failed', result?: any, error?: string}} outcome
 * @returns {object} the new run record — the caller persists it.
 */
export function resolveInFlight(run, key, { status, result = null, error = null } = {}) {
  assertRunRecord(run, 'run record passed to resolveInFlight');
  if (status !== 'applied' && status !== 'failed') {
    throw new TypeError(`operations: resolveInFlight needs a terminal status (\`applied\` or \`failed\`), got ${JSON.stringify(status)}`);
  }
  const entry = (run.effects || []).find((e) => e.key === key);
  if (!entry) throw new Error(`operations: run ${run.id} has no effect ${JSON.stringify(key)}`);
  if (entry.status !== 'in-flight') {
    throw new Error(
      `operations: effect ${key} is \`${entry.status}\`, not \`in-flight\` — refusing to resolve it. ` +
      'Only work that was started deliberately and reported back can be resolved this way.',
    );
  }
  return withEntry(run, key, { status, result, error: error == null ? null : String(error) });
}

/**
 * Every `in-flight` entry on a run, split into the three things an observer has to tell apart (#3073).
 *
 *   - `running` — observable and inside its deadline. Leave it alone.
 *   - `overdue` — observable, but `expectedBy` has passed. Go look at it. An entry with NO `expectedBy` is
 *     never overdue however old it is: unbounded work is honestly unbounded, and inventing a deadline for it
 *     would turn every long job into a false alarm.
 *   - `unknown` — no handle, so whether it is running cannot be checked at all. This is the degradation the
 *     item calls out: a dispatch that loses its handle must NOT keep reading as "still running" forever. It is
 *     back to being an unknown outcome, and the replay guard refuses it for the same reason it refuses
 *     `pending`.
 *
 * @param {object} run
 * @param {string|Date} [now] - the instant to compare against; injected so this stays pure.
 * @returns {{running: object[], overdue: object[], unknown: object[]}}
 */
export function inFlightEntries(run, now = new Date()) {
  const at = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (Number.isNaN(at)) throw new TypeError('operations: inFlightEntries needs a valid instant');
  const running = [];
  const overdue = [];
  const unknown = [];
  for (const e of (run && run.effects) || []) {
    if (e.status !== 'in-flight') continue;
    // THE SAME QUESTION THE VALIDATOR ASKS, not a bare truthiness (PR #1191 review, finding 2). This is the
    // function the item named as the failure site, and it was the one place still asking differently — so a
    // handle the validator refuses still bucketed `running` when a record reached here another way.
    if (!isPollableHandle(e.handle)) { unknown.push(e); continue; }
    const due = e.expectedBy ? Date.parse(e.expectedBy) : NaN;
    (!Number.isNaN(due) && due < at ? overdue : running).push(e);
  }
  return { running, overdue, unknown };
}

/**
 * Bind sinks and a store once, so an adapter calls `executor.apply(run)`. Nothing more than a closure over
 * {@link applyPendingEffects}.
 *
 * @param {{sinks: (Record<string, Function>|Map<string, Function>), store: object}} config
 */
export function createEffectExecutor({ sinks, store } = {}) {
  sinkLookup(sinks); // fail at construction, not at the first apply.
  if (!store || typeof store.write !== 'function') {
    throw new TypeError('operations: createEffectExecutor needs a `store` handle');
  }
  return {
    // `attemptedBy` is forwarded, not dropped. A destructure that omitted the field accepted a caller's
    // stated population and silently recorded `unknown` instead.
    //
    // SCOPE, STATED HONESTLY (PR #1195 round 6, blocking 2): this closure has NO production caller. All
    // three real entry points — the CLI, the HTTP adapter and the waker — call `applyPendingEffects`
    // directly, so nothing in production ever had an argument eaten here. An earlier version of this
    // comment called it "the one production path that reaches applyPendingEffects", which was false and
    // was the same defect this item keeps bouncing on: a statement about one population (test callers)
    // used to describe another (production callers). The fix is still right — the façade is offered to
    // adapters and would mislabel the moment one used it, and mislabelled retry data cannot be recovered
    // — but it guards a surface nothing production reaches today.
    apply: (run, { stepIndex = null, attemptedBy = 'unknown' } = {}) => applyPendingEffects(run, { sinks, store, stepIndex, attemptedBy }),
    types: () => (sinks instanceof Map ? [...sinks.keys()] : Object.keys(sinks)).sort(),
  };
}
