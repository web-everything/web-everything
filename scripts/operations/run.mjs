#!/usr/bin/env node
/**
 * @file scripts/operations/run.mjs
 * @description THE OPERATION COMMAND LINE (#3035, under epic #3029) — `run.mjs <operation> [flags]`.
 *
 * THE WHOLE ENTRY POINT. There is no per-operation argv parser and no per-operation route: {@link
 * ./cli-adapter.mjs} derives both from the declaration, and this file only says WHICH operations exist and what
 * their io bindings are. Declaring a second operation adds one entry to {@link OPERATIONS} and buys its command
 * line; that is clause 1 of
 * [#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)
 * in the smallest form it can take.
 *
 *   node scripts/operations/run.mjs review-pr --pr=1234 --repo=chalbert/web-everything --cwd=<a lane>
 *   node scripts/operations/run.mjs review-pr --resume=<run-id> --answer=accept
 *   node scripts/operations/run.mjs review-pr --resume=<run-id> --answer=abstain   # writes nothing
 *
 * The first invocation reads, judges, reduces and then STOPS at the `confirm` suspend. The second records. An
 * `--answer` on the first is refused — see the adapter's header.
 *
 * `--cwd=<a lane clone>` is the juror's own lane, and `review-pr`'s juror is TOOL-BEARING, so it is REQUIRED
 * there (`assertLaneCwd` refuses the spawn without one). It was `$JUDGE_LANE_CWD` and nothing else until #3151;
 * the env var still works as the fallback. `--cwd`, `--model` and the rest are listed by `--help`, which is
 * derived from the declaration — including which operations have a juror to point at a lane at all.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRegistry } from './registry.mjs';
import { createFileRunStore, newRunId } from './run-store.mjs';
import { createFileCallLogStore } from './call-log-store.mjs';
import { createDefaultJudge, runOperationCli, buildCliSpec, hasJsonFlag } from './cli-adapter.mjs';
import { reviewPrOperation, REVIEW_PR_OP } from './review-pr.mjs';
import { createReviewPrReader, createReviewPrSinks, PR_VIEW_FIELDS, prViewFileName } from './review-pr-io.mjs';
import { stagePrViewOperation, STAGE_PR_VIEW_OP } from './stage-pr-view.mjs';
import { createPayloadReader, createStagePrViewSinks, defaultViewDir } from './stage-pr-view-io.mjs';
import { reviewPrepOperation, REVIEW_PREP_OP } from './review-prep.mjs';
import { createReviewPrepReader, createReviewPrepSinks } from './review-prep-io.mjs';
import { suggestNextOperation, SUGGEST_NEXT_OP } from './suggest-next.mjs';
import { createBoardReader, createExclusionReader } from './suggest-next-io.mjs';
import { gateHealthOperation, GATE_HEALTH_OP, classifyFollowUp } from './gate-health.mjs';
import { prStatusOperation, PR_STATUS_OP } from './pr-status.mjs';
import { createPrReader } from './pr-status-io.mjs';
import { routePrOutcomeOperation, ROUTE_PR_OUTCOME_OP } from './route-pr-outcome.mjs';
import { createRouteOutcomeReader } from './route-pr-outcome-io.mjs';
import { createHistoryReader } from './gate-health-io.mjs';
import { dispatchLaneOperation, DISPATCH_LANE_OP } from './dispatch-lane.mjs';
import { createTickReader, createDispatchSinks, agentArgsFromEnv } from './dispatch-lane-io.mjs';
import { claimOperation, CLAIM_OP } from './claim.mjs';
import { createClaimReader, createClaimSinks } from './claim-io.mjs';
// ALIASED, and the collision is worth naming: this file already exports `resolveOperation(name)` — the
// registry LOOKUP ("resolve an operation by name"). An operation literally called `resolve` produces a
// builder with the identical name under the `<op>Operation` convention. Aliasing at the import keeps the
// convention intact in `./resolve.mjs` where it reads correctly.
import { resolveOperation as buildResolveOperation, RESOLVE_OP } from './resolve.mjs';
import { createResolveReader, createResolveSinks } from './resolve-io.mjs';
import { scaffoldOperation, SCAFFOLD_OP } from './scaffold.mjs';
import { createScaffoldReader, createScaffoldSinks } from './scaffold-io.mjs';
import { fileItemOperation, FILE_ITEM_OP } from './file-item.mjs';
import { createFileItemReader, createFileItemSinks } from './file-item-io.mjs';
import { openPrOperation, OPEN_PR_OP } from './open-pr.mjs';
import { createOpenPrSinks } from './open-pr-io.mjs';
import { PARK_LABELS } from '../pr-land.mjs';
import { recordVerdictOperation, RECORD_VERDICT_OP } from './record-verdict.mjs';
import { createRunReader, createRecordVerdictSinks } from './record-verdict-io.mjs';
import { validateRequest, APPLIABLE_TARGETS } from '../apply-review-request.mjs';
import { verifyOperation, VERIFY_OP } from './verify.mjs';
import { createChecksRunner } from './verify-io.mjs';
import { mutationCheckOperation, MUTATION_CHECK_OP } from './mutation-check.mjs';
import { createMutationCheckSinks } from './mutation-check-io.mjs';
import { exploreOperation, EXPLORE_OP } from './explore.mjs';
import { createExploreSinks, agentArgsFromEnv as exploreAgentArgsFromEnv } from './explore-io.mjs';
import { gapSweepStatusOperation, GAP_SWEEP_STATUS_OP } from './gap-sweep-status.mjs';
import { createGapSweepSinks } from './gap-sweep-status-io.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';

/**
 * THE OPERATION TABLE — the only per-operation code in the command line. Each entry builds its declaration and
 * its io bindings; everything else is derived.
 *
 * `suggest-next` (#3036) is the proof that "declaring a second operation buys its command line" is literally
 * true: the four lines below are the ENTIRE command-line cost of it. No argv parser, no usage text, no
 * validation — `--help` prints `[--tier=A|B, default A] …` because the declaration says so. The same
 * declaration is what {@link ./http-adapter.mjs} derives a route table from, with no third entry anywhere.
 */
