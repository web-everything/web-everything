#!/usr/bin/env node
/**
 * @file scripts/operations/review-loop-cli.mjs
 * @description #3072's REMAINING SLICE, MADE CALLABLE — drives ONE `review-pr` run unattended, using
 * `we:scripts/lib/review-loop-policy.mjs`'s ratified confirm policy, and files a notification either way the
 * policy leaves a debt behind: the queued-accept notice when it DECLINES an accept (`review:human`), or the
 * filed-prevention notice when it ANSWERS accept over an unfiled prevention guard (#3442, `review:pending`).
 *
 *   node scripts/operations/review-loop-cli.mjs --pr=1234 --repo=chalbert/web-everything --cwd=<a lane>
 *   node scripts/operations/review-loop-cli.mjs --resume=<run-id> --repo=chalbert/web-everything --pr=1234
 *
 * WHY THIS IS A SEPARATE ENTRY POINT FROM `run.mjs review-pr`, NOT A FLAG ON IT. `runOperationCli`
 * (`we:scripts/operations/cli-adapter.mjs`) drives every declared operation for a HUMAN at a terminal — it
 * calls `driveRun` with `attemptedBy: 'human'` and no `autoConfirm`, which is exactly right for that caller.
 * Threading an `--unattended` flag through the GENERIC adapter would let every OTHER declared operation opt
 * into a review-specific policy it knows nothing about — the same "a declaration's own concern leaking into
 * the shared adapter" shape `review-pr.mjs` itself refuses at its `read` step (`assertMandatoryLensSeated`
 * lives on the declaration, not on `cli-adapter.mjs`). So this operation's unattended path gets its own thin
 * entry point, the same way `we:scripts/operations/dispatch-abort.mjs` is its own plain module rather than a
 * mode of `run.mjs`.
 *
 * WHAT THIS FILE OWNS, AND ONLY THIS: wiring `driveRun`'s generic `autoConfirm` seam to the CONCRETE policy,
 * and — the one genuinely new behaviour — filing the queued-accept notification when that policy declines an
 * accept. Everything else is reused, not re-derived: `run.mjs`'s own operation table (`resolveOperation`,
 * `createCliJudgeFactory`) builds the exact same declaration/registry/sinks/judge the human CLI uses, and
 * `we:scripts/operations/cli-adapter.mjs`'s own `parseOperationArgv` / `renderOutcome` / `restartCommand`
 * render every stop this shares with the human path — so a bug fixed in either place is fixed here too, and
 * the two callers can never quietly drift on what a stop MEANS.
 *
 * THE ROUND CAP NEEDS NOTHING NEW HERE (see `review-loop-policy.mjs`'s header for the full account): by the
 * time this file sees a run, `run.verdict.loop` is already `converged` / `in-progress` / `exhausted` /
 * `escalated`, computed by `deriveLoopOutcome` off the verdict ledger's own history. `--json` already prints
 * it (`outcomePayload`'s `verdict` field IS the whole `reduce` finding). This file's plain-text output names
 * it explicitly anyway, so a human skimming stdout for "did this bounce cleanly or run out of rounds" is not
 * forced to parse JSON to find out.
 *
 * ONE ROUND PER INVOCATION, DELIBERATELY. Re-judging the SAME diff twice in one process is not what the round
 * cap is FOR — round N+1 exists only once the diff has actually changed (a fix landed), which happens in a
 * different process entirely. So this script drives exactly one read→judge→judgeSecurity→reduce→confirm
 * [→record] pass and exits; the loop ACROSS rounds is realized by re-invoking it once the PR's diff moves —
 * `#3279`'s dispatched session's job every time it runs, never a `while` loop inside this file.
 *
 * IMPURE: spawns jurors (via the injected judge), writes run records, and — only on a queued accept — appends
 * one line to the learnings pool. Everything DECISION-shaped is imported from a pure module (`review-loop-
 * policy.mjs`); nothing here decides, it only wires and reports.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { driveRun, hasJsonFlag, outcomePayload, parseOperationArgv, renderOutcome } from './cli-adapter.mjs';
import { startRun, runStatus } from './engine.mjs';
import { createFileRunStore, newRunId } from './run-store.mjs';
import { resolveOperation, createCliJudgeFactory } from './run.mjs';
import { appendEntry } from '../conveyor/learnings-drop.mjs';
import {
  acceptResumeCommand, buildAcceptQueueEntry, buildPreventionQueueEntry, isPreventionOutstandingClear,
  isQueuedAcceptStop, reviewLoopAutoConfirm,
} from '../lib/review-loop-policy.mjs';
import { hasUncapturedPrevention } from '../lib/jury-core.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';

/** The operation this driver always runs. Not a flag: this file has exactly one job. */
export const REVIEW_LOOP_OP = 'review-pr';

