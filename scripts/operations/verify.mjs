/**
 * @file scripts/operations/verify.mjs
 * @description THE `verify` DECLARATION (#xp240uk, under epic #3029) — did the repo's own checks pass in this
 *   checkout, and if not, what is blocking?
 *
 * IT DECLARES OVER AN EXISTING HOME, IT DOES NOT REPLACE ONE. `we:scripts/verify-lane.mjs` already runs a
 * lane's suites and records the HEAD-keyed marker `pr-land`'s finish-guard gates on (#2833). The first cut of
 * this operation ran the suites itself and skipped that marker, which would have let it report `ok` on a lane
 * `pr-land` then refused — two answers to one question. It now shells the home and classifies what the home
 * said.
 *
 * WHAT THE DECLARATION ADDS. The home speaks in exit codes and a marker vocabulary (`green`, `red`, `running`,
 * `corrupt`, `absent`, TTL-abandoned), and every caller that gates on it has to learn all of it separately.
 * This maps that vocabulary onto the three outcomes a caller acts on, once — and buys its command line and its
 * HTTP route from the same declaration. Per clause 1 of
 * [#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)
 * that is a defect rather than a style choice.
 *
 * THE LOAD-BEARING DISTINCTION IS THREE-VALUED, not two. A check that PASSED, a check that FAILED, and a check
 * that COULD NOT RUN are three different facts, and the third is the one hand-rolled shell always loses: a
 * missing dependency, a crashed runner or a changed summary line exits non-zero with no parseable result, and
 * `|| true` or a `grep` that finds nothing turns it into whichever answer the caller's shell happened to
 * produce. #3203 was the same shape one layer down — a killed juror and a crashed juror arrived identically,
 * which taught the reader to retry rather than look. So `unrun` is a first-class outcome here, it is NEVER
 * folded into `fail`, and it never satisfies a gate.
 *
 * BOTH STEPS ARE `compute` AND THE DECLARATION HAS NO SINK. The subprocess work, including the home's marker
 * writes in run/request modes, lives in `./verify-io.mjs` and is injected, so every branch below is testable
 * with no npm, no vitest and no clock. Compute steps alone do not make the injected IO read-only.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide whether the work is *good*. That is `review-pr`, which judges. This
 * only answers whether the repo's own machine-checkable gates are green, which is the precondition for asking
 * a juror anything at all.
 */
import { op } from './registry.mjs';
// #3224 — the raw invocation this operation declares over. Declared in ONE place and read by two
// consumers: `op()` validates its shape here, and the skill-wiring scan reads the same map.
import { DECLARED_HOMES } from './declared-homes.mjs';
import { compute } from './step-kinds.mjs';

export const VERIFY_OP = 'verify';

/**
 * `run` executes the suites through the single home; `check` reads the marker it recorded and runs nothing.
 * `request` stamps a running marker and returns immediately; the verify daemon runs the gate. An accepted
 * request is `unrun` (requested, pending), never green: only a subsequent `check` can read the result.
 * A closed set, refused before a run exists.
 */
export const VERIFY_MODES = Object.freeze(['run', 'check', 'request']);

/** The three outcomes ONE check can have. `unrun` is not a flavour of `fail` — see the header. */
export const CHECK_OUTCOMES = Object.freeze(['pass', 'fail', 'unrun']);

/**
 * Shape the injected runner's result into the `run` finding.
 *
 * Refuses an unknown shape rather than reporting an empty check list: otherwise a broken runner and a
 * genuinely check-less suite produce the same "nothing blocking" verdict, and the first reads as the second.
 * `gate-health.history` refuses for exactly this reason and this is the same failure wearing a different hat.
 */
export function shapeRunFinding(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.checks)) {
    throw new Error('verify.run: the injected runner must return `{ checks: [...] }`');
  }
  const checks = raw.checks.map((c, i) => {
    const name = String(c?.name ?? '').trim();
    if (!name) throw new Error(`verify.run: check ${i} has no \`name\` — an unnamed check cannot be acted on`);
    if (!CHECK_OUTCOMES.includes(c?.outcome)) {
      // A runner that cannot say which of the three happened has not answered the question. Refusing here is
      // what stops an unrecognised summary line from arriving as a quiet `pass`.
      throw new Error(
        `verify.run: check "${name}" reported outcome ${JSON.stringify(c?.outcome)} — must be one of `
        + `${CHECK_OUTCOMES.join('|')}. A check whose result could not be read is \`unrun\`, never \`pass\`.`,
      );
    }
    return {
      name,
      outcome: c.outcome,
      ...(c.outcome === 'fail' && c.failureDetails ? { failureDetails: c.failureDetails } : {}),
      // The counts are REPORTED, never used to derive the outcome — the runner already decided, and deriving
      // it twice from different data is how the two answers drift apart.
      errors: Number.isFinite(Number(c.errors)) ? Number(c.errors) : null,
      warnings: Number.isFinite(Number(c.warnings)) ? Number(c.warnings) : null,
      summary: typeof c.summary === 'string' ? c.summary : '',
      // Why it could not run, when it could not. Empty for pass/fail.
      reason: typeof c.reason === 'string' ? c.reason : '',
      durationMs: Number.isFinite(Number(c.durationMs)) ? Number(c.durationMs) : null,
    };
  });
  return { cwd: String(raw.cwd ?? ''), suite: String(raw.suite ?? ''), checks };
}