export const OPERATIONS = Object.freeze({
  // `json` is the ONE operation-table entry that reads its `resolveOperation(name, opts)` opts at all — every
  // other builder below still takes none, and passing the extra argument to a zero-arg arrow is a harmless
  // no-op for them. See `createReviewPrSinks`'s own `json` doc (`we:scripts/operations/review-pr-io.mjs`) for
  // WHY this exists: a `--json` caller's stdout must stay pure JSON even when the `record` step's notice
  // effect fires mid-run.
  [REVIEW_PR_OP]: ({ json = false } = {}) => ({
    declaration: reviewPrOperation({ readPr: createReviewPrReader() }),
    sinks: createReviewPrSinks({ json }),
  }),
  // backlog/xzdi27a-* — the sibling of `review-pr` for a BACKLOG CARD instead of a PR diff (no `gh`, no diff,
  // no confirm suspend: a prep review's verdict is a note + a commit, applied in one CLI call end to end).
  [REVIEW_PREP_OP]: () => ({
    declaration: reviewPrepOperation({ readPrep: createReviewPrepReader() }),
    sinks: createReviewPrepSinks(),
  }),
  // #xrk6hmj — carry a verdict from a host with no GitHub credential to the CI job that has one. The request's
  // rules are the APPLIER's, passed in rather than restated: one answer to "is this request legal".
  [RECORD_VERDICT_OP]: () => ({
    declaration: recordVerdictOperation({ readRun: createRunReader() }, { validateRequest, appliableTargets: APPLIABLE_TARGETS }),
    sinks: createRecordVerdictSinks(),
  }),
  // #xp240uk — the step between "work done" and "open a PR", which was hand-rolled shell every time. Two
  // compute steps and no sink, so the HTTP adapter derives a GET with no run record, exactly as `suggest-next`
  // and `gate-health` do.
  [VERIFY_OP]: () => ({
    declaration: verifyOperation({ runChecks: createChecksRunner() }),
  }),
  // #x4omld5 — put the bug back and prove the guard goes red. UNLIKE `verify` above it has a SINK, and that
  // is deliberate: its probe writes to a source file, so declaring the transaction as an `effect` keeps the
  // operation off `./http-adapter.mjs`'s GET-only read-only surface. See the effect's own comment.
  [MUTATION_CHECK_OP]: () => ({
    declaration: mutationCheckOperation(),
    sinks: createMutationCheckSinks(),
  }),
  // #xkp1mv8 — a thin wrap of the existing `we:scripts/gap-sweep-status.mjs` CLI. UNLIKE `verify` above, its
  // one step is an `effect`: `mode: 'snapshot'` writes a file, so the step kind must keep the whole operation
  // off `./http-adapter.mjs`'s GET-only surface regardless of which mode a given call chooses. See the
  // declaration's own comment.
  [GAP_SWEEP_STATUS_OP]: () => ({
    declaration: gapSweepStatusOperation(),
    sinks: createGapSweepSinks(),
  }),
  // #xrrpfo7 — `claim`'s sibling: the CLOSE of the lifecycle whose OPEN #3034 declared. Same shape (read →
  // plan → write), same guarded writer, and the guards are REPLAYED from `we:scripts/backlog.mjs`'s
  // `transition()` rather than reinvented.
  [RESOLVE_OP]: () => ({
    declaration: buildResolveOperation({ readResolveContext: createResolveReader() }),
    sinks: createResolveSinks(),
  }),
  // #xrrpfo7 — the BIRTH of the lifecycle whose open is `claim` and whose close is `resolve`. 45 raw calls
  // in one session, the most-invoked backlog verb, and no operation over it until now.
  [SCAFFOLD_OP]: () => ({
    declaration: scaffoldOperation({ readScaffoldContext: createScaffoldReader() }),
    sinks: createScaffoldSinks(),
  }),
  // #3383 — the epic's own gap, closed: `scaffold` above writes a card and stops, leaving it invisible to
  // `we:scripts/conveyor/tick-core.mjs#planTick` until a session separately remembers `queue.mjs add`. This
  // wraps scaffold's own read/plan/write (unchanged) and adds the clear-for-build hand-off as a second effect,
  // so filing an item has ONE declared call end to end instead of a card + a separately-remembered gesture.
  // Graduated from `origin/lane/mechanical-dispatcher` (#3548); see `file-item.mjs`'s own header.
  [FILE_ITEM_OP]: () => ({
    declaration: fileItemOperation({ readScaffoldContext: createFileItemReader() }),
    sinks: createFileItemSinks(),
  }),
  [SUGGEST_NEXT_OP]: () => ({
    declaration: suggestNextOperation({
      loadBoard: createBoardReader(),
      loadExclusions: createExclusionReader(),
    }),
    // NO SINKS, AND NOT AN OVERSIGHT: every step is `compute`, so the declaration cannot produce an effect
    // for a sink to apply. `applyPendingEffects` is never reached, and the HTTP adapter reads the same step
    // kinds to give this operation a GET-only, record-free surface.
    sinks: {},
  }),
  // Registering here is what makes `gate-health` callable at all. It shipped unregistered in PR #1163, so
  // `resolveOperation` threw and its "callable from the command line and over HTTP" claim was false — the
  // reviewer could only run it by hand-writing the wiring. Same no-sinks reasoning as `suggest-next`.
  // #xewnork — did a check actually RUN on the head that is there now? Read-only, same no-sinks reasoning as
  // `suggest-next` and `gate-health`: every step is `compute`, so no effect exists for a sink to apply.
  [PR_STATUS_OP]: () => ({
    declaration: prStatusOperation({ readPrs: createPrReader() }),
    sinks: {},
  }),
  [GATE_HEALTH_OP]: () => ({
    declaration: gateHealthOperation({ loadHistory: createHistoryReader({ classify: classifyFollowUp }) }),
    sinks: {},
  }),
  // #xrpo1 — the gap: no operation reached `deriveReviewDisposition` (`we:scripts/lib/review-core.mjs`), so a
  // caller through the engine had to reach around it into `review-core.mjs`/`review-escalation.mjs` directly.
  // Read-only, same no-sinks reasoning as `pr-status`/`gate-health`/`suggest-next`: every step is `compute`,
  // and the disposition call itself lives in `route-pr-outcome-io.mjs` (not this declaration) so the
  // declaring module stays an import-graph leaf — see that file's header for why.
  [ROUTE_PR_OUTCOME_OP]: () => ({
    declaration: routePrOutcomeOperation({ readPrView: createRouteOutcomeReader() }),
    sinks: {},
  }),
  // #3037 — the first operation whose effect STARTS work instead of finishing it. Its one sink launches a
  // delivery agent and returns an in-flight marker; the matching OBSERVER is registered by the waker
  // (`we:scripts/operations/wake.mjs`), which is the process that polls it. Both live in `dispatch-lane-io.mjs`.
  [DISPATCH_LANE_OP]: () => ({
    declaration: dispatchLaneOperation({ readTick: createTickReader() }),
    // `WE_DISPATCH_AGENT_ARGS` is read HERE rather than defaulted inside the sink: the permission mode, the
    // model and the effort a dispatched agent runs under are the operator's call, and a knob only a test can
    // reach is not a knob. Unset → no extra flags, which is the deliberate non-default (a baked-in
    // `--dangerously-skip-permissions` would widen every agent this ever launches).
    sinks: createDispatchSinks({ extraArgs: agentArgsFromEnv() }),
  }),
  // #3034 — the is-the-engine-too-heavy probe: `compute` → `compute` → `effect`, no judge, no confirm.
  // Registering here is what makes `node run.mjs claim --ref=<NNN>` work; `we:scripts/backlog.mjs claim`
  // (the real command-line caller) routes through the SAME declaration (`we:scripts/backlog.mjs`'s
  // `claimViaOperation`), not a second implementation.
  [CLAIM_OP]: () => ({
    declaration: claimOperation({ readClaimContext: createClaimReader() }),
    sinks: createClaimSinks(),
  }),
  // #3150 — the multi-agent committee. The SECOND operation whose effects start work instead of finishing it,
  // and the proof that #3037's long-running-effect machinery generalises: it reuses `dispatch: true` +
  // `inFlight(handle)` + the observer contract whole and adds no mechanism of its own. Its declaration takes NO
  // injected reader — every input is a declared field and the panel's reports arrive on the run record as the
  // `investigate` step's own finding — so this entry binds sinks only. The matching OBSERVER is registered by
  // the waker (`we:scripts/operations/wake.mjs`), which is the process that polls it.
  // Opening a PR goes THROUGH `we:scripts/pr-land.mjs`, which already owns the lane-ref guard, the bodyless-PR
  // refusal, the park label and the #2833 verify finish-guard. This declaration re-decides none of them; it
  // exists so the step is reachable as an operation instead of by reaching for the GitHub connector directly,
  // which is how three PRs in one session skipped every one of those guards and one shipped red.
  //
  // PARK_LABELS is the home's own, injected rather than restated: a second list here could ask for a park the
  // home refuses.
  [OPEN_PR_OP]: () => ({
    declaration: openPrOperation({ parkLabels: PARK_LABELS }),
    sinks: createOpenPrSinks(),
  }),
  [EXPLORE_OP]: () => ({
    declaration: exploreOperation(),
    // The SAME `WE_DISPATCH_AGENT_ARGS` a dispatched delivery agent runs under, and deliberately not a second
    // knob: a committee panelist and a delivery agent are the same kind of spawned background session, so an
    // operator who set the permission mode for one meant it for both. Unset → no extra flags.
    sinks: createExploreSinks({ extraArgs: exploreAgentArgsFromEnv() }),
  }),
  // The other half of the file transport `review-pr-io.mjs` already reads from: on a host where `gh` cannot
  // authenticate, the view is staged by hand, and a hand-assembled view drops a field by omission. The reader
  // DEFAULTS every one of those to empty, so an absent `labels` makes a `review:human` PR look clearable.
  // This refuses an incomplete view before it is written.
  //
  // THE FIELD LIST AND THE FILENAME ARE THE READER'S OWN, injected here rather than restated in the
  // declaration — the same single-home wiring `record-verdict` uses for the applier's validator. A second
  // namer would send the review to a different file than the one staged (#1466).
  //
  // #xaoja7a — THE READER ALSO GETS `prViewFileName`, for the same single-home reason the declaration does.
  // The CI transport reads `ops/pr-views/views/<name>.json` and the staging step writes `<dir>/<name>.json`;
  // if those two names could disagree, `--fromTransport` would wait forever on a file CI had already published
  // under the other spelling. One namer, two consumers.
  [STAGE_PR_VIEW_OP]: () => ({
    declaration: stagePrViewOperation(
      { readPayload: createPayloadReader({ viewFileName: prViewFileName }) },
      { fields: PR_VIEW_FIELDS, viewFileName: prViewFileName, defaultDir: defaultViewDir() },
    ),
    sinks: createStagePrViewSinks(),
  }),
});

