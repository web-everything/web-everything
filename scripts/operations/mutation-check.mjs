/**
 * @file scripts/operations/mutation-check.mjs
 * @description THE `mutation-check` DECLARATION (#x4omld5, under epic #3029) — does this guard actually FAIL
 *   when the bug it names comes back?
 *
 * THE DEFECT IT EXISTS FOR IS A TEST THAT CANNOT FAIL. A green suite is evidence that the code passes the
 * tests; it is NOT evidence that the tests would catch the defect. Four vacuous guards reached a paid juror
 * in a single stretch of work on 2026-08-20/21, each subtler than the last:
 *
 *   1. a guard that `return`ed early when the corpus held no hash ids — asserted nothing, silently;
 *   2. a fix applied to the node sort while the edge sort kept the bug, in the same file;
 *   3. a guard that re-sorted the live corpus with a comparator the TEST built — tautological, and in
 *      agreement with the broken implementation on any day the corpus lacked the triggering shape;
 *   4. `stubReader({ state: undefined })` hitting a destructuring default and coming back `'OPEN'`, so the
 *      "missing state is refused" case tested the "state is OPEN" case instead.
 *
 * Every one was caught by a juror reading the test, at juror prices, after the fact. Every one was provable
 * mechanically in seconds: put the bug back, and see whether anything goes red.
 *
 * WHY IT IS AN OPERATION AND NOT A HABIT. That procedure was run by hand a dozen times in that same stretch —
 * ad-hoc `python` heredocs patching a file, running vitest, restoring from a `/tmp` copy. It left no record,
 * it was re-derived every time, and a heredoc that fails between mutate and restore leaves the mutant in the
 * working tree. Declared, it gets its argv and its HTTP route for free (#3029 clause 1), its outcome is
 * recorded, and the restore is a `finally` in one reviewed place rather than the last line of a throwaway
 * script.
 *
 * THE OUTCOME IS THREE-VALUED AND `unrun` IS THE LOAD-BEARING ONE. `killed` (the mutant reddened the suite)
 * and `survived` (it did not — the guard is vacuous) are the two answers a caller wants. The third is the one
 * hand-rolled shell always loses:
 *
 *   - the `find` text is not present in the file, so NOTHING WAS MUTATED and the suite passed for the
 *     original reason. A typo in the pattern is the single most likely operator error here, and reporting it
 *     as `killed` would be a lie in the most dangerous direction — it would certify a guard as sound on the
 *     strength of a test run that examined the unmodified code;
 *   - the suite was already RED before mutating, so "red after" proves nothing about the mutant;
 *   - the runner itself could not execute.
 *
 * None of those is folded into `killed` and none into `survived`. Same rule as `we:scripts/operations/
 * verify.mjs`'s `unrun` and #3203's killed-vs-crashed juror: absence of evidence is never evidence.
 *
 * `survived` IS BLOCKING. A guard that does not fail when its defect returns is worse than no guard, because
 * it is *counted* as coverage. The verdict says so rather than leaving the caller to infer it.
 *
 * PURE. The mutate → run → restore transaction lives in `./mutation-check-io.mjs` behind the effect below, so
 * every branch in this file is reachable with no filesystem and no test runner.
 */
import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';

export const MUTATION_CHECK_OP = 'mutation-check';

/**
 * The one effect: run the mutate → run → restore transaction.
 *
 * IT IS AN `effect` AND NOT A `compute`, AND THAT IS A SECURITY DECISION, not bookkeeping. `./http-adapter.mjs`
 * derives its route table from step kinds: a `compute`-only declaration is classed read-only and served on
 * `GET`. This operation WRITES TO A SOURCE FILE and spawns the repo's test runner, so a GET that triggered it
 * could sabotage a working tree and execute whatever that tree's test config runs.
 *
 * The first cut of this file declared it `compute`, and `we:scripts/operations/__tests__/http-adapter.test.mjs`
 * caught it: its read-only list is pinned rather than derived precisely so an addition has to be argued, and
 * the test beside it states the promise that addition would have broken — "both readers only read; that is a
 * promise this repo keeps, not a property anything verifies". `verify` is read-only and spawns the whole
 * suite, so subprocesses on GET have precedent; WRITING is where the line actually is.
 *
 * Declaring the transaction as what it is costs nothing — the engine records an effect's return value as the
 * step's finding, so `assess` reduces it exactly as before — and it keeps the operation off the GET surface.
 */