/**
 * Reduce the checks to one verdict. PURE.
 *
 * `ok` requires that EVERY check passed. It is not `!failed`, and the difference is the whole point: with one
 * check failed and one unrun, `!failed` would be false for the right reason by accident, while with zero
 * failed and one unrun it would report green over a gate that never executed.
 *
 * WARNINGS ARE NOT BLOCKING and are carried anyway. This repo runs ~1,390 of them; a verdict that folded them
 * into `ok` would be permanently red and therefore permanently ignored.
 */
export function assessChecks(finding) {
  const checks = finding.checks;
  const by = (o) => checks.filter((c) => c.outcome === o);
  const failed = by('fail');
  const unrun = by('unrun');
  const ok = checks.length > 0 && checks.every((c) => c.outcome === 'pass');
  return {
    cwd: finding.cwd,
    suite: finding.suite,
    ok,
    // The three counts, always present, so a consumer never has to infer one from the other two.
    passed: by('pass').length,
    failed: failed.length,
    unrun: unrun.length,
    checks,
    // What a caller acts on, in the order it should be acted on: a gate that did not run outranks a gate that
    // failed, because the failure is at least known.
    blocking: [
      ...unrun.map((c) => ({ check: c.name, why: 'did-not-run', detail: c.reason || 'no reason reported' })),
      ...failed.map((c) => ({ check: c.name, why: 'failed', detail: [c.summary || `${c.errors ?? '?'} error(s)`, ...(c.failureDetails?.tests ?? []).map(t => t.name ? `${t.file} > ${t.name}` : t.file), c.failureDetails?.summary].filter(Boolean).join('\n') })),
    ],
    // Stated rather than implied: an empty suite is NOT a pass. A caller asking for a suite that produced no
    // checks has been told nothing, and silence must not read as green.
    ...(checks.length === 0 ? { emptySuite: true } : {}),
  };
}

/**
 * Build the declaration. `runChecks` is injected — `./verify-io.mjs` supplies the real subprocess runner;
 * tests supply fixtures, which is what makes every branch above reachable without a toolchain.
 */
export function verifyOperation({ runChecks } = {}) {
  if (typeof runChecks !== 'function') {
    throw new TypeError('verify: needs a `runChecks()` runner — the io is injected so the declaration stays testable without npm');
  }

  return op(VERIFY_OP, {
    declaresOver: DECLARED_HOMES.verify,
    input: {
      // NAMED `checkout`, NOT `cwd`, and the adapter refused the first spelling: `--cwd` is its own control
      // flag (the juror's lane), and a declaration field colliding with it would be ambiguous on the command
      // line. The refusal was right and the new name is better — this is the tree being VERIFIED, which is a
      // different thing from the lane a juror runs in.
      //
      // REQUIRED, with no default. Defaulting to `process.cwd()` is the #1178 shape: an operation that silently
      // verifies whichever directory the caller happened to be standing in reports on the wrong tree, and a
      // green verdict for another checkout is worse than no verdict. The caller must say which.
      checkout: { type: 'string', required: true },
      mode: { type: 'string', required: false, default: 'run', enum: [...VERIFY_MODES] },
      // #xvj8sj0 — THE SUITE COMMAND, passed through to the home's `--gate`. It was absent until the #3224
      // scan made the omission visible: `we:skills-src/conveyor/delivery-agent-brief.md` runs the home with
      // the item's LOCUS gate, and without this field, rewiring that line to the operation would silently run
      // the DEFAULT suite instead — a green verdict for checks the caller never asked for. That is the PR
      // #1508 shape, a rewrite that quietly drops what the raw call did, which is why the scan's finding was
      // answered by building this input rather than by rewiring the skill.
      //
      // EMPTY MEANS "THE HOME'S DEFAULT", not "no gate". The default (`test:unit && check:standards`) lives in
      // `we:scripts/verify-lane.mjs` and is deliberately NOT restated here — a second copy is a second answer
      // to one question (#2644), and it would drift. An empty string simply omits the flag, which is exactly
      // how the home is invoked by a caller that expresses no preference.
      gate: { type: 'string', required: false, default: '' },
    },
    verdictFrom: 'assess',

    run: compute({
      reads: ['input.checkout', 'input.mode', 'input.gate'],
      fn: (view) => shapeRunFinding(runChecks({
        cwd: view.input.checkout, mode: view.input.mode, gate: view.input.gate,
      })),
    }),

    assess: compute({
      reads: ['findings.run'],
      fn: (view) => assessChecks(view.findings.run),
    }),
  });
}