/**
 * THE COMMAND LINE'S JUDGE FACTORY — the one place `--cwd`/`--model` become a juror's spawn options (#3151).
 *
 * EXPORTED SO THE TEST DRIVES THIS FUNCTION AND NOT A COPY OF IT. The first cut inlined the arrow below and the
 * suite re-created the same expression, so the precedence was ASSERTED, never EXERCISED: deleting the flags
 * from this file entirely left 14 of 15 tests green (PR review, finding A). A later edit flipping the order to
 * `env || cwd` would silently make `--cwd` lose to a stale environment variable and reopen #3151 with the gate
 * still green. One copy, imported by both.
 *
 * @param {object} [o]
 * @param {Record<string, (string|undefined)>} [o.env] - the environment to read `JUDGE_LANE_CWD` from.
 * @param {(o: object) => Function} [o.factory] - the judge builder, injected so a test can supply the spawn.
 * @returns {(flags: {cwd: (string|null), model: (string|null)}) => Function} `runOperationCli`'s `makeJudge`.
 */
export function createCliJudgeFactory({ env = process.env, factory = createDefaultJudge } = {}) {
  // THE FLAG WINS, and the env var is the fallback — the explicit act beats the ambient one. `|| null` on both,
  // never a fallback to this process's directory: see the `makeJudge` note at the call site.
  return ({ cwd, model } = {}) => factory({
    cwd: cwd || env.JUDGE_LANE_CWD || null,
    model: model || null,
  });
}

