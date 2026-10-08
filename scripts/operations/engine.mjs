/**
 * @file scripts/operations/engine.mjs
 * @description THE RUN ENGINE — `startRun` and `advance` (#3032, under epic #3029).
 *
 * ONE CALL, ONE STEP. `advance(run)` steps the machine exactly once and returns the NEXT run record. It
 * never mutates the record it was given, never loops, and — the load-bearing property — **never performs
 * io**. This file, {@link ./registry.mjs}, {@link ./step-kinds.mjs} and {@link ./run-record.mjs} import
 * nothing from `node:` at all, and `__tests__/engine.test.mjs` asserts that over the whole import graph. So
 * "a `judge` step declares a judgement and does not spawn one" and "an `effect` step declares effects and
 * applies none" are not conventions the model has to hold: the engine has no way to do either.
 *
 * THREE KINDS SUSPEND, ONE DOES NOT. Everything that needs the world outside the engine — a model, a
 * person, a write — is expressed as a SUSPEND plus a RESUME, and the impure work happens in the caller
 * BETWEEN two `advance` calls:
 *
 *   | kind      | `advance` does                                   | the caller then                            |
 *   |-----------|--------------------------------------------------|--------------------------------------------|
 *   | `compute` | calls the pure fn, stores the finding, moves on   | nothing — no suspend                       |
 *   | `judge`   | suspends with `{ mandate, input, shape, … }`      | runs `judgeSpawn` (#3028), resumes with it |
 *   |           | …and records `resume.telemetry` as what it cost   | (the spawn's cost exists only out there)   |
 *   | `confirm` | suspends recording WHAT is asked and OF WHOM      | asks a person, resumes with the decision   |
 *   | `effect`  | suspends with the declared effects, keyed         | runs the executor, then calls `advance`    |
 *
 * The statute (#operations-declared-once-callers-generated, #3031) only names `confirm` as the suspend,
 * because that is the one whose absence was a defect (the human stop being prose in
 * `we:skills-src/review/SKILL.md`). Making `judge` and `effect` suspend the same way is this slice's
 * choice, and it buys one mechanism instead of three: a run in ANY waiting state is a record on disk with a
 * `pending` field, resumable from any surface by the same call.
 *
 * A SUSPEND NAMES THE SKILL THAT OWNS THE REST OF THE RUN (#3316). Every `pending` above carries the
 * declaration's `ownedBy` pointer when it declares one, so a caller holding a suspended run can find the
 * process it is standing one stop inside without already knowing that process exists. See {@link pendingOn}
 * for the failure that bought this and for why a declaration naming no skill still produces the identical
 * record it always did.
 *
 * DECLARED READS ARE ENFORCED, NOT DOCUMENTED. A step fn is handed a frozen view containing ONLY the paths
 * its declaration listed. Reading something undeclared is not discouraged — it is absent.
 *
 * FAIL CLOSED, EVERYWHERE. An invalid record, an unknown operation, a declaration that changed under a
 * suspended run, an unknown step kind, a resume for the wrong step, a `confirm` answer outside its declared
 * options, an `effect` step whose effects are not all applied — every one of these REFUSES. The repo has
 * been bitten repeatedly by gates that fail open (`we:scripts/lib/lane-verify.mjs`, #2833, is the local
 * precedent for refusing rather than proceeding on something unreadable).
 *
 * PURE. No fs, no clock, no process, no randomness, no network.
 */

import { defaultRegistry, validateInput } from './registry.mjs';
import { assertRunRecord, effectKey, newRunRecord, normalizeJudgeTelemetry } from './run-record.mjs';

/** Every state a run can be in. Derived from the record; never stored, so it cannot go stale. */
export const RUN_STATUSES = Object.freeze(['running', 'awaiting-judge', 'awaiting-confirm', 'awaiting-effect', 'complete']);