export const MUTATION_PROBE_EFFECT = 'mutation-check.probe';

/** The three outcomes one mutant can have. `unrun` is not a flavour of either other one — see the header. */
export const MUTANT_OUTCOMES = Object.freeze(['killed', 'survived', 'unrun']);

/**
 * Shape one injected `probe` result into the `probe` finding. PURE.
 *
 * REFUSES AN UNKNOWN SHAPE rather than reporting a benign result, for the same reason `verify.shapeRunFinding`
 * does: a broken runner and a genuinely-unkillable mutant must not arrive looking identical.
 */
export function shapeProbeFinding(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('mutation-check.probe: the injected probe must return a result object');
  }
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  if (!has('applied')) {
    throw new Error(
      'mutation-check.probe: the probe must report `applied` — whether the mutation actually changed the '
      + 'file. Without it a pattern that matched nothing is indistinguishable from a mutant the suite killed, '
      + 'and the second reading certifies a guard that was never tested.',
    );
  }
  return {
    target: String(raw.target ?? ''),
    suite: String(raw.suite ?? ''),
    // Did the text actually change? `false` means the `find` pattern was not found.
    applied: raw.applied === true,
    occurrences: Number.isFinite(Number(raw.occurrences)) ? Number(raw.occurrences) : 0,
    // The suite's own verdict BEFORE mutating. A red baseline invalidates the whole probe.
    baselineGreen: raw.baselineGreen === true,
    baselineRan: raw.baselineRan === true,
    // …and after. Only meaningful when `applied` and `baselineGreen`.
    mutantGreen: raw.mutantGreen === true,
    mutantRan: raw.mutantRan === true,
    // Which tests went red under the mutant — the evidence that it was THIS guard that caught it.
    killedBy: Array.isArray(raw.killedBy) ? raw.killedBy.map(String) : [],
    // Was the file put back? Reported, never inferred — see `assessMutant`.
    restored: raw.restored === true,
    detail: typeof raw.detail === 'string' ? raw.detail : '',
  };
}

/**
 * Reduce one probe to a verdict. PURE.
 *
 * THE ORDER OF THESE CHECKS IS THE WHOLE DESIGN. Each disqualifier is tested BEFORE the result it would
 * otherwise corrupt, so no path can reach `killed` on evidence that does not support it.
 */