/**
 * Build an isolated registry plus the bindings for ONE named operation. Throws on an unknown name.
 *
 * @param {string} name
 * @param {{json?: boolean}} [opts] - passed straight through to the table entry's builder. Every builder
 *   except `REVIEW_PR_OP`'s ignores it today (see the table above); it exists here so a CALLER can tell a
 *   builder what its OWN argv already says before the declaration it binds to is resolved — `json` is the one
 *   case that needs this (stdout purity under `--json`, `we:scripts/operations/review-pr-io.mjs`).
 */
export function resolveOperation(name, opts = {}) {
  // `Object.hasOwn`, never a bare bracket read: `OPERATIONS['toString']` on a normal-prototype object returns an
  // INHERITED function, which a `typeof … === 'function'` test then accepts as a real operation. Same hazard the
  // jury enums guard with null-prototype tables (`we:scripts/lib/jury-core.mjs`, #xdompzx).
  const build = Object.hasOwn(OPERATIONS, String(name ?? '')) ? OPERATIONS[name] : undefined;
  if (typeof build !== 'function') {
    throw new Error(
      `operations: no operation named ${JSON.stringify(name)} (known: ${Object.keys(OPERATIONS).sort().join(', ')})`,
    );
  }
  const { declaration, sinks } = build(opts);
  const registry = createRegistry();
  registry.register(declaration);
  return { declaration, registry, sinks };
}

