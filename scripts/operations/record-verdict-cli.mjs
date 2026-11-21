#!/usr/bin/env node
/**
 * @file scripts/operations/record-verdict-cli.mjs
 * @description #3540 — `record-verdict`, MADE SELF-SUFFICIENT ON A HOST WITH NO `gh`.
 *
 * THE DEADLOCK THIS CLOSES (see the card, #3540 — found driving #1961 to a verdict with no operator).
 * `record-verdict`'s `read` step refuses without a staged write-up, and the ONLY thing that ever staged one was
 * `review-pr`'s OWN `record` step — which ALSO swaps the label, and that half needs `gh`. So reaching the
 * write-up meant a manual, separate `review-pr --resume=<runId> --answer=accept` first, which then halted on
 * the label swap it could never complete on a credential-less host: a clean, agent-reviewable accept recorded
 * as an indistinguishable `effect-halted` run.
 *
 * #3540's split (`review-pr.mjs`'s `stageVerdict` step, ahead of `record`) makes the write-up reachable with NO
 * `gh` at all — but something still has to ANSWER `review-pr`'s `confirm` and apply that ONE step's effect
 * before `record-verdict` can read it. This file is that something: a THIN entry point, in the same shape as
 * `we:scripts/operations/review-loop-cli.mjs`, that does the local, `gh`-free half of driving `review-pr`
 * forward (`we:scripts/operations/record-verdict-io.mjs#advanceReviewPrToWriteUp`) before handing off to the
 * exact same `record-verdict` declaration and command line every other caller uses.
 *
 *   node scripts/operations/record-verdict-cli.mjs --runId=<review-pr-run-id> --to=accepted
 *
 * WHY A SEPARATE ENTRY POINT AND NOT A FLAG ON `run.mjs record-verdict`. Same reasoning as
 * `review-loop-cli.mjs`'s own header: `runOperationCli` drives every declared operation uniformly, and folding
 * a `review-pr`-specific pre-pass into it would let every OTHER operation's caller reach into a concern that is
 * not its own — the same "a declaration's own concern leaking into the shared adapter" shape this codebase
 * already refuses elsewhere.
 *
 * PURELY ADDITIVE ON THE REVIEW-PR RUN. A run that is not genuinely `awaiting-confirm`, or a `to` that names no
 * `review-pr` confirm answer (`clear-human`), passes through UNCHANGED (see `confirmAnswerFor` in
 * `review-pr.mjs`) — this never invents a decision, it only carries out the one the caller's own `--to` already
 * states. `record-verdict`'s OWN declaration, its refusals and its command line are UNTOUCHED: this file wraps
 * them, it does not re-implement them.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runOperationCli, parseOperationArgv } from './cli-adapter.mjs';
import { resolveOperation } from './run.mjs';
import { createFileRunStore, newRunId } from './run-store.mjs';
import { advanceReviewPrToWriteUp } from './record-verdict-io.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
// #3540 round 2 (converge) — IMPORTED, NOT RESTATED. The pre-pass uses record-verdict's OWN request validator to
// decide whether it is even worth mutating review-pr's run — see the pre-check below.
import { validateRequest } from '../apply-review-request.mjs';

/** The operation this wrapper always fronts. Not a flag: this file has exactly one job. */
export const RECORD_VERDICT_CLI_OP = 'record-verdict';

/**
 * #3540 round 3 (converge, simplicity) — ONE NAMED SHAPE for a pre-drive refusal, matching (not re-deriving)
 * the shape `we:scripts/operations/cli-adapter.mjs`'s own `runOperationCli` returns for its OWN pre-drive
 * refusals (a bad `--resume`, a missing run record) — `{code: 2, lines: ['error: …'], run: null, stopped:
 * 'refused'}`. That shape is inlined at each of `cli-adapter.mjs`'s own call sites rather than exported, so
 * this is not a second copy of a shared constructor; it is this file's own single point for the one shape it
 * itself needs to produce, so a future edit to `runRecordVerdictSelfSufficient` cannot drift the two refusal
 * sites this file has apart from each other.
 *
 * @param {unknown} error
 * @returns {{code: 2, lines: string[], run: null, stopped: 'refused'}}
 */
function prepassRefusal(error) {
  return { code: 2, lines: [`error: ${String(error?.message ?? error)}`], run: null, stopped: 'refused' };
}

/**
 * Run `record-verdict`, auto-driving `review-pr`'s local half first when the target names a real confirm answer.
 *
 * @param {object} o
 * @param {object} o.declaration - the `record-verdict` declaration.
 * @param {string[]} o.argv
 * @param {{read: Function, write: Function}} o.store - `review-pr`'s OWN run store; `record-verdict` reads the
 *   SAME store through its injected `readRun` (see `resolveOperation`'s `RECORD_VERDICT_OP` entry), so this one
 *   store is where the pre-pass writes and where `record-verdict`'s `read` step looks.
 * @param {Record<string, Function>} [o.reviewPrSinks] - the sinks `advanceReviewPrToWriteUp` applies
 *   `stageVerdict`'s WRITE_UP effect through. Defaults to the REAL local sinks (`advanceReviewPrToWriteUp`'s
 *   own default, in `record-verdict-io.mjs`) — inject a stub only to keep a test off the real filesystem.
 * @param {...*} rest - every other field `runOperationCli` takes (`registry`, `sinks`, `newRunId`, `judge`,
 *   `makeJudge`, `callLog`), forwarded verbatim.
 * @returns {Promise<{code: number, lines: string[], run: (object|null), stopped: string}>}
 */