/**
 * DRIVE ONE ROUND, UNATTENDED. The whole file, as a function — mirrors `we:scripts/operations/cli-adapter.mjs
 * #runOperationCli`'s shape closely, on purpose, so the two are easy to read side by side and hard to let
 * drift silently: same parse, same start-or-resume, same render. The differences are exactly the two things
 * this file exists for — `autoConfirm` on the `driveRun` call, and the queued-accept branch after it returns.
 *
 * @param {object} o
 * @param {object} o.declaration - the `review-pr` declaration (a fresh one per call; see the CLI block).
 * @param {object} o.registry
 * @param {string[]} o.argv
 * @param {{read: Function, write: Function}} o.store
 * @param {Record<string, Function>} o.sinks
 * @param {(o: {cwd: (string|null), model: (string|null)}) => Function} o.makeJudge
 * @param {() => string} o.mintRunId
 * @param {(pending: object|null, run: object) => ({value: string}|null)} [o.autoConfirm] - injected so a test
 *   can supply a stub; the real caller always passes {@link reviewLoopAutoConfirm}.
 * @param {(entry: object, opts: object) => {record: object, path: string}} [o.appendLearning] - injected so a
 *   test never touches the real pool file; the real caller always passes `learnings-drop.mjs#appendEntry`.
 * @param {string} [o.session] - the learnings-pool session slug the queued-accept entry files under.
 * @returns {Promise<{code: number, lines: string[], run: (object|null), stopped: string}>}
 */