/** The usage text when no operation is named. */
export function rootUsage() {
  return [
    'usage: run.mjs <operation> [--flags]',
    '',
    `operations: ${Object.keys(OPERATIONS).sort().join(', ')}`,
    '',
    'Run `run.mjs <operation> --help` for an operation\'s flags — they are derived from its declaration.',
  ].join('\n');
}

// The standard main check used across `we:scripts` — importing this module (tests do) must not run the CLI.
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === '--help' || name === '-h') {
    writeAllSync(1, `${rootUsage()}\n`);
    process.exit(name ? 0 : 2);
  }
  let resolved;
  try {
    // `rest` is this invocation's OWN argv, known before the declaration is — see `hasJsonFlag`'s doc for why
    // a full `parseOperationArgv` pass cannot run yet at this point.
    resolved = resolveOperation(name, { json: hasJsonFlag(rest) });
  } catch (e) {
    writeAllSync(1, `error: ${String(e.message ?? e)}\n\n${rootUsage()}\n`);
    process.exit(2);
  }
  const { declaration, registry, sinks } = resolved;
  if (rest.includes('--help')) {
    writeAllSync(1, `${buildCliSpec(declaration).usage}\n`);
    process.exit(0);
  }
  runOperationCli({
    declaration,
    argv: rest,
    registry,
    store: createFileRunStore(),
    // #3451 — the real, file-backed call-visibility signal. A compute-only operation (gate-health,
    // suggest-next, verify, pr-status) settles in one `driveRun` sweep and never gets a run record; this
    // is the ONLY trace a real CLI invocation of one of those leaves behind.
    callLog: createFileCallLogStore(),
    sinks,
    // A TOOL-BEARING juror needs a lane of its OWN, and `assertLaneCwd` refuses the spawn without one. This
    // entry point still does not ACQUIRE that lane — it must not lease a resource whose release it cannot
    // guarantee, and a caller that has leased none should get the refusal.
    //
    // WHERE THE LANE COMES FROM (#3151): `--cwd` first, `$JUDGE_LANE_CWD` second. The env var was the ONLY
    // source until this card, which made a documented flag out of a side channel no `--help` mentioned — three
    // independent reviewers hit the refusal on 2026-08-17 and each fell back to a manual review. The env var is
    // KEPT as the fallback rather than replaced: dispatch prompts and shell wrappers already thread it, and
    // breaking them to make a point would trade one paper cut for another. The flag WINS when both are set —
    // the explicit act beats the ambient one.
    //
    // A FACTORY, NOT A JUDGE. The flags are parsed inside `runOperationCli`, so a judge built out here could
    // not see them; `makeJudge` is called with the parsed values ({@link createCliJudgeFactory}, which the
    // suite drives directly rather than re-deriving). `|| null` still holds, and still matters (PR #1178
    // review, blocking 1): an omitted cwd must reach `judgeSpawn` as `null`, never as this process's
    // directory. A review normally runs INSIDE a lane, so the old `process.cwd()` default silently handed the
    // juror the driver's own working tree — the very tree the parent was mid-review of, and one the juror's
    // mandate tells it to mutate. `null` makes the refusal fire, which is what the caller wanted all along. A
    // tool-free juror ignores `cwd`, so every existing operation is unaffected.
    makeJudge: createCliJudgeFactory(),
    newRunId: () => newRunId(declaration.name),
  })
    .then(({ code, lines }) => {
      writeAllSync(1, `${lines.join('\n')}\n`);
      process.exit(code);
    })
    .catch((e) => {
      // The engine and the declaration both REFUSE rather than improvise; a refusal must reach the operator
      // with its own words, never a paraphrase.
      writeAllSync(1, `error: ${String(e?.message ?? e)}\n`);
      process.exit(1);
    });
}