export function assessMutant(probe) {
  const unrun = (why, detail) => ({
    outcome: 'unrun',
    killed: false,
    // NOT `blocking: false`. A probe that could not run has not cleared the guard, and a caller gating on
    // `blocking` must not read "we could not check" as "we checked and it was fine".
    blocking: true,
    why,
    detail,
  });

  // 1. THE RESTORE, FIRST. If the working tree still holds the mutant, nothing else matters — the caller must
  //    be told before it reads any verdict, because every later command in that checkout runs against
  //    sabotaged source. Deliberately checked ahead of the result it accompanies.
  if (probe.applied && !probe.restored) {
    return {
      ...unrun('not-restored',
        `the mutant was applied to ${probe.target} and NOT restored — that checkout is still sabotaged. `
        + 'Restore it before running anything else there.'),
      dirty: true,
    };
  }

  // 2. WAS THERE ANYTHING TO MUTATE? Keyed on `occurrences`, NOT on `applied`, and the difference is a real
  //    bug this operation's own suite caught: the probe reports `applied: false` for EVERY early return —
  //    including a red baseline, where it deliberately declines to touch the file. Branching on `applied`
  //    therefore told an operator whose suite was merely red that their `find` pattern was wrong, sending
  //    them to fix a typo that did not exist. `occurrences` is the direct evidence about the pattern and
  //    nothing else, so it is what this question asks.
  if (probe.occurrences === 0) {
    return unrun('not-applied',
      `the mutation did not change ${probe.target} — the \`find\` text was not present, so the suite would `
      + 'have run against the unmodified file. This is a typo in the pattern, not a result: nothing was tested.');
  }

  // 3. DID THE BASELINE RUN? Asked before its verdict is read, so "could not execute" never reads as "red".
  if (!probe.baselineRan) {
    return unrun('suite-unrun',
      `the suite could not be executed (${probe.suite}) — ${probe.detail || 'no reason reported'}`);
  }

  // 4. WAS THE BASELINE GREEN? "Red after mutating" proves nothing when it was red before.
  if (!probe.baselineGreen) {
    return unrun('baseline-red',
      `${probe.suite} was already failing BEFORE the mutation, so its failure afterwards would not be `
      + 'evidence the mutant was caught. Get the suite green first.');
  }

  // 5. …and the mutant run itself. Separate from step 3 so the message can name WHICH run died.
  if (!probe.mutantRan) {
    return unrun('suite-unrun',
      `the suite ran clean at baseline but could not be executed against the mutant (${probe.suite}) — `
      + `${probe.detail || 'no reason reported'}`);
  }

  // A green baseline with occurrences > 0 that still reports `applied: false` means the probe bailed for a
  // reason it did not declare. Refusing beats guessing which of the two answers to invent.
  if (!probe.applied) {
    return unrun('not-applied',
      `the probe reported ${probe.occurrences} occurrence(s) of the \`find\` text in ${probe.target} and a `
      + 'green baseline, yet says the mutation was never applied. That combination is unexplained, so no '
      + 'conclusion is drawn from it.');
  }

  // Only now is the comparison meaningful.
  const killed = probe.mutantGreen === false;
  return {
    outcome: killed ? 'killed' : 'survived',
    killed,
    // A surviving mutant IS the defect. Reported as blocking rather than as information, because a guard
    // counted as coverage while unable to fail is worse than an absent one.
    blocking: !killed,
    why: killed ? 'mutant-killed' : 'mutant-survived',
    detail: killed
      ? `${probe.suite} went red under the mutant — the guard defends what it claims to.`
      : `${probe.suite} stayed GREEN with the bug reintroduced into ${probe.target}. The guard is VACUOUS: `
        + 'it is counted as coverage and cannot fail. Assert on the changed behaviour, not on a value the '
        + 'test itself derives.',
    killedBy: probe.killedBy,
    occurrences: probe.occurrences,
  };
}

/**
 * Build the declaration. NO INJECTED DEPS: the transaction is an EFFECT, so it arrives through the sink
 * registered in `./run.mjs` rather than through this builder. Tests supply a stub sink instead of a stub
 * function, which is the same substitution one layer out.
 */