export async function runReviewLoopOnce({
  declaration, registry, argv, store, sinks, makeJudge, mintRunId, autoConfirm = reviewLoopAutoConfirm,
  appendLearning = appendEntry, session = 'review-loop',
} = {}) {
  const parsed = parseOperationArgv(declaration, argv);
  if (parsed.control.help) {
    const { buildCliSpec } = await import('./cli-adapter.mjs');
    return { code: 0, lines: [buildCliSpec(declaration).usage], run: null, stopped: 'help' };
  }
  if (!parsed.ok) {
    const { buildCliSpec } = await import('./cli-adapter.mjs');
    return {
      code: 2,
      lines: [...parsed.errors.map((e) => `error: ${e}`), '', buildCliSpec(declaration).usage],
      run: null,
      stopped: 'refused',
    };
  }

  const activeJudge = makeJudge({ cwd: parsed.control.cwd || null, model: parsed.control.model || null });

  let run;
  if (parsed.control.resume) {
    run = store.read(parsed.control.resume);
    if (!run) return { code: 2, lines: [`error: no run record for ${JSON.stringify(parsed.control.resume)}`], run: null, stopped: 'refused' };
    if (run.op !== declaration.name) {
      return { code: 2, lines: [`error: run ${run.id} is a \`${run.op}\` run, not \`${declaration.name}\``], run: null, stopped: 'refused' };
    }
  } else {
    run = startRun({ op: declaration.name, id: parsed.control.runId || mintRunId(), input: parsed.input, registry });
    store.write(run);
  }

  let resume = null;
  if (parsed.control.answer != null) {
    const status = runStatus(run, { registry });
    if (status !== 'awaiting-confirm') {
      return {
        code: 2,
        lines: [`error: run ${run.id} is \`${status}\`, not awaiting a decision — refusing an --answer for a question that has not been asked.`],
        run,
        stopped: 'refused',
      };
    }
    resume = { step: run.pending.step, value: parsed.control.answer };
    for (const [field, value] of Object.entries(parsed.control.confirm)) {
      run = { ...run, input: { ...run.input, [field]: value } };
    }
    if (Object.keys(parsed.control.confirm).length) store.write(run);
  }

  // THE ONE LINE THIS FILE ADDS TO THE DRIVE CALL: an UNATTENDED policy, and `attemptedBy: 'agent'` so a
  // reader of the run's own step-timing record can tell this pass apart from a human at a terminal — the same
  // distinction `applyPendingEffects`'s `attemptedBy` already threads for its effect rows.
  const outcome = await driveRun({
    run, registry, store, sinks, judge: activeJudge, resume, autoConfirm, attemptedBy: 'agent',
  });

  // ── THE QUEUED-ACCEPT BRANCH — the one behaviour `runOperationCli` does not have ──────────────────────────
  // The policy already declined (see `review-loop-policy.mjs`); this only decides whether to FILE the
  // notification and say so, or fall through to the SAME rendering the human CLI would give an ordinary
  // confirm stop (which still happens — a `review:human` PR still parks exactly as it always has).
  //
  // #x100grep — EVERY EXIT OF THIS FUNCTION CARRIES `run.verdict.loop` THROUGH UNMODIFIED, this branch
  // included. A future caller (the reconcile/runner wiring this item deliberately does not build, or a human)
  // decides whether to dispatch ANOTHER round or stop by reading `converged`/`in-progress`/`exhausted`/
  // `escalated` off exactly this field — so a branch that rendered its own bespoke JSON shape here, without
  // it, would be the one stop a caller most needs the loop status at (a clean review is precisely the round
  // that would otherwise look done) and the one stop that omitted it.
  if (isQueuedAcceptStop(outcome)) {
    const { pr, repo } = outcome.run.input;
    const entry = buildAcceptQueueEntry({ repo, pr, runId: outcome.run.id });
    const resumeCmd = acceptResumeCommand({ runId: outcome.run.id, repo, pr });
    let filed = null;
    let filingError = null;
    try {
      filed = appendLearning(entry, { session });
    } catch (e) {
      // A FAILED FILING DOES NOT UN-PARK THE RUN. The run is still safely suspended — nothing was answered —
      // so the worst this costs is a human finding out later than they might have, never a wrongly-recorded
      // accept. Reported loudly rather than swallowed, because "the notification silently never went out" is
      // exactly the failure mode this branch exists to avoid.
      filingError = String(e?.message ?? e);
    }

    if (parsed.control.json) {
      const payload = {
        ...outcomePayload({ run: outcome.run, stopped: outcome.stopped, ownedBy: declaration.ownedBy }),
        queued: 'accept-needs-human',
        resumeCommand: resumeCmd,
        filedTo: filed ? filed.path : null,
        ...(filingError ? { filingError } : {}),
      };
      return { code: filingError ? 1 : 0, lines: [JSON.stringify(payload, null, 2)], run: outcome.run, stopped: outcome.stopped };
    }
    return {
      code: filingError ? 1 : 0,
      lines: [
        `run ${outcome.run.id} — QUEUED for a human: ${repo}#${pr}'s review reduced to ACCEPT.`,
        'An unattended agent actor never records an accept — that verdict now needs a human to clear it on '
        + 'their own time.',
        ...(filingError
          ? [`FAILED to file the learnings-pool notice: ${filingError}`]
          : [`filed → ${filed.path}`]),
        `clear it: ${resumeCmd}`,
      ],
      run: outcome.run,
      stopped: outcome.stopped,
    };
  }

  // ── THE PREVENTION-FILED BRANCH (#3442, #3434's second ratified item) — the run already auto-cleared to
  // `accept` (see `reviewLoopAutoConfirm`'s `PREVENTION_OUTSTANDING` branch): unlike the queued-accept branch
  // above, nothing is parked here — this only files the named guard(s) as the notification a human still
  // needs, mirroring that branch's file-then-notify shape, then falls through to the ordinary rendering below
  // (an `accept` outcome, same as a genuinely clean verdict would render) with the filing result spliced in.
  if (isPreventionOutstandingClear(outcome)) {
    const { pr, repo } = outcome.run.input;
    // PER-FINDING, NOT PER-RUN (review, finding 1). `buildPreventionQueueEntry` REFUSES rather than truncates
    // a guard whose own text overflows `FIELD_CAPS` (see that function) — a single oversized `prevention`
    // string must not (a) crash this whole invocation uncaught (the accept already recorded; a caller with no
    // try/catch of its own would get an unhandled rejection over a PR that already cleared) or (b) block filing
    // every OTHER guard in the same run that would have fit. So both the BUILD and the APPEND are inside one
    // try/catch, per finding — one bad guard's failure is isolated and reported, the rest still file.
    const filedPaths = [];
    const buildOrFileErrors = [];
    for (const finding of outcome.run.verdict.findings.filter(hasUncapturedPrevention)) {
      try {
        const entry = buildPreventionQueueEntry({ repo, pr, runId: outcome.run.id, finding });
        filedPaths.push(appendLearning(entry, { session }).path);
      } catch (e) {
        // NEITHER FAILURE UN-DOES THE ACCEPT — it already recorded. The worst this costs is a human finding
        // out about this one unfiled guard later than they might have; reported loudly rather than swallowed,
        // same posture as the queued-accept branch's own filing failure.
        buildOrFileErrors.push(String(e?.message ?? e));
      }
    }
    const filingError = buildOrFileErrors.length ? buildOrFileErrors.join('; ') : null;

    if (parsed.control.json) {
      // FIXED (independent review of PR #1784, CONFIRMED): this used to hardcode `code: filingError ? 1 : 0`,
      // ignoring `outcome.stopped` entirely — the SAME `renderOutcome`-bypass shape the plain-text branch
      // below never had (it already delegates to `rendered.code`, which IS `renderOutcome`'s own stopped-aware
      // value). `isPreventionOutstandingClear` narrows entry to this branch to the two genuine-success stops
      // (`'complete'`, `'effect-in-flight'`), so `baseCode` is 0 in the only cases this branch runs today —
      // but deriving it from `outcome.stopped`, the same success set `renderOutcome`'s own JSON path uses
      // (minus `'confirm'`, not reachable here), keeps this branch correct on its own terms rather than
      // correct only because a guard elsewhere happens to protect it.
      const baseCode = outcome.stopped === 'complete' || outcome.stopped === 'effect-in-flight' ? 0 : 1;
      const payload = {
        ...outcomePayload({ run: outcome.run, stopped: outcome.stopped, ownedBy: declaration.ownedBy }),
        preventionFiled: filedPaths,
        ...(filingError ? { preventionFilingError: filingError } : {}),
      };
      return { code: filingError ? 1 : baseCode, lines: [JSON.stringify(payload, null, 2)], run: outcome.run, stopped: outcome.stopped };
    }
    const rendered = renderOutcome({ outcome, json: false, declaration });
    return {
      code: filingError ? 1 : rendered.code,
      lines: [
        ...rendered.lines,
        '',
        `prevention-outstanding auto-cleared to accept — ${filedPaths.length} named guard(s) filed to the `
        + 'learnings pool:',
        ...filedPaths.map((p) => `  filed → ${p}`),
        ...(filingError ? [`FAILED to file (some guard(s) may be unfiled): ${filingError}`] : []),
      ],
      run: outcome.run,
      stopped: outcome.stopped,
    };
  }

  const rendered = renderOutcome({ outcome, json: parsed.control.json, declaration });
  // THE LOOP STATUS, NAMED IN WORDS, on a stop this file did not special-case (a bounce that landed, a stop
  // exhausted at the cap, an ordinary human-addressed park). `--json` already carries `run.verdict.loop`
  // inside the printed `verdict` field (via `outcomePayload`, which `renderOutcome` calls); this adds nothing
  // new to the record, only to what a human reads first.
  const loop = outcome.run?.verdict?.loop;
  const loopLine = (!parsed.control.json && loop && typeof loop === 'object')
    ? [`review loop: ${loop.outcome} — ${loop.why}`]
    : [];
  return { ...rendered, lines: [...rendered.lines, ...loopLine], run: outcome.run, stopped: outcome.stopped };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  // `argv` is known before the declaration `resolveOperation` binds sinks to — see `hasJsonFlag`'s doc
  // (`we:scripts/operations/cli-adapter.mjs`). A `--json` invocation must not have this file's own notice
  // effect (fired mid-run, well before the final JSON line below) land on the same stdout stream.
  const { declaration, registry, sinks } = resolveOperation(REVIEW_LOOP_OP, { json: hasJsonFlag(argv) });
  runReviewLoopOnce({
    declaration,
    registry,
    argv,
    store: createFileRunStore(),
    sinks,
    makeJudge: createCliJudgeFactory(),
    mintRunId: () => newRunId(declaration.name),
  })
    .then(({ code, lines }) => {
      writeAllSync(1, `${lines.join('\n')}\n`);
      process.exit(code);
    })
    .catch((e) => {
      writeAllSync(1, `error: ${String(e?.message ?? e)}\n`);
      process.exit(1);
    });
}