export async function runRecordVerdictSelfSufficient({ reviewPrSinks, ...o } = {}) {
  const { declaration, argv, store } = o;
  // A BEST-EFFORT PRE-PASS, NOT A SECOND PARSE. `record-verdict`'s OWN `parseOperationArgv` call inside
  // `runOperationCli` below remains the one that actually validates and refuses `argv` — this parse only reads
  // `runId`/`to` off it, when they parse cleanly, to decide whether there is a `review-pr` run worth advancing.
  // A parse failure here is not reported: `runOperationCli` reports the SAME failure properly a few lines down,
  // through the exact refusal shape every other caller sees.
  const parsed = parseOperationArgv(declaration, argv);
  if (parsed.ok && !parsed.control.resume) {
    const record = store.read(parsed.input.runId);
    // #3540 round 2 (converge finding, security) — REFUSE TO MUTATE review-pr's RUN ON A REQUEST
    // record-verdict WOULD REFUSE ANYWAY. Answering `confirm` is a ONE-SHOT, irreversible decision on the
    // review-pr run; staging the write-up is a real file write. Running either ahead of a request
    // `record-verdict`'s own `plan` step would reject on arrival (e.g. a stray `operatorInstruction` on a
    // non-`clear-human` target) would leave review-pr's run permanently advanced with nothing to show for it —
    // the exact failure the correctness/security panel named on the first convergence round. `validateRequest`
    // is the SAME function `record-verdict`'s `plan` step calls (imported, not restated), so this pre-check can
    // only ever AGREE with that later refusal, never invent a second answer to "is this request legal".
    //
    // #3540 round 3 (converge finding, correctness/standards-conformance) — `body` IS A PLACEHOLDER, AND THAT
    // IS A NAMED, PINNED RESIDUAL, not an oversight. The real write-up does not exist yet at precheck time —
    // producing it IS the action being gated — so this precheck can only ever see body-INDEPENDENT rules.
    // `validateRequest`'s own body-dependent rule today is exactly one: `to==='changes'` requires a non-empty
    // `body`, and the placeholder is non-empty, so that rule can never fire here regardless of what the real
    // write-up eventually contains. `we:scripts/operations/__tests__/record-verdict-cli.test.mjs`'s "the
    // precheck's placeholder body...` test PINS that property — if `validateRequest` ever grows a SECOND
    // body-dependent rule that a placeholder could satisfy while a real write-up would not, that test reddens
    // and this comment is where the fix belongs, not a silent gap.
    //
    // A `null` record (no such run) also fails this precheck harmlessly, since `repo`/`pr` come from it — the
    // pre-pass already no-ops on a `null` record via `advanceReviewPrToWriteUp`, so this changes nothing for
    // that case beyond deciding it one line earlier.
    const precheck = validateRequest({
      repo: record?.input?.repo ?? '',
      pr: Number(record?.input?.pr) || 0,
      to: parsed.input.to,
      actor: parsed.input.actor,
      body: 'placeholder',
      operatorInstruction: parsed.input.operatorInstruction,
      expectedHead: parsed.input.expectedHead,
    });
    if (precheck.ok) {
      try {
        await advanceReviewPrToWriteUp(record, {
          to: parsed.input.to, store, ...(reviewPrSinks ? { sinks: reviewPrSinks } : {}),
        });
      } catch (e) {
        // #3540 round 2 (converge finding, correctness) — A THROW HERE (review-pr's OWN INVARIANT 2 refusal,
        // e.g. `accept` on a `review:human` PR) must not escape as a raw, differently-shaped exception: it has
        // to read like every other refusal this CLI can produce.
        //
        // #3540 round 4 (converge, claim-accuracy) — ONLY A TAGGED REFUSAL CONVERTS. `advanceReviewPrToWriteUp`
        // tags `e.reviewPrRefusal` on review-pr's OWN deliberate policy refusal and leaves every OTHER throw
        // (a genuine infrastructure fault — e.g. the WRITE_UP sink's real disk write failing) UNTAGGED. An
        // untagged throw is NOT a "refused" — relabeling it that way would tell a caller branching on `stopped
        // === 'refused'` ("expected, no action needed") that a real bug is a policy gate. It re-throws instead,
        // so it reaches this file's own bottom-level `.catch`, which reports it as the code-1 crash it is.
        if (e?.reviewPrRefusal) return prepassRefusal(e);
        throw e;
      }
    }
  }
  return runOperationCli(o);
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const { declaration, registry, sinks } = resolveOperation(RECORD_VERDICT_CLI_OP);
  runRecordVerdictSelfSufficient({
    declaration, registry, argv, store: createFileRunStore(), sinks,
    newRunId: () => newRunId(declaration.name),
  })
    .then(({ code, lines }) => { writeAllSync(1, `${lines.join('\n')}\n`); process.exit(code); })
    .catch((e) => { writeAllSync(1, `error: ${String(e?.message ?? e)}\n`); process.exit(1); });
}