export function mutationCheckOperation() {
  return op(MUTATION_CHECK_OP, {
    input: {
      // The tree to mutate in. REQUIRED and never defaulted to `process.cwd()`: this operation deliberately
      // sabotages a source file, and doing that to whichever directory the caller happened to be standing in
      // is the #1178 shape with teeth.
      checkout: { type: 'string', required: true },
      // The file the bug goes back into, relative to `checkout`.
      target: { type: 'string', required: true },
      // The exact text to replace, and what to replace it with. A literal rather than a regex: the caller is
      // reintroducing a KNOWN bug, and the precision of "this exact line becomes that exact line" is what
      // makes `occurrences` meaningful and the restore exact.
      find: { type: 'string', required: true },
      replace: { type: 'string', required: true },
      // The suite that is supposed to catch it. Naming it — rather than running everything — is what makes
      // the result attributable: this guard, against this mutant.
      suite: { type: 'string', required: true },
    },
    verdictFrom: 'assess',

    probe: effectStep({
      reads: ['input.checkout', 'input.target', 'input.find', 'input.replace', 'input.suite'],
      // NOT `idempotent`. Re-running re-sabotages and re-runs the suite; the result should be identical, but
      // claiming idempotence would invite a replay to skip the restore-verification that is the whole safety
      // story here.
      effects: (view) => [{
        type: MUTATION_PROBE_EFFECT,
        payload: {
          cwd: view.input.checkout,
          target: view.input.target,
          find: view.input.find,
          replace: view.input.replace,
          suite: view.input.suite,
        },
      }],
    }),

    assess: compute({
      reads: ['findings.probe'],
      // The engine records an effect's return value under `effects[].result`, so the reduction reads the same
      // probe result it always did — one indirection further in.
      fn: (view) => {
        const entry = (view.findings.probe?.effects ?? [])[0];
        if (!entry || entry.status !== 'applied' || !entry.result) {
          throw new Error(
            'mutation-check.assess: the probe effect did not complete, so there is no result to judge. '
            + `status=${entry?.status ?? 'missing'}${entry?.error ? ` error=${entry.error}` : ''}`,
          );
        }
        return assessMutant(shapeProbeFinding(entry.result));
      },
    }),
  });
}

/**
 * #5466 — THE REVERT-RED CHECK, as a sibling declaration of `mutation-check` over the same transaction shape: put a
 * fix's SOURCE changes back out (its tests stay), run only the tests it added or changed, and report which of them do
 * not go red. A test that passes with the fix reverted does not discriminate — the same vacuous-guard defect this
 * file's header names, found mechanically instead of by a juror.
 *
 * Inside the fixer's verify it runs from `we:scripts/verify-lane.mjs` (mode from the declared verify settings); this
 * declaration is the replay / by-hand path: `node scripts/operations/run.mjs revert-red-check --checkout=<dir>
 * --base=<pre-fix sha>`. An EFFECT for the same reason `probe` above is: it writes to source files.
 */
export const REVERT_RED_CHECK_OP = 'revert-red-check';
export const REVERT_RED_PROBE_EFFECT = 'revert-red-check.probe';

export function revertRedCheckOperation() {
  return op(REVERT_RED_CHECK_OP, {
    input: {
      // Required, never defaulted to `process.cwd()` — same reason as `mutation-check`'s own `checkout`.
      checkout: { type: 'string', required: true },
      // The pre-fix commit. The range base..head is the fix.
      base: { type: 'string', required: true },
      head: { type: 'string', required: false, default: 'HEAD' },
      // The replay caller asks for a verdict, so the default is `warn` (report, never block); `enforce` makes a
      // non-discriminating test a blocking verdict.
      mode: { type: 'string', required: false, default: 'warn', enum: ['warn', 'enforce'] },
      maxFiles: { type: 'number', required: false, default: 40 },
    },
    verdictFrom: 'assess',

    probe: effectStep({
      reads: ['input.checkout', 'input.base', 'input.head', 'input.mode', 'input.maxFiles'],
      effects: (view) => [{
        type: REVERT_RED_PROBE_EFFECT,
        payload: {
          checkout: view.input.checkout,
          base: view.input.base,
          head: view.input.head,
          mode: view.input.mode,
          maxFiles: view.input.maxFiles,
        },
      }],
    }),

    assess: compute({
      reads: ['findings.probe'],
      fn: (view) => {
        const entry = (view.findings.probe?.effects ?? [])[0];
        if (!entry || entry.status !== 'applied' || !entry.result) {
          throw new Error(
            'revert-red-check.assess: the probe effect did not complete, so there is no result to judge. '
            + `status=${entry?.status ?? 'missing'}${entry?.error ? ` error=${entry.error}` : ''}`,
          );
        }
        return entry.result;
      },
    }),
  });
}
