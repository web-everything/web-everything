/**
 * @file scripts/conveyor/reconcile-finding.mjs
 * @description POST A SEQUENCING / CROSS-CUTTING-CONCERN FINDING from a mechanical or reconciliation agent —
 *   a rebase agent, a branch-sync pass, or anything doing cross-PR work that notices a PR conflicts with a
 *   decision made ELSEWHERE in the repo, a class of concern `we:scripts/operations/review-pr.mjs`'s correctness/
 *   security pass never checks for (it reviews a diff's own internal correctness, not whether landing it now is
 *   well-sequenced against a sibling decision on `main`).
 *
 * THE MOTIVATING INCIDENT (2026-09-05). While rebasing PR #1920 onto current `main`, an agent found that
 * `main`'s own resolution of a sibling item (`#2412`) had DELIBERATELY DEFERRED the exact feature #1920 builds
 * (`blockedBy: ["2410"]`, because nothing writes `redteam:accepted` to a live PR yet). #1920 builds that feature
 * anyway, unaware of the deferral — landing it as-is would introduce a hard-block on every engine-tier PR with no
 * way to satisfy it. That is a real, correctness-adjacent finding, but the independent `review-pr` pass would
 * never surface it (see above), and the rebase agent had no way to post it ON THE PR — only in its own private
 * task summary, so the operator had to ask twice before learning the concern existed at all.
 *
 * WHY THIS IS NOT A NEW LABEL OR A NEW COMMENT SCHEME (operator correction, same night, superseding an earlier
 * draft of this file that DID invent a bespoke `hold:sequencing` label). The right target for "this PR must not
 * land as-is" already exists and is already load-bearing: `review:changes`, applied through the SINGLE HOME of a
 * review-label swap, `we:scripts/review-set-label.mjs#runReviewLabelCli`. Reusing it, rather than adding a
 * parallel hold, buys three things for free:
 *   1. It is an ALREADY-UNDERSTOOD signal. The drain already refuses `ready-to-merge` on `review:changes`
 *      (`decideSetLabel`'s own `changes` branch strips `READY_TO_MERGE_LABEL`), exactly like any other bounce —
 *      no new drain-side rule was needed.
 *   2. It ROUTES INTO THE EXISTING FIX→RE-REVIEW CYCLE. `we:scripts/conveyor/reconcile-fix-dispatch.mjs` (#3438,
 *      wired into `we:skills-src/conveyor/runner.mjs`'s mechanical passes) already scans every open PR each tick
 *      and auto-dispatches a fix agent for a `review:changes` PR with a real finding and nothing live working it
 *      — so a finding posted THIS way is picked up by the normal automated bounce-and-fix loop, not a bespoke
 *      pathway only this file's caller knows about.
 *   3. It CANNOT be used to self-approve or bypass review. `decideSetLabel({ to: 'changes' })` never emits
 *      `review:accepted` and never removes `review:human` — a bounce lands nothing, ever, by construction in the
 *      pure core this file has no way to route around (this file pins `fixedTo: 'changes'`; nothing here can
 *      reach `accepted` or `clear-human`, both refused unless a proven-independent human/session clears them).
 *      Same spirit as `review:human` never being agent-clearable (#2844/#2895).
 *
 * WHAT THIS FILE ACTUALLY ADDS, THEN — NOT A NEW MECHANISM, A DECLARED, EASY-TO-REACH SHAPE FOR ONE CALLER. Any
 * agent invoking `we:scripts/review-set-label.mjs` directly for this purpose would need to independently
 * discover: that `--to=changes` requires `--body-file`; where a body file may legally live (`checkBodyFileLocation`
 * / `bodyFileRoots`); and that a hand-written body (no rendered `### Findings (N)` heading) is exempt from the
 * #3334 reasonless-bounce guard by design, so a prose finding never needs to fake that heading. This file is a
 * THIN SHIM — the exact shape `we:scripts/conveyor/rearm-review.mjs` already uses for the sibling `rearm` target
 * — that folds those facts into one obvious call so a reconciliation agent mid-task reaches this in one command:
 *   `node we:scripts/conveyor/reconcile-finding.mjs <pr> --body-file=<path to the write-up> [--repo=<owner/name>]
 *      [--agent=<calling agent/task name>] [--channel=<surface>]`
 * `--repo` is OPTIONAL — a reconciliation agent typically runs inside the PR's own lane clone, so a missing
 * `--repo` derives from `cwd` (`repoOptional: true`, same as `rearm-review.mjs`). Only `decideSetLabel`, the
 * comment banner below, and the default actor/channel differ from the shared harness; every invariant (INVARIANT
 * 2, the self-clear refusal, the size guard, the OPEN-state gate) is inherited unchanged from
 * `runReviewLabelCli`.
 *
 * THE COMMENT IS DELIBERATELY LABELLED AS A DIFFERENT KIND OF FINDING FROM A REVIEW VERDICT. It still renders
 * through `buildVerdictComment` (so it gets the SAME marker-forgery render boundary every other verdict comment
 * gets — free text in this file's `--body-file` is neutralized exactly like a reviewer's write-up is), but the
 * body is prefixed with {@link RECONCILE_FINDING_BANNER}, so a reader — human or the fix-dispatch agent that
 * picks this PR up next — sees immediately that this bounce came from a mechanical/reconciliation pass raising a
 * SEQUENCING concern, not from the correctness/security review path.
 *
 * NO AUTO-CLEAR. Unlike `we:scripts/conveyor/parked-pr-conflict-watch.mjs`'s `merge-status:conflicting` label
 * (which self-heals the moment the underlying `mergeable` state changes), a sequencing conflict against a
 * sibling decision has no single mechanically-correct resolution — clearing it means a human or an agent judging
 * the sequencing question, deciding whether to rebase around it, wait for the blocker, or re-scope the PR. That
 * judgment is exactly what `review:changes` already exists to park behind, and clearing it takes the same
 * `--to=accepted` (or a fix + `rearm`) path as any other bounce — never something this file can do itself.
 */
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  runReviewLabelCli, buildVerdictComment, checkBodyFileLocation, bodyFileRoots,
} from '../review-set-label.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';