/** @param {*} v @returns {boolean} */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Structured-clone a JSON value so a stored finding can never alias a caller's mutable object. */
function frozenCopy(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolve the declaration a run record names, refusing anything that would let the run step on a shape it
 * did not start with.
 * @param {object} run
 * @param {object} registry
 * @returns {object} the declaration.
 */
function declarationFor(run, registry) {
  const declaration = registry.get(run.op); // throws on an unknown operation — fail closed.
  if (run.cursor > declaration.steps.length) {
    throw new Error(
      `operations: run ${run.id} has cursor ${run.cursor} but \`${declaration.name}\` declares only ` +
      `${declaration.steps.length} step(s) — the declaration changed under a live run; refusing to step it.`,
    );
  }
  if (run.pending) {
    const at = declaration.steps[run.pending.stepIndex];
    if (!at || at.name !== run.pending.step) {
      throw new Error(
        `operations: run ${run.id} is suspended at step ${run.pending.stepIndex} (\`${run.pending.step}\`) but ` +
        `\`${declaration.name}\` now has ${at ? `\`${at.name}\`` : 'no step'} there — the declaration changed under a ` +
        'suspended run; refusing to resume it.',
      );
    }
  }
  return declaration;
}

/**
 * The view a step fn receives: ONLY its declared reads, deep-frozen. An undeclared path is absent, so the
 * declaration is the actual boundary rather than a description of one.
 *
 * @param {object} run
 * @param {readonly string[]} reads
 * @returns {Readonly<object>}
 */
export function projectReads(run, reads = []) {
  const view = {};
  for (const path of reads) {
    const [root, leaf] = path.split('.');
    if (root === 'verdict') {
      view.verdict = frozenCopy(run.verdict) ?? null;
    } else if (root === 'input') {
      if (leaf === undefined) view.input = frozenCopy(run.input);
      else {
        view.input = view.input && typeof view.input === 'object' ? view.input : {};
        view.input[leaf] = frozenCopy(run.input?.[leaf]);
      }
    } else if (root === 'findings') {
      view.findings = view.findings && typeof view.findings === 'object' ? view.findings : {};
      view.findings[leaf] = frozenCopy(run.findings?.[leaf]);
    }
  }
  if (view.input) Object.freeze(view.input);
  if (view.findings) Object.freeze(view.findings);
  return Object.freeze(view);
}

/**
 * Begin a run. Validates the input against the declaration and refuses on ANY error — a missing required
 * field and an unknown extra field are both refusals, so nothing reaches a run that the declaration did not
 * accept.
 *
 * @param {object} spec
 * @param {string} spec.op - the declared operation's name.
 * @param {string} spec.id - the run id (the io shell's `newRunId` mints one; injected so this stays pure).
 * @param {object} [spec.input]
 * @param {object} [spec.registry]
 * @returns {object} a fresh run record at cursor 0.
 */
export function startRun({ op, id, input = {}, registry = defaultRegistry } = {}) {
  const declaration = registry.get(op); // throws on unknown — fail closed.
  const validated = validateInput(declaration.input, input);
  if (!validated.ok) {
    throw new Error(`operations: cannot start \`${declaration.name}\` — ${validated.errors.join('; ')}`);
  }
  return newRunRecord({ id, op: declaration.name, input: validated.value });
}

/**
 * What a run is waiting on. Derived, never stored.
 * @param {object} run
 * @param {{registry?: object}} [options]
 * @returns {'running'|'awaiting-judge'|'awaiting-confirm'|'awaiting-effect'|'complete'}
 */
export function runStatus(run, { registry = defaultRegistry } = {}) {
  assertRunRecord(run);
  const declaration = declarationFor(run, registry);
  if (run.pending) return `awaiting-${run.pending.kind}`;
  return run.cursor >= declaration.steps.length ? 'complete' : 'running';
}

/** Has the run finished every declared step? */
export function isComplete(run, { registry = defaultRegistry } = {}) {
  return runStatus(run, { registry }) === 'complete';
}

/** The effect entries a run declared for one step, in declared order. */
export function effectsForStep(run, stepIndex) {
  return (run.effects ?? []).filter((e) => e.stepIndex === stepIndex).sort((a, b) => a.index - b.index);
}

/**
 * Effect entries that are declared/pending/in-flight/failed — everything still standing between here and done.
 *
 * `in-flight` counts as unapplied ON PURPOSE (#3073): the sink returned, but the work it STARTED has not
 * finished, so the run must stay suspended on this step. Treating a dispatch as applied would advance the run
 * past work still in progress, which is the whole reason the status exists.
 */
export function unappliedEffects(run, stepIndex = null) {
  return (run.effects ?? [])
    .filter((e) => (stepIndex === null || e.stepIndex === stepIndex) && e.status !== 'applied')
    .sort((a, b) => (a.stepIndex - b.stepIndex) || (a.index - b.index));
}

/**
 * WHAT AN EFFECT STEP RECORDS (#3082) — the finding a later step reads through `reads: ['findings.<step>']`.
 *
 * Keyed by ORDINAL, not by type. A step may declare the same type twice ("post two comments"), so a
 * type-keyed shape would silently drop one and lie about which result a reader is looking at. The ordinal is
 * already the identity the executor keys on, and it is stable across a replay.
 *
 * Each entry carries only what a reader can act on: whether it landed, what it returned, and why not if it
 * did not. The rest of the run-record entry — the payload, the idempotency flag, the handle — is bookkeeping
 * for the executor, and a later step reading it would be reaching around the model rather than through it.
 */
function effectFinding(run, stepIndex) {
  const entries = (run.effects ?? []).filter((e) => e.stepIndex === stepIndex).sort((a, b) => a.index - b.index);
  return {
    applied: entries.every((e) => e.status === 'applied'),
    effects: entries.map((e) => ({
      type: e.type,
      status: e.status,
      result: e.result ?? null,
      error: e.error ?? null,
    })),
  };
}

/**
 * BUILD A `pending` ENTRY, NAMING THE SKILL THAT OWNS THE REST OF THE RUN (#3316).
 *
 * THE DEFECT THIS CLOSES. A suspended run already recorded everything about ITSELF — which step, which kind,
 * what is asked, of whom, and the `--resume` line that answers it — and nothing about the PROCESS it is one
 * stop inside. So a caller who invoked `review-pr` bare hit its `confirm`, had no idea what the two routes
 * forward were, and escalated to a human while `we:skills-src/review/SKILL.md` documented both the whole time.
 * The engine suspended correctly. The record was a dead end for anyone who had not already read the skill.
 *
 * GENERIC, NOT PER-OPERATION. This file knows nothing about reviewing a PR and must not start: the pointer is
 * read off `declaration.ownedBy`, which `op()` validated at registration, so every operation gets the same
 * behaviour from one line and none of them gets a special case.
 *
 * ABSENT, NOT NULL, WHEN NOTHING IS DECLARED. `ownedBy` is optional — most operations own no skill — and a
 * declaration that names none produces a `pending` that is byte-identical to the one it produced before this
 * field existed. That is deliberate: a required field, or an always-present `ownedBy: null`, would have made
 * every other operation's record change shape to serve one operation's need.
 *
 * @param {object} declaration
 * @param {object} fields - the kind-specific `pending` fields.
 * @returns {object}
 */
function pendingOn(declaration, fields) {
  return declaration.ownedBy ? { ...fields, ownedBy: declaration.ownedBy } : fields;
}

/** Record a step's result: its finding, and the run verdict when the declaration says this step sets it. */
function withFinding(run, declaration, stepName, value) {
  const findings = { ...run.findings, [stepName]: frozenCopy(value) ?? null };
  const verdict = declaration.verdictFrom === stepName ? (frozenCopy(value) ?? null) : run.verdict;
  return { ...run, findings, verdict };
}

/** Turn one declared effect descriptor into a run-record entry. Refuses a malformed descriptor. */
function toEffectEntry(run, declaration, stepIndex, stepName, descriptor, index) {
  if (!isPlainObject(descriptor)) {
    throw new Error(`operations: \`${declaration.name}\`.\`${stepName}\` declared effect #${index} that is not an object`);
  }
  if (typeof descriptor.type !== 'string' || !descriptor.type.trim()) {
    throw new Error(`operations: \`${declaration.name}\`.\`${stepName}\` declared effect #${index} with no \`type\``);
  }
  return {
    key: effectKey(run.id, stepIndex, index),
    stepIndex,
    step: stepName,
    index,
    type: descriptor.type.trim(),
    payload: frozenCopy(descriptor.payload) ?? null,
    idempotent: descriptor.idempotent === true,
    // DECLARED, not inferred (#3073). A dispatch effect STARTS work rather than completing it, and the
    // executor has to know that BEFORE it calls the sink: it writes `in-flight` first, so a crash between
    // the dispatch and the write cannot leave running work recorded as an unknown outcome. Learning it from
    // the sink's return value would reintroduce exactly that window.
    dispatch: descriptor.dispatch === true,
    status: 'declared',
    result: null,
    error: null,
  };
}

/**
 * Resolve a suspended run with the caller's `resume`, or leave it suspended when there is nothing to
 * resolve it with.
 */
function resolvePending(run, declaration, resume) {
  const { kind, step: stepName, stepIndex } = run.pending;
  const { step } = declaration.steps[stepIndex];

  if (kind === 'effect') {
    if (resume != null) {
      throw new Error(
        `operations: run ${run.id} is suspended on the \`${stepName}\` EFFECT step — it is resolved by applying its ` +
        'effects through the executor, never by a resume value. Run `applyPendingEffects` and call `advance` again.',
      );
    }
    const outstanding = unappliedEffects(run, stepIndex);
    if (outstanding.length > 0) {
      return run; // still waiting — idempotent no-op, exactly like a judge with no answer yet.
    }
    // THE STEP RECORDS WHAT IT PRODUCED, like every other kind (#3082). Before this an effect step was the
    // one kind that wrote no finding, so nothing downstream could see what an effect returned — a failing
    // build advanced the run past the step that existed to react to it, and the human was asked "Land it?".
    return { ...withFinding(run, declaration, stepName, effectFinding(run, stepIndex)), pending: null, cursor: stepIndex + 1 };
  }

  if (resume == null) return run; // nothing to resume with — the run stays suspended. `advance` is idempotent.
  if (!isPlainObject(resume)) {
    throw new Error(`operations: \`resume\` must be an object like { value } — got ${typeof resume}`);
  }
  if (resume.step !== undefined && resume.step !== stepName) {
    throw new Error(
      `operations: refusing a resume addressed to \`${resume.step}\` — run ${run.id} is suspended at \`${stepName}\`.`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(resume, 'value')) {
    throw new Error(`operations: a resume for the \`${stepName}\` ${kind} step must carry a \`value\``);
  }
  if (kind === 'confirm' && step.options && !step.options.includes(resume.value)) {
    throw new Error(
      `operations: \`${stepName}\` accepts only ${step.options.map((o) => JSON.stringify(o)).join(' | ')} — ` +
      `refusing ${JSON.stringify(resume.value)}.`,
    );
  }

  const next = withFinding(run, declaration, stepName, resume.value);
  return { ...withTelemetry(next, kind, stepName, stepIndex, resume), pending: null, cursor: stepIndex + 1 };
}

/**
 * RECORD WHAT THE SPAWN COST, on the resume that carries the answer.
 *
 * A `judge` step DECLARES the juror call and never makes it — the spawn happens in the caller, between two
 * `advance` calls (see the `judge` case above). So the cost, the wall time and the session id exist ONLY in the
 * adapter, and the resume is the one seam they can travel back through. Everything about them is data: the
 * engine stays pure, and {@link ./run-record.mjs#normalizeJudgeTelemetry} whitelists what may land.
 *
 * REFUSED on a `confirm` resume: a person answering a question spends no jurors, so `telemetry` there is a
 * caller confusion, and silently dropping it would make a lost cost figure look like a free run.
 *
 * `lens` and `effort` on the row come from the REQUEST the engine itself suspended with, never from the
 * adapter's copy — the row stays attributable to the declared call even if the caller reports nonsense. Only
 * `model` accepts a reported value, and ONLY as an override of the declared one (#3151): `--model` on the
 * command line means the spawn can legitimately differ from the declaration, and a row that reported the
 * declared model about a run judged by another one would be a false record. The asymmetry is deliberate and is
 * exactly as wide as the divergence: `effort` has no flag, and `lens` is a declaration INPUT field, so for both
 * the request already IS the truth. Widening this to all three would let any injected judge — the HTTP adapter
 * takes one as a dependency — stamp a run record with a lens the declaration never asked for.
 */
function withTelemetry(run, kind, stepName, stepIndex, resume) {
  if (resume.telemetry === undefined || resume.telemetry === null) return run;
  if (kind !== 'judge') {
    throw new Error(
      `operations: run ${run.id} — a \`${kind}\` resume carries no juror telemetry (only a \`judge\` step spawns one). `
      + `Refusing the resume for \`${stepName}\` rather than recording a cost nothing incurred.`,
    );
  }
  const request = run.pending?.request ?? {};
  const reported = isPlainObject(resume.telemetry) ? resume.telemetry : {};
  const row = normalizeJudgeTelemetry({
    step: stepName,
    stepIndex,
    telemetry: {
      ...reported,
      // WHICH MODEL RAN BEATS WHICH WAS ASKED FOR (#3151) — and ONLY the model. `model` was read off `request`
      // unconditionally, which was indistinguishable from the truth while it was a declared literal and became
      // a false record the moment `--model` let an operator override it: the row would say `sonnet` about a run
      // judged by `opus`. `lens` and `effort` stay declaration-authoritative, because nothing can make them
      // diverge (no flag for `effort`; `lens` is an input field) and because a caller-supplied `lens` would
      // reach `renderSpendLines` and the `--json` payload as a label the declaration never asked for.
      // `||`, not `??`: a reported empty string is not a model, and it must fall back rather than shadow the
      // declared one into a row that then records no model at all.
      lens: request.lens,
      model: reported.model || request.model,
      effort: request.effort,
    },
  });
  return { ...run, telemetry: [...(run.telemetry ?? []), row] };
}

/**
 * STEP THE MACHINE ONCE.
 *
 * Returns a NEW run record; the input record is never mutated. Calling it on a run that is complete, or on
 * a suspended run with nothing to resume it with, returns the record unchanged — `advance` is idempotent,
 * which is what makes a polling adapter safe.
 *
 * @param {object} run - the run record.
 * @param {object} [options]
 * @param {object} [options.registry] - where `run.op` is looked up. Defaults to the process-wide registry.
 * @param {{value?: *, step?: string}|null} [options.resume] - the judge answer or the person's decision.
 * @returns {object} the next run record.
 */
export function advance(run, { registry = defaultRegistry, resume = null } = {}) {
  assertRunRecord(run, 'run record passed to advance');
  const declaration = declarationFor(run, registry);

  if (run.pending) return resolvePending(run, declaration, resume);

  if (resume != null) {
    throw new Error(`operations: run ${run.id} is not suspended — refusing a resume for a run that is not waiting on anything.`);
  }
  if (run.cursor >= declaration.steps.length) return run; // complete — idempotent no-op.

  const { name: stepName, index: stepIndex, step } = declaration.steps[run.cursor];
  const view = projectReads(run, step.reads);

  switch (step.kind) {
    case 'compute': {
      const value = step.fn(view);
      return { ...withFinding(run, declaration, stepName, value), cursor: stepIndex + 1 };
    }

    case 'judge': {
      // DECLARES the juror call; does not make it. The request is `judgeSpawn`'s option shape (#3028) and
      // the caller does the spawn between this `advance` and the next.
      const request = step.request(view);
      if (!isPlainObject(request) || typeof request.mandate !== 'string' || !request.mandate.trim()) {
        throw new Error(`operations: \`${declaration.name}\`.\`${stepName}\` must return { mandate, input, shape } — no mandate found`);
      }
      if (typeof request.input !== 'string' || !request.input.trim()) {
        throw new Error(`operations: \`${declaration.name}\`.\`${stepName}\` must return a non-empty string \`input\` to judge`);
      }
      if (!isPlainObject(request.shape)) {
        throw new Error(`operations: \`${declaration.name}\`.\`${stepName}\` must return a JSON Schema object as \`shape\``);
      }
      return {
        ...run,
        pending: pendingOn(declaration, {
          kind: 'judge',
          step: stepName,
          stepIndex,
          request: { ...frozenCopy({ ...request, runId: run.id, lens: request.lens ?? stepName }) },
        }),
      };
    }

    case 'confirm': {
      // The human stop, as machinery rather than prose: WHAT is asked, and OF WHOM, recorded on the record.
      const asks = typeof step.asks === 'function' ? step.asks(view) : step.asks;
      if (typeof asks !== 'string' || !asks.trim()) {
        throw new Error(`operations: \`${declaration.name}\`.\`${stepName}\` produced an empty question`);
      }
      // WHO is asked can depend on the run, not only on the declaration (#3035: `human` on a gate-self PR,
      // `agent` otherwise). Evaluated over the SAME projected view as `asks`, and refused when empty — a record
      // that says the decision is owed by "" is worse than a refusal.
      const of = typeof step.of === 'function' ? step.of(view) : step.of;
      if (typeof of !== 'string' || !of.trim()) {
        throw new Error(`operations: \`${declaration.name}\`.\`${stepName}\` produced an empty \`of\` — WHO is being asked`);
      }
      return {
        ...run,
        pending: pendingOn(declaration, {
          kind: 'confirm', step: stepName, stepIndex, asks, of, options: step.options ? [...step.options] : null,
        }),
      };
    }

    case 'effect': {
      // DECLARES effects; applies none. The executor is the only thing that touches the world.
      const declared = step.effects(view);
      if (!Array.isArray(declared)) {
        throw new Error(`operations: \`${declaration.name}\`.\`${stepName}\` must return an ARRAY of declared effects`);
      }
      const already = new Set(effectsForStep(run, stepIndex).map((e) => e.key));
      const entries = declared
        .map((d, i) => toEffectEntry(run, declaration, stepIndex, stepName, d, i))
        .filter((e) => !already.has(e.key));
      const effects = [...(run.effects ?? []), ...entries];
      const next = {
        ...run,
        effects,
        pending: pendingOn(declaration, { kind: 'effect', step: stepName, stepIndex, count: declared.length }),
      };
      // Zero declared effects is a legitimate outcome (nothing to do) — resolve it in the same call rather
      // than suspending on an empty list the executor would have nothing to apply.
      return unappliedEffects(next, stepIndex).length === 0
        ? { ...withFinding(next, declaration, stepName, effectFinding(next, stepIndex)), pending: null, cursor: stepIndex + 1 }
        : next;
    }

    default:
      // Unreachable through `op()`, which refuses a fifth kind at registration. Kept as a refusal rather
      // than a fallthrough so a hand-built declaration cannot make the engine improvise.
      throw new Error(
        `operations: \`${declaration.name}\`.\`${stepName}\` has unknown step kind ${JSON.stringify(step.kind)} — ` +
        'the vocabulary is closed at compute|judge|confirm|effect.',
      );
  }
}

/**
 * REWIND A RUN TO A NAMED STEP, KEEPING EVERYTHING BEFORE IT. PURE.
 *
 * The one operation a "resume the paused review" needs (card xq1xbsl): a review that parked on mandatory referrals
 * has already paid for its panel; when the operator rules, the run goes back to the step that reads the rulings,
 * not to the start. Findings, effects, timings and the verdict of that step and every later step are dropped, so they
 * are produced again from the (unchanged) earlier findings. `resumedAt` is stamped so a reader of the run can tell
 * the resume from the original pass.
 *
 * Refuses a step the declaration does not have, or a run whose cursor has not reached it (nothing to rewind).
 * @param {object} run
 * @param {{registry?: object, step: string, at?: string}} o
 * @returns {object} a new run record at `step`, not suspended.
 */
export function rewindRunToStep(run, { registry = defaultRegistry, step, at = null } = {}) {
  assertRunRecord(run, 'run record passed to rewindRunToStep');
  const declaration = declarationFor(run, registry);
  const target = declaration.steps.find((s) => s.name === step);
  if (!target) throw new Error(`operations: \`${declaration.name}\` has no step \`${step}\` to rewind run ${run.id} to.`);
  const index = target.index;
  const drop = new Set(declaration.steps.filter((s) => s.index >= index).map((s) => s.name));
  if (run.cursor < index && !(run.pending && run.pending.stepIndex >= index)) {
    throw new Error(`operations: run ${run.id} has not reached \`${step}\` (cursor ${run.cursor}); nothing to rewind.`);
  }
  const findings = Object.fromEntries(Object.entries(run.findings ?? {}).filter(([name]) => !drop.has(name)));
  return {
    ...run,
    cursor: index,
    pending: null,
    findings,
    verdict: null,
    effects: (run.effects ?? []).filter((e) => e.stepIndex < index),
    stepTimings: (run.stepTimings ?? []).filter((t) => t.stepIndex < index),
    ...(at ? { resumedAt: at } : {}),
  };
}

/**
 * Convenience for the deterministic stretch of a run: keep calling {@link advance} while it keeps making
 * progress, and stop the moment it suspends or completes. Still performs no io — it just saves an adapter
 * from writing the same three-line loop.
 *
 * @param {object} run
 * @param {{registry?: object, resume?: object|null, maxSteps?: number}} [options]
 * @returns {object} the run record at its next suspend or completion.
 */
export function advanceWhileRunning(run, { registry = defaultRegistry, resume = null, maxSteps = 1000 } = {}) {
  let current = advance(run, { registry, resume });
  for (let i = 0; i < maxSteps; i += 1) {
    if (runStatus(current, { registry }) !== 'running') return current;
    const next = advance(current, { registry });
    if (next === current) return current;
    current = next;
  }
  throw new Error(`operations: run ${run.id} did not settle within ${maxSteps} steps — refusing to loop further.`);
}