/**
 * we:scripts/conveyor/reconcile-finding.mjs#RECONCILE_FINDING_BANNER — the fixed lead-in every finding posted
 * through this file carries, so the rendered comment names its own kind before a reader (human or the
 * fix-dispatch agent) reaches the finding itself. PURE constant, no caller input.
 */
export const RECONCILE_FINDING_BANNER = [
  '**⚠️ Sequencing / cross-cutting-concern finding — not a correctness/security review verdict.**',
  '',
  'This `review:changes` bounce was raised by a mechanical or reconciliation task (a rebase, a branch-sync '
    + 'pass, or other cross-PR work) that found either (a) this PR conflicts with a decision made ELSEWHERE in '
    + 'the repo, or (b) this PR has drifted into a real GIT merge conflict against `main` — the kind of concern '
    + 'the normal correctness/security review pass does not check for, because that pass reviews this diff\'s '
    + 'own internal correctness, not whether it is well-sequenced or still cleanly mergeable against what has '
    + 'landed on `main` since.',
].join('\n');

/**
 * we:scripts/conveyor/reconcile-finding.mjs#buildReconcileFindingBody — prefix the caller's raw write-up with
 * {@link RECONCILE_FINDING_BANNER}. PURE. Kept separate from the banner constant so a test can assert the join
 * without re-deriving it, and so the CLI and `buildComment` below render byte-identical bodies from one call.
 * @param {string} findingText - the caller's own write-up (what was found, the evidence, the citation).
 * @returns {string}
 */
export function buildReconcileFindingBody(findingText) {
  return `${RECONCILE_FINDING_BANNER}\n\n${String(findingText ?? '').trim()}`;
}

/**
 * we:scripts/conveyor/reconcile-finding.mjs#defaultReconcileActor — the `--actor` default rendered into the
 * durable comment's attribution line. PURE. An `--agent=` name is folded in when given (so the record says WHICH
 * mechanical task raised it, e.g. "the #1920 rebase agent"), else the generic label stands alone — never a
 * literal `undefined`.
 * @param {string} [agent]
 * @returns {string}
 */
export function defaultReconcileActor(agent) {
  const trimmed = String(agent ?? '').trim();
  return trimmed ? `${trimmed} (a mechanical reconciliation pass)` : 'a mechanical reconciliation pass';
}

/** The channel rendered into the comment's attribution when the caller supplies none. */
export const DEFAULT_RECONCILE_CHANNEL = 'a mechanical reconciliation/cross-cutting-concern pass';

/**
 * we:scripts/conveyor/reconcile-finding.mjs#runReconcileFindingCli — the IO shell: read + validate `--body-file`
 * (the same allowlist `we:scripts/review-set-label.mjs`'s own CLI enforces, reused rather than re-declared), then
 * hand off to the shared `runReviewLabelCli` harness with `fixedTo: 'changes'` pinned. Every input is injectable
 * so this is testable without a real `gh` on PATH or a real file on disk — mirrors
 * `we:scripts/conveyor/parked-pr-conflict-watch.mjs`'s own injection shape.
 * @param {{argv?:string[], readFile?:Function, emit?:Function, provider?:object,
 *   locateBodyFile?:(abs:string, roots:string[])=>{ok:boolean, roots?:string[]}, roots?:string[]}} [o]
 */
export function runReconcileFindingCli({
  argv = process.argv.slice(2),
  readFile = readFileSync,
  emit = (line) => writeAllSync(1, line),
  provider = undefined,
  locateBodyFile = checkBodyFileLocation,
  roots = bodyFileRoots(),
  beforeWrite,
  writerOptions = {},
} = {}) {
  const fail = (message, code = 2) => { emit(`${JSON.stringify({ error: message })}\n`); process.exit(code); };
  const usage = 'usage: reconcile-finding.mjs <pr> --body-file=<path to the finding write-up> '
    + '[--repo=<owner/name>] [--agent=<calling agent/task name>] [--channel=<surface>]  '
    + '(pr must be a positive integer; --body-file is REQUIRED — this is always a bounce, never a clear)';

  // Same rule as review-set-label.mjs's own CLI: the bare space-separated form is refused, not silently ignored.
  if (argv.includes('--body-file')) fail('use --body-file=<path> (the =-form) — the space-separated form is not accepted');
  const bodyFileArg = (argv.find((a) => a.startsWith('--body-file=')) || '').slice('--body-file='.length);
  if (!bodyFileArg) fail(usage);

  // #2882's allowlist, reused verbatim: this file's contents are published to a PUBLIC PR and cannot be
  // unpublished, so the path is constrained to the repo root or a temp dir exactly like every other caller of
  // `--body-file` in this repo.
  const abs = resolve(bodyFileArg);
  const located = locateBodyFile(abs, roots);
  if (!located.ok) {
    fail(`--body-file must live under the repo root or a temp dir (got ${abs}) — its contents are published to `
      + `a public PR, so the path is constrained. Allowed roots: ${located.roots.join(', ')}`);
  }
  let raw;
  try { raw = readFile(abs, 'utf8'); }
  catch (e) { fail(`--body-file=${bodyFileArg} is unreadable (${String((e && e.message) || e).split('\n')[0]})`); }
  if (!String(raw ?? '').trim()) {
    fail(`--body-file=${bodyFileArg} is empty — pass the actual finding write-up (what was found, the evidence, `
      + 'the citation); nothing was changed');
  }

  const agentArg = (argv.find((a) => a.startsWith('--agent=')) || '').slice('--agent='.length);
  // `--channel`, READ HERE AND CLOSED OVER — NOT DESTRUCTURED FROM `buildComment`'s ARGUMENTS. Same trap
  // `we:scripts/review-set-label.mjs`'s own CLI already routes around: `runReviewLabelCli` calls
  // `buildComment({ to, actor, decision, headSha, reason, reviewedDiff, clearerId, independence })` — `channel`
  // is NOT one of those fields (the harness reads its own `--channel` only for the #3007 ledger row), so a
  // `buildComment` that destructured `channel` off that call would always see `undefined` and silently render the
  // default. review-set-label.mjs's own CLI reads `--channel` itself, once, and closes over it; this does the same.
  const channelArg = (argv.find((a) => a.startsWith('--channel=')) || '').slice('--channel='.length);
  const verdictBody = buildReconcileFindingBody(raw);

  runReviewLabelCli({
    ...writerOptions,
    beforeWrite,
    argv,
    emit,
    // `provider` is passed through only when the caller supplied one — omitting the key lets
    // `runReviewLabelCli`'s own default (`createGhProvider()`) apply, exactly as every other real CLI entrypoint
    // in this repo does; a test supplies a fake.
    ...(provider ? { provider } : {}),
    fixedTo: 'changes',
    defaultActor: defaultReconcileActor(agentArg),
    repoOptional: true, // a reconciliation agent runs inside the PR's own lane clone; cwd IS that repo.
    usage,
    // Handed to the shared harness so its own #xd6moh1 non-empty check and #3334 reasonless-bounce evidence read
    // the SAME bytes `buildComment` renders below — this file's body is always hand-written prose (never a
    // rendered `### Findings (N)` heading), which `bounceEvidenceFromWriteUp` reads as an UNKNOWN finding count
    // and therefore never refuses (see that function's own doc: only a RENDERED write-up can assert "zero findings").
    verdictBody,
    buildComment: ({ actor }) => buildVerdictComment({
      to: 'changes',
      actor,
      channel: channelArg || DEFAULT_RECONCILE_CHANNEL,
      body: verdictBody,
    }),
    successResult: ({ pr, labels }) => ({ ok: true, pr, to: 'changes', kind: 'reconcile-finding', labels }),
    refusalResult: ({ pr, decision }) => ({ ok: false, pr, reason: decision.reason }),
  });
}

// we:scripts/conveyor/reconcile-finding.mjs — allow importing the pure helpers + the IO shell without running the
// CLI (the test file imports this module). The standard main check used across the conveyor scripts.
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  runReconcileFindingCli();
}
