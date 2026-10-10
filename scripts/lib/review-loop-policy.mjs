import { createHash } from 'node:crypto';
import { preventionCardTitle } from '../operations/machine-pr-title.mjs';
import { isValidRoundBudget } from './review-settings.mjs';
/**
 * @file scripts/lib/review-loop-policy.mjs
 * @description THE CONCRETE UNATTENDED-CONFIRM POLICY for `review-pr` (#3072's remaining slice) — and the pure
 * decision for what an unattended run does when its own verdict would otherwise ACCEPT (#3072 / #3279).
 *
 * WHAT ALREADY EXISTED BEFORE THIS FILE, AND WHY IT WAS NOT ENOUGH. `driveRun`'s `autoConfirm` SEAM
 * (`we:scripts/operations/cli-adapter.mjs`, "#3072 third slice", landed 2026-08-12) is generic machinery: a
 * function of `(pending, run)` that MAY answer an AGENT-addressed confirm and MUST decline (return `null`) a
 * HUMAN-addressed one. Nothing shipped a CONCRETE policy — every caller, production and test, either supplied
 * none or a test-local stub built to prove the mechanism works (`we:scripts/operations/__tests__/review-pr.
 * test.mjs`'s `agentOnly`), and that stub answers `accept` unattended, which is exactly the case the operator's
 * 2026-08-31 ruling (below) forbids. This file is the first PRODUCTION policy, meant for a real loop driver
 * (`we:scripts/operations/review-loop-cli.mjs`) to pass to `driveRun`.
 *
 * THE ROUND CAP ITSELF NEEDED NO NEW CODE HERE. `deriveLoopOutcome` (`we:scripts/lib/jury-core.mjs`, "#3072
 * second slice", 2026-08-12) already computes `converged` / `in-progress` / `exhausted` / `escalated` per round
 * from the verdict ledger's own history (`read.priorRounds`), and `review-pr.mjs`'s `reduce` step already
 * stamps it onto `run.verdict.loop` on every run. A `stuck` fourth outcome was DESIGNED and then REFUSED on
 * evidence, in that same commit: the obvious detector (finding count stops shrinking) was tested against PR
 * #1164's real four-round history (3 → 1 → 1 → 1 findings) and would have killed the most productive review of
 * the week at round three. Telling thrashing from converging-slowly needs finding IDENTITY, which the ledger
 * does not record — a genuine input to a future observability spike, not something to approximate here. So
 * this file does not re-litigate that call; it reads `run.verdict.loop` as the settled fact it already is.
 *
 * THE 2026-08-31 RULING THIS FILE USED TO ENCODE, VERBATIM, NOW SUPERSEDED (operator, 2026-09-01, `#3434` /
 * `backlog/xpfuj64-*.md`, "I want the acceptance to be mechanical from the verdict" — found live: two real
 * PRs, `#1764` and `#1765`, both reduced to a clean `accept` during this same epic's own live-fire test and
 * sat queued for a human for no reason other than this policy's old refusal). The ORIGINAL ruling (2026-08-31)
 * said an AGENT actor may unattended-answer `changes` or `abstain` but must NEVER unattended-answer `accept`.
 * `#3434` REVERSES that specifically for the AGENT-addressed (`review:pending`) tier: a genuinely independent
 * `accept` now answers unattended, exactly like `changes` already did — a clean, independent verdict IS the
 * clearance. `review:human` is UNCHANGED and UNTOUCHED by this reversal: it never reaches the accept branch
 * below at all, because refusal 1 (the actor check) declines it first, same as always — that tier's own
 * human-only ceremony (`--to=clear-human`) is exactly what `#3434` confirmed should stay in place.
 *
 * #3442's SECOND RULING (below) IS NOW REVERSED AND REPLACED (2026-09-26, live incident
 * web-everything/web-everything#2749). That ruling had this policy answer `accept` unattended for a
 * `prevention-outstanding` verdict, on the theory that every actual finding was already resolved and only a
 * documentation debt remained. Live evidence says that reasoning does not hold: PR #2749 (and others merged the
 * same day) reduced to `prevention-outstanding` with BOTH mandatory lenses (correctness, security) reporting
 * real, confirmed, unfixed defects (a daemon-clone guard bypassable via `LANE_GUARD_OFF=1`, a chained `git -C`
 * guard hole, a non-realpathed symlink write hole) — `blocksAcceptance` only routes a mandatory lens's own
 * verdict to `prevention-outstanding` when EVERY finding it raised is "resolved" in the narrow #2823 sense of
 * "names a prevention guard", not in the sense of "the defect is fixed". The rendered PR comment for that exact
 * run says, in the SAME breath as `Decision: accept`, "**Verdict:** 🚩 prevention outstanding — file the guard
 * before accept" — an unattended accept over that verdict directly contradicts its own rendered text, and
 * `jury-core.mjs`'s own `VERDICTS` doc ("It never silently lands") already said this branch should not exist.
 *
 * FILING THE GUARD IS NOT A DECISION FOR AN OPERATOR (2026-09-26 scope ruling) — so this is NOT the
 * `review:human`-shaped "park and queue for a human" fix it might look like at first. `reviewLoopAutoConfirm`
 * below still DECLINES a `prevention-outstanding` verdict (it must: filing a card is impure I/O, and this
 * function stays PURE) — but the DECLINE is momentary, not a park. The IMPURE caller
 * (`we:scripts/operations/review-loop-cli.mjs`) sees the decline, mechanically FILES the owed guard(s) as ONE
 * real backlog card through the declared `file-item` operation (never a learnings-pool notice — that would be
 * surfacing a decision to a human, which this ruling explicitly forbids), cleared to the conveyor, and only
 * THEN resumes the SAME run with the `accept` the policy itself would not answer — the debt is now TRACKED, so
 * the #2823 "prevention-outstanding … blocks a clean accept … until … filed" gate is satisfied by construction,
 * with no human anywhere in the loop. Filing failure is the one case that still stops the accept: the run stays
 * parked and the failure is reported loudly (never swallowed) — see `review-loop-cli.mjs` for the mechanism.
 * {@link buildPreventionFilingInput} (below) is the PURE half of that: it derives the `file-item` operation's
 * own input (title/digest/scope/size) from the run's outstanding findings; {@link isPreventionOutstandingParked}
 * is the PURE predicate `review-loop-cli.mjs` uses to recognize the moment to do it.
 *
 * WHY THE (UNCHANGED) QUEUE BELOW REUSES `learnings-drop.mjs` AS-IS RATHER THAN EXTENDING ITS SCHEMA. `#3421` (the general
 * "approval-pending flag on a learnings-pool entry" mechanism) is NOT YET BUILT — it is still an open story
 * with its own scope. This file does not pre-build it: `learnings-drop.mjs`'s schema is a deliberate, narrow
 * ALLOW-LIST (`kind` / `summary` / `area` / `suggestion`, see that file's own header on why — "if the schema
 * has no field for it, it can't leak"), and adding an ad hoc `approvalPending` field here would both jump
 * #3421's own scope and give the pool a second, un-ratified shape for the same idea. The actual GATE — the
 * property that nothing here ever mechanically records an accept — is enforced in CODE, by construction
 * (see {@link reviewLoopAutoConfirm}): the learnings entry this file files is the NOTIFICATION layer only, so
 * a human actually notices the parked run instead of having to poll run records for it. The gate does not
 * depend on the notification being read; the notification exists so it usually is, promptly.
 *
 * PURE THROUGHOUT. No fs, no clock, no process — `driveRun` calls {@link reviewLoopAutoConfirm} directly, and
 * `review-loop-cli.mjs` is the only place {@link buildAcceptQueueEntry}'s output is actually appended anywhere.
 */

import { CONFIRM_ACTORS, CONFIRM_OPTIONS, REVIEW_EFFECTS } from '../operations/review-pr.mjs';
import { VERDICTS, hasUncapturedPrevention, normalizeFinding, requiresMandatoryReferral, DEFAULT_ROUND_CAP,
  MANDATORY_LENSES } from './jury-core.mjs';
import { findingHeldVerdict } from './review-round-rules.mjs';
import { FIELD_CAPS, KINDS } from '../conveyor/learnings-drop.mjs';
// #883 — every code-path reference filed into a backlog card's `scope` or BODY prose must carry its `<repo>:`
// locus prefix (the write-time `lint-locus-prefix.mjs` hook enforces this on every scaffold/file-item write,
// no exceptions) — `buildPreventionFilingInput` reuses the SAME token `citation-check.mjs` already exports
// rather than re-typing the literal `'we:'` a second place could drift from.
import { IN_REPO_LOCUS } from './citation-check.mjs';
// PR #2766 advisory (codex-correctness) — the SAME detector the write-time locus scan runs
// (`we:scripts/backlog/guarded-write.mjs#assertPublishableContent`), so the digest is fixed up against exactly
// what would refuse it, never a second guess at which tokens count as a path.
import { findUnmarkedLocusRefs } from '../check-standards-rules.mjs';

/**
 * THE ANSWER THIS POLICY MAY GIVE UNATTENDED, other than declining. `abstain` is deliberately NOT this policy's
 * choice even though the ruling permits it: `abstain` writes nothing (see `review-pr.mjs`'s `record` step), so
 * an unattended loop that abstained on every non-accept verdict would make no progress at all — indistinguishable
 * from a stop, except silent. `changes` is the one that lets the round-cap loop actually converge or exhaust,
 * which is the entire point of mechanizing it. The ruling's permission for `abstain` is exercised by a HUMAN
 * who reads a parked run and decides the review isn't worth recording either way — not by this policy.
 */
const UNATTENDED_ANSWER = CONFIRM_OPTIONS.includes('changes') ? 'changes' : (() => {
  throw new Error('review-loop-policy: `changes` is no longer one of review-pr\'s CONFIRM_OPTIONS — this policy has nothing safe to answer with');
})();

/**
 * THE POLICY. Matches `driveRun`'s `autoConfirm(pending, run)` contract exactly (`we:scripts/operations/
 * cli-adapter.mjs`): return `null` to decline (the run stays suspended, exactly as if no policy had been
 * supplied), or `{ value: <one of CONFIRM_OPTIONS> }` to answer.
 *
 * ONE REFUSAL, THEN TWO ANSWERS:
 *
 *   1. `pending.of !== CONFIRM_ACTORS.AGENT` → decline. A HUMAN-addressed confirm (`review:human`, gate-self)
 *      is precisely the case the step exists to stop for — see `review-pr.mjs`'s `of` derivation. This policy
 *      must not know better than that classification; it only ever activates on the tier the operation itself
 *      already decided is agent-answerable. UNCHANGED by `#3434` — `review:human` never reaches the branches
 *      below at all; its own human-only ceremony (`--to=clear-human`) is exactly what `#3434` confirmed stays.
 *   2. `run.verdict.verdict === VERDICTS.ACCEPT` → answer `accept`. A genuinely independent, clean verdict on
 *      the AGENT-addressed (`review:pending`) tier IS the clearance — `#3434` (2026-09-01) reversed the prior
 *      2026-08-31 ruling that declined here unconditionally, found live-fire against two real PRs (`#1764`,
 *      `#1765`) both queued for no reason other than this line.
 *
 *   3. `run.verdict.verdict === VERDICTS.PREVENTION_OUTSTANDING` → DECLINE (`#3442`'s auto-accept REVERSED,
 *      2026-09-26, live incident web-everything/web-everything#2749 — see the file header for the full account). This
 *      function stays PURE, so it cannot itself file the owed guard(s) — that is impure I/O, and filing it is
 *      NOT a decision for a human either (see the file header's 2026-09-26 scope ruling). The DECLINE here is
 *      momentary: `review-loop-cli.mjs` reads it via {@link isPreventionOutstandingParked}, mechanically files
 *      the card through `file-item`, and resumes THIS SAME run with `accept` itself — no human anywhere in the
 *      loop, and no re-entry into the round loop either (`changes` would be wrong too: no editor round can file
 *      a guard, matching `deriveNegotiationOutcome`/`derivePlanOutcome`'s own posture for this verdict).
 *
 * EVERYTHING ELSE (`changes`, `needs-human` reaching here at all, any future verdict this fails open on)
 * answers `changes` — safe and reversible by construction, since `record`'s own reasonless-bounce guard only
 * refuses a `changes` answer when the juror(s) returned ZERO findings, and a non-accept, non-prevention verdict
 * from `derivePanelVerdict` implies at least one admitted finding drove it (see that guard in `review-pr.mjs`'s
 * `record` step) — so this policy never needs to compose a `--reason` of its own to satisfy it.
 *
 * @verdicts-partial `changes` and `needs-human` are never referenced by name: BOTH intentionally fall through
 * to the SAME `UNATTENDED_ANSWER` branch above (undeclared-verdict fail-safe included) rather than earning
 * their own `=== VERDICTS.X` line — `needs-human` cannot reach this function's body at all in practice (refusal
 * 1 always declines a HUMAN-addressed confirm first), so writing a branch for it would assert a case this
 * policy structurally never sees. Only `accept` is the one REVIEWED, RATIFIED mechanical-answer branch this
 * file's own canary test (`review-loop-policy.test.mjs`) pins to; `prevention-outstanding` is a REVIEWED,
 * RATIFIED DECLINE (see the file header — #3442's mechanical-accept for this verdict is reversed).
 *
 * @param {{of?: string}|null} pending - the run's `pending` record at an `awaiting-confirm` stop.
 * @param {{verdict?: {verdict?: string}}} run - the run so far; `run.verdict` is `reduce`'s full finding.
 * @returns {{value: string}|null}
 */
export function reviewLoopAutoConfirm(pending, run) {
  if (run?.verdict?.pendingReferrals?.length) return null;
  if (!pending || pending.of !== CONFIRM_ACTORS.AGENT) return null;
  // Cards 5471 / 5470 — a later round whose findings the round rules turn into cards DECLINES here, like
  // prevention-outstanding: filing the cards is impure, so `review-loop-cli.mjs` files them (see
  // {@link isRoundCardsParked}) and only then resumes this run with the accept. Never a `changes` bounce.
  if (roundCardsDecision(run).apply) return null;
  if (run?.verdict?.verdict === VERDICTS.ACCEPT) return { value: 'accept' };
  // #2749 FIX — `prevention-outstanding` NEVER auto-answers `accept` (nor `changes`: no editor round can file a
  // guard). DECLINE, same as a human-addressed confirm, so the run stays parked for an operator to file the
  // named guard(s) and clear it themselves via `--answer=accept` — never a mechanical accept over a verdict
  // whose own rendered text says "file the guard before accept".
  if (run?.verdict?.verdict === VERDICTS.PREVENTION_OUTSTANDING) return null;
  return { value: UNATTENDED_ANSWER };
}

/** Where a queued-accept entry is filed from, for a reader of the pool who has never heard of this operation. */
export const ACCEPT_QUEUE_AREA = 'review-loop unattended confirm (#3279)';

/**
 * THE RESUME COMMAND a human runs to actually clear a queued accept — printed inside the queue entry's
 * `suggestion` field AND by `review-loop-cli.mjs` at the moment it parks, so the two never say two different
 * things. PURE string composition; the command itself is exactly what `we:scripts/operations/run.mjs`'s own
 * header documents as the `--answer=accept` resume shape.
 *
 * @param {{runId: string, repo: string, pr: number|string}} o
 * @returns {string}
 */
export function acceptResumeCommand({ runId, repo, pr } = {}) {
  return `node scripts/operations/run.mjs review-pr --resume=${runId} --answer=accept`
    + ` # ${repo}#${pr} — clears it; --answer=changes bounces it instead`;
}

/**
 * BUILD the learnings-pool entry filed when an unattended, agent-addressed run parks on what would otherwise
 * be an ACCEPT. PURE — returns the entry object; {@link module:review-loop-cli} is the only impure caller,
 * via `learnings-drop.mjs#appendEntry`.
 *
 * SHAPED TO `learnings-drop.mjs`'s EXISTING, UNEXTENDED SCHEMA (see the file header for why): `kind: 'friction'`
 * — an unattended review being unable to act on its own clean verdict is exactly what that kind means elsewhere
 * in the pool (a place the mechanized loop had to stop and hand back to a person). `summary` and `suggestion`
 * are kept well under `FIELD_CAPS` (asserted by a test that pins this against the live caps, not a copy of the
 * numbers) so a long repo slug or a large run id can never overflow either field.
 *
 * @param {{repo: string, pr: number|string, runId: string}} o
 * @returns {{kind: string, summary: string, area: string, suggestion: string}}
 */
export function buildAcceptQueueEntry({ repo, pr, runId } = {}) {
  const subject = `${repo}#${pr}`;
  const entry = {
    kind: 'friction',
    summary: `${subject}'s independent review reduced to ACCEPT; an unattended agent never records that — `
      + 'a human needs to clear it.',
    area: ACCEPT_QUEUE_AREA,
    suggestion: acceptResumeCommand({ runId, repo, pr }),
  };
  // A DEFENSIVE ASSERTION, NOT A SILENT TRUNCATION. Cutting a resume command short to fit a cap would hand a
  // human a broken command instead of a working one — worse than refusing outright, which at least fails
  // loudly at the moment it happens rather than the moment someone pastes a truncated `--resume=` flag.
  for (const [field, cap] of Object.entries(FIELD_CAPS)) {
    if (entry[field].length > cap) {
      throw new Error(
        `review-loop-policy: the queued-accept entry's \`${field}\` is ${entry[field].length} chars, over the `
        + `pool's ${cap}-char cap — ${JSON.stringify(subject)} or the run id is unusually long. Refusing to `
        + 'truncate a value a human will act on; shorten the inputs or widen the cap deliberately.',
      );
    }
  }
  if (!KINDS.includes(entry.kind)) {
    throw new Error(`review-loop-policy: 'friction' is no longer one of learnings-drop's KINDS (${KINDS.join(', ')}) — pick a live one`);
  }
  return entry;
}

/**
 * IS THIS STOP THE "QUEUED FOR HUMAN ACCEPT" CASE? PURE — the one fact `review-loop-cli.mjs` needs to decide
 * whether to file {@link buildAcceptQueueEntry} and print the queued message, versus rendering a `driveRun`
 * outcome exactly as the ordinary CLI does.
 *
 * DELIBERATELY NOT a re-invocation of {@link reviewLoopAutoConfirm} — the policy already ran (it is what
 * produced this stop); this reads the SAME two facts the policy decided on, off the record the policy left
 * behind, so the two can never drift into disagreeing about why the run parked.
 *
 * `VERDICTS.ACCEPT` ONLY. `prevention-outstanding` does NOT reach this predicate (see {@link
 * isPreventionOutstandingParked} instead) — the 2026-09-26 scope ruling (file header) is explicit that filing
 * the owed guard is not a decision for an operator, so that verdict's park is never queued for a HUMAN at all;
 * it is handled mechanically, entirely inside `review-loop-cli.mjs`, before this predicate is ever consulted.
 *
 * @param {{stopped?: string, run?: {pending?: {of?: string}, verdict?: {verdict?: string}}}} outcome -
 *   a `driveRun` outcome.
 * @returns {boolean}
 */
export function isQueuedAcceptStop(outcome) {
  return outcome?.stopped === 'confirm'
    && outcome?.run?.pending?.of === CONFIRM_ACTORS.AGENT
    && outcome?.run?.verdict?.verdict === VERDICTS.ACCEPT;
}

/**
 * IS THIS THE MOMENT TO MECHANICALLY FILE THE OWED PREVENTION CARD? PURE — the one fact `review-loop-cli.mjs`
 * needs to decide whether to file {@link buildPreventionFilingInput}'s card through `file-item` and then resume
 * this same run with `accept`, versus rendering a `driveRun` outcome exactly as the ordinary CLI does (a
 * `review:human` PR carrying this same verdict, where `pending.of` is `'human'`, is NOT this case — its own
 * `--to=clear-human` ceremony is untouched, per INVARIANT 2).
 *
 * DELIBERATELY NOT a re-invocation of {@link reviewLoopAutoConfirm} — the policy already ran (it is what
 * produced this stop); this reads the SAME two facts the policy decided on, off the record the policy left
 * behind, so the two can never drift into disagreeing about why the run parked.
 *
 * @param {{stopped?: string, run?: {pending?: {of?: string}, verdict?: {verdict?: string}}}} outcome -
 *   a `driveRun` outcome.
 * @returns {boolean}
 */
export function isPreventionOutstandingParked(outcome) {
  return outcome?.stopped === 'confirm'
    && outcome?.run?.pending?.of === CONFIRM_ACTORS.AGENT
    && outcome?.run?.verdict?.verdict === VERDICTS.PREVENTION_OUTSTANDING;
}

/**
 * BUILD the `file-item` operation's own input for ONE mechanically-filed backlog card covering EVERY
 * outstanding (uncaptured) prevention guard in a `prevention-outstanding` verdict (#2749 scope ruling: filing
 * this is not a human decision — the loop does it itself, through the declared `file-item` operation). PURE —
 * returns the input object; {@link module:review-loop-cli} is the only impure caller, via `file-item`'s own
 * declaration.
 *
 * ONE CARD PER RUN, not one per guard: several findings in the SAME run usually name guards for the same
 * handful of files (see #2749 itself: five findings, two files), so `scope` is the UNION of every uncaptured
 * finding's own `file` plus, heuristically, that file's own test sibling (`<dir>/__tests__/<stem>.test.mjs`) —
 * a single card whose scope spans the whole area a fix-lane would touch is more useful to a builder than N
 * one-line cards that all touch the same two files and fight over lane ownership. `digest` renders one
 * numbered line per guard, each carrying the file (and line, when the finding named one) and the prevention
 * text itself verbatim, so a reader of the filed card sees exactly what a fixer needs without re-opening the
 * original PR.
 *
 * @param {{repo: string, pr: number|string, findings?: Array<object>, parent?: string, queue?: string}} o -
 *   `parent` is the epic/story this card should nest under, when the caller knows one (optional — `file-item`
 *   itself treats an absent parent as top-level). `queue` mirrors `file-item`'s own `--queue` input
 *   (`'true'`/`'false'`); defaults to `'true'` ("cleared to the conveyor", the 2026-09-26 ruling's own words) —
 *   a caller filing this OUTSIDE the conveyor's own sanctioned checkout (a one-off proof run, never the
 *   production loop) passes `'false'` to avoid mutating the live runner's queue store. `head` (PR #2766) is the
 *   pinned commit the review judged; when given, the digest names it via {@link preventionHeadMarker}, which is
 *   the STABLE key a retry on the same head uses to find this card again — the juror's own prose is not,
 *   because a fresh round spawns fresh jurors that word the same guard differently.
 * @returns {{title: string, kind: string, size: string, digest: string, scope: string, parent: string, queue: string}}
 */
export function buildPreventionFilingInput({ repo, pr, findings = [], parent = '', queue = 'true', head = null } = {}) {
  const owed = (Array.isArray(findings) ? findings : []).filter(hasUncapturedPrevention);
  // PR #2766 advisory (security): only a CLEAN repo path reaches `scope` — `renderItem` writes scope entries
  // into the card's frontmatter unescaped, so a juror `file` carrying a quote or newline could inject keys.
  const files = [...new Set(owed.map(cleanFindingFile).filter(Boolean))];
  // `null` for a file that is ALREADY test code (under `__tests__/`, or a `*.test.*`/`*.spec.*` file) — its
  // own sibling is itself, and appending another `__tests__/…test` produced a nonexistent
  // `__tests__/__tests__/x.test.test.mjs` path.
  const testSiblingOf = (f) => {
    const slash = f.lastIndexOf('/');
    const dir = slash === -1 ? '.' : f.slice(0, slash);
    const base = slash === -1 ? f : f.slice(slash + 1);
    if (/(^|\/)__tests__(\/|$)/.test(dir) || /\.(test|spec)\.[cm]?[jt]s$/.test(base)) return null;
    // Only a JS/TS-family source has a `__tests__/<stem>.test.mjs` sibling — a .yml/.sh/.json/.md cited file
    // would otherwise get a phantom scope entry that never exists (PR #2767 advisory).
    if (!/\.[cm]?[jt]s$/.test(base)) return null;
    const stem = base.replace(/\.[cm]?[jt]s$/, '');
    // PR #2766 advisory (antigravity): a top-level file's sibling is `__tests__/…`, never `./__tests__/…`.
    return `${dir === '.' ? '' : `${dir}/`}__tests__/${stem}.test.mjs`;
  };
  // #883 — EVERY entry, in `scope` AND in the digest's backticked paths, carries the `we:` locus prefix: a
  // bare path is refused at write time (`lint-locus-prefix.mjs`) for BOTH surfaces (`check-standards.mjs`'s
  // own scope-entry rule cites the identical card, #883, as the scope-lease engine's reason a bare entry is
  // unsafe: unqualified, it reads as repo `null` and never matches an observed `we:`-qualified file).
  const scope = [...new Set([...files, ...files.map(testSiblingOf).filter(Boolean)])]
    .map((f) => `${IN_REPO_LOCUS}${f}`).join(',');
  const digestLines = owed.map((f, i) => (
    `${i + 1}. ${cleanFindingFile(f) ? `${preventionGuardAnchor(f)} — ${guardText(f) || '(no guard text recorded)'}` : preventionGuardAnchor(f)}`
  ));
  const digestRaw = `Filed mechanically by the unattended review loop (#2749) — every finding below reduced `
    + `${repo}#${pr}'s review${head ? ` (${preventionHeadMarker(head)})` : ''} to prevention-outstanding by `
    + 'naming a guard neither captured nor filed:\n\n'
    + digestLines.join('\n');
  const digest = qualifyLocusRefs(digestRaw, files);
  return {
    title: preventionCardTitle({ repo, pr, digest }),
    kind: 'story',
    size: '3',
    digest,
    scope,
    parent: parent || '',
    queue: queue === 'false' || queue === false ? 'false' : 'true',
  };
}

/**
 * PREFIX EVERY BARE REPO PATH in card prose with the `we:` locus (#883), so the write-time locus scan never refuses a
 * mechanically filed card. PURE. Shared by {@link buildPreventionFilingInput} and {@link buildRoundCardsFilingInput}.
 *
 * @param {string} text - the raw digest.
 * @param {string[]} files - the clean repo paths the card cites (their bare basenames are qualified too).
 * @returns {string}
 */
export function qualifyLocusRefs(text, files = []) {
  // #883 SAFETY NET — a juror's own `prevention` PROSE can casually re-mention a file this card already cites
  // by its bare basename with no locus prefix at all (live example: PR #2749's actual finding 3 text says
  // "…mirroring how guard-lane.mjs already receives a pre-realpath'd real from its caller" — no backticks, no
  // prefix). The explicit `file:line` anchor built above is prefixed already; this closes the OTHER surface —
  // free prose — for exactly the files THIS card's own `scope` already names (never a blind scan of arbitrary
  // text for anything extension-shaped, which would risk over-matching unrelated words). A mention already
  // carrying a locus prefix, or already part of a longer `dir/basename` path, is left alone (the negative
  // lookbehind on `we:`/`fui:`/`plateau:`/`/`).
  const basenamesQualified = files.reduce((text, f) => {
    const base = f.includes('/') ? f.slice(f.lastIndexOf('/') + 1) : f;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `-`/`.` in the lookarounds too (PR #2766 self-review): `\b` alone treats `-` as a boundary, so citing
    // `lane.mjs` used to splice a prefix into the middle of `guard-lane.mjs`. A `.` only ends the name when no
    // word follows it (PR #2766 advisory): `lane.mjs.bak` is a longer name, `…fix lane.mjs.` ends a sentence.
    return text.replace(new RegExp(`(?<!we:|fui:|plateau:)(?<![\\w/.-])${escaped}(?![\\w-]|\\.\\w)`, 'g'), `${IN_REPO_LOCUS}${f}`);
  }, String(text ?? ''));
  // PR #2766 advisory (codex-correctness, reproduced) — the basename pass above deliberately skips a name that
  // is already part of a longer `dir/basename` path, so a FULL bare path in juror prose (a test file, or a file
  // this card never cites at all) survived unprefixed and the write-time scan refused the whole card, leaving
  // the run parked. Second pass: prefix every token the real detector still flags. Longest first, and never
  // inside a longer token or after an existing `<repo>:` prefix (only a REPO prefix — any other colon, as in
  // `Files:scripts/z.mjs`, is still flagged by the detector, so it must still be prefixed).
  return findUnmarkedLocusRefs(basenamesQualified)
    .sort((a, b) => b.length - a.length)
    .reduce((text, ref) => {
      const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text.replace(
        new RegExp(`(?<!(?:we|fui|plateau|webeverything|frontierui|plateau-app):)(?<![\\w./-])${escaped}(?![\\w/-])`, 'g'),
        `${IN_REPO_LOCUS}${ref}`,
      );
    }, basenamesQualified);
}

/**
 * THE TEXT A FILED PREVENTION CARD CARRIES TO NAME THE HEAD IT WAS FILED FOR (PR #2766). PURE. One home, so the
 * builder that writes it and `review-loop-cli.mjs#findFiledPreventionCard` that looks for it cannot drift.
 *
 * @param {string} head - a pinned 40-hex commit.
 * @returns {string}
 */
export function preventionHeadMarker(head) {
  return `reviewed head \`${head}\``;
}

/**
 * A finding's `file`, when it is a CLEAN repo-relative path — else `null`. PURE. Juror output is untrusted:
 * a quote, newline, comma, backslash, space, other colon, leading `/` or a `..` segment is refused, since the
 * value lands in the filed card's frontmatter `scope` (PR #2766 advisory, security). This repo's own `we:`
 * prefix and a leading `./` are stripped first, so a juror citing the house locus format keeps its file.
 *
 * @param {{file?: unknown}} f
 * @returns {string|null}
 */
export function cleanFindingFile(f) {
  if (typeof f?.file !== 'string') return null;
  // Jurors' ordinary path forms are normalized FIRST, the same way `we:scripts/lib/jury-core.mjs#corroborationPath`
  // does (a diff `a/`/`b/` prefix, a trailing `:line`/`:line:col` — PR #2767 advisory), so a legitimate citation
  // is kept rather than withheld.
  const file = f.file.trim().replace(new RegExp(`^${IN_REPO_LOCUS}`), '').replace(/^(?:\.\/)+/, '')
    .replace(/^[ab]\//, '').replace(/:\d+(?::\d+)?$/, '');
  return /^[\w.@+-]+(?:\/[\w.@+-]+)*$/.test(file) && !file.split('/').includes('..') ? file : null;
}

/** Where the digest says a guard cited no file at all. */
const NO_FILE_CITED = '`(no file cited)`';
/** Where the digest says a guard cited a `file` that is not a clean path — withheld, never echoed (PR #2767). */
const FILE_WITHHELD = '`(cited file withheld: not a plain path)`';

/**
 * THE PER-GUARD DUPLICATE KEY (PR #2766 advisory). PURE. For a guard citing a clean file, the backticked
 * `` `we:<file>[:<line>]` `` anchor {@link buildPreventionFilingInput} writes into the digest — stable across a
 * fresh jury that rewords the same guard, and distinct for a guard at a new location (the closing backtick keeps
 * `:1` from matching `:12`). With no clean file, the guard's whole digest line is the only key left, so a
 * reworded no-file guard is filed again: over-filing is the safe direction, skipping a guard is not.
 *
 * @param {{file?: unknown, line?: unknown, prevention?: unknown}} f
 * @returns {string}
 */
export function preventionGuardAnchor(f) {
  const file = cleanFindingFile(f);
  if (!file) {
    const marker = typeof f?.file === 'string' && f.file.trim() ? FILE_WITHHELD : NO_FILE_CITED;
    return `${marker} — ${guardText(f) || '(no guard text recorded)'}`;
  }
  // A juror citing `file: 'x.mjs:10'` with no `line` keeps its line (cleanFindingFile strips it off the path):
  // without it, two guards in one file would share one duplicate key and the second would never be filed.
  const line = typeof f.line === 'number' ? f.line : f.file.trim().match(/:(\d+)(?::\d+)?$/)?.[1];
  return `\`${IN_REPO_LOCUS}${file}${line != null ? `:${line}` : ''}\``;
}

/**
 * DOES THIS FILED CARD'S TEXT ALREADY CARRY THIS GUARD? PURE (PR #2766 advisory). Compares with every locus
 * prefix removed, because the digest's locus pass rewrites bare paths inside a no-file guard's text; a no-file
 * anchor must also end its line, so the text `z` never matches a card line `… — zebra`.
 *
 * @param {string} cardText
 * @param {object} f - a finding.
 * @returns {boolean}
 */
export function cardCoversGuard(cardText, f) {
  const strip = (s) => String(s).replace(/(?<![\w-])(?:we|fui|plateau|webeverything|frontierui|plateau-app):/g, '');
  const anchor = strip(preventionGuardAnchor(f));
  return `${strip(cardText)}\n`.includes(cleanFindingFile(f) ? anchor : `${anchor}\n`);
}

/** Where a filed-prevention entry is filed from, for a reader of the pool who has never heard of this operation. */
export const PREVENTION_QUEUE_AREA = 'review-loop prevention-outstanding auto-accept (#3442)';

/**
 * BUILD ONE learnings-pool entry for ONE outstanding prevention guard. PURE — mirrors {@link buildAcceptQueueEntry}
 * field-for-field (same defensive cap assertions, same "refuse rather than truncate" posture), one finding at a
 * time rather than one entry per run: a `prevention-outstanding` verdict can carry several named guards at once
 * (`derivePanelVerdict` does not cap it at one), and folding them all into a single `summary`/`suggestion` would
 * risk exactly the overflow this file already refuses to silently truncate — one entry per guard keeps each
 * comfortably inside `FIELD_CAPS` on its own.
 *
 * @param {{repo: string, pr: number|string, runId: string, finding: {prevention?: string}}} o
 * @returns {{kind: string, summary: string, area: string, suggestion: string}}
 */
export function buildPreventionQueueEntry({ repo, pr, runId, finding } = {}) {
  const subject = `${repo}#${pr}`;
  const entry = {
    kind: 'improvement',
    summary: `${subject}'s independent review reduced to PREVENTION-OUTSTANDING and auto-cleared to accept — `
      + 'a named prevention guard was never filed as its own backlog item.',
    area: PREVENTION_QUEUE_AREA,
    suggestion: `File as a backlog item (run ${runId}): ${finding?.prevention ?? '(no guard text recorded)'}`,
  };
  // SAME DEFENSIVE ASSERTION AS buildAcceptQueueEntry, AND FOR THE SAME REASON — a human acts on this field;
  // silently cutting a guard's own text short would hand them a broken lead instead of a working one.
  for (const [field, cap] of Object.entries(FIELD_CAPS)) {
    if (entry[field].length > cap) {
      throw new Error(
        `review-loop-policy: the filed-prevention entry's \`${field}\` is ${entry[field].length} chars, over `
        + `the pool's ${cap}-char cap — ${JSON.stringify(subject)}, the run id, or the guard text is unusually `
        + 'long. Refusing to truncate a value a human will act on; shorten the inputs or widen the cap deliberately.',
      );
    }
  }
  if (!KINDS.includes(entry.kind)) {
    throw new Error(`review-loop-policy: 'improvement' is no longer one of learnings-drop's KINDS (${KINDS.join(', ')}) — pick a live one`);
  }
  return entry;
}

/**
 * IS THIS OUTCOME THE "PREVENTION-OUTSTANDING AUTO-CLEARED TO ACCEPT" CASE? PURE — the one fact
 * `review-loop-cli.mjs` needs to decide whether to file one {@link buildPreventionQueueEntry} per outstanding
 * guard, mirroring {@link isQueuedAcceptStop}'s role for the OTHER file-then-notify branch. (The caller does
 * its OWN `findings.filter(hasUncapturedPrevention)` to get the list to file — kept there, not wrapped in a
 * `buildPreventionQueueEntries` batch helper here, so a single oversized guard's `buildPreventionQueueEntry`
 * throw can be caught PER FINDING and never blocks filing the others in the same run; see the caller.)
 *
 * DELIBERATELY A DIFFERENT SHAPE FROM `isQueuedAcceptStop`: that predicate matches a STOP (the policy declined,
 * the run is still parked at `confirm`). This one matches the OPPOSITE — the policy ANSWERED `accept` for this
 * verdict (see {@link reviewLoopAutoConfirm}), so the run already advanced past `confirm` and `pending` is
 * cleared. `outcome.stopped !== 'confirm'` is the guard that keeps this `false` for a `review:human` PR
 * carrying the same verdict — refusal 1 in `reviewLoopAutoConfirm` declines it unconditionally, so THAT run is
 * still sitting at `confirm` with nothing to file yet.
 *
 * `hasUncapturedPrevention` (`we:scripts/lib/jury-core.mjs`, #2823) is the WIDE "notice" predicate — NOT the
 * same one `deriveVerdict` gates the verdict itself on (`blocksAcceptance`, that same file, narrows it further
 * by `impactIfUnfixed` against `PREVENTION_IMPACT_BAR`). Using the wide predicate here is deliberate, matching
 * `renderPreventionSummary`'s own convention (see that file's "notice-wide / verdict-narrow split"): a finding
 * whose guard is real but sits BELOW the bar still gets filed, even though it did not by itself drive this run
 * to `PREVENTION_OUTSTANDING` — the debt exists either way, and this only ever runs once at least one OTHER
 * finding already crossed the bar and produced this verdict in the first place.
 *
 * A KNOWN, ACCEPTED GAP (review, finding 2, deliberately not closed here): this reads the run's TERMINAL
 * state, not "did the confirm step answer THIS call" — so a stale re-`--resume=<id>` of an already-COMPLETE
 * `prevention-outstanding` run (an operator/automation checking status, a retried dispatch) re-satisfies this
 * predicate every time and re-files duplicate learnings-pool entries. `driveRun` short-circuits to `stopped:
 * 'complete'` at TURN ZERO for an already-finished run (`we:scripts/operations/cli-adapter.mjs`), so nothing
 * here can tell "just answered" from "answered a while ago" without a durable per-run "already filed" marker
 * this size-scoped item does not add. This is the SAME shape `isQueuedAcceptStop`'s permanently-parked
 * `confirm` state already has (a repeated status check there re-files too) — not a new class of risk, only a
 * wider surface, since `complete` is far cheaper to re-hit than a park. A cheap-looking fix (require
 * `outcome.applied.length > 0`, i.e. "this call itself did the work") was considered and rejected: a run that
 * resumes past an `effect-in-flight` halt whose effect later resolved via `wake.mjs` (out of process) can
 * legitimately reach `complete` with an EMPTY `applied` on the call that observes it — that guard would silently
 * DROP a real, first-time filing, which is worse than an occasional duplicate. Left as a follow-up rather than
 * guessed at here.
 *
 * FIXED (independent review of PR #1784, CONFIRMED): this predicate used to read `outcome?.stopped !==
 * 'confirm'`, which does not mean "this run actually succeeded" — it means "this run stopped anywhere other
 * than the human-park stop", and `driveRun` (`we:scripts/operations/cli-adapter.mjs`) has several OTHER
 * terminal stops that are failures, not successes: `'effect-halted'` (an effect — e.g. the accept label swap —
 * threw), `'step-refused'` (a declaration fn refused deterministically) and `'stuck'` (the run made no
 * progress). A `prevention-outstanding` verdict can still be sitting on `run.verdict` when any of those fires
 * (the verdict is computed at `reduce`, upstream of `confirm`/the effect apply this predicate is meant to gate
 * on), so the old check would call a HALTED or REFUSED run "clear" and the caller below would file the
 * prevention guard(s) and report success for a PR whose accept never actually landed. The only two terminal
 * stops that legitimately mean "the accept went through" are named two paragraphs up: `'complete'` and
 * `'effect-in-flight'` (a dispatched effect that will resolve later, out of process — still a SUCCESSFUL stop,
 * per `driveRun`'s own comment on that branch). Narrowed to exactly those two, matching the success set
 * `renderOutcome`'s own JSON-code branch uses (`stopped === 'complete' || stopped === 'confirm' || stopped ===
 * 'effect-in-flight'`) minus `'confirm'`, which is excluded here on purpose — that stop means the run is still
 * PARKED (only reachable for a `review:human` PR, since refusal 1 in `reviewLoopAutoConfirm` declines those
 * unconditionally), not cleared.
 *
 * @param {{stopped?: string, run?: {pending?: object, verdict?: {verdict?: string, findings?: Array<object>}}}} outcome
 * @returns {boolean}
 */
export function isPreventionOutstandingClear(outcome) {
  return (outcome?.stopped === 'complete' || outcome?.stopped === 'effect-in-flight')
    && outcome?.run?.verdict?.verdict === VERDICTS.PREVENTION_OUTSTANDING
    && Array.isArray(outcome?.run?.verdict?.findings)
    && outcome.run.verdict.findings.some(hasUncapturedPrevention);
}

// ── Cards 5471 + 5470 — LATER ROUNDS THAT END IN CARDS, NOT ANOTHER FIX ROUND ──────────────────────────────────────
//
// Fixer/review rulings P5 and P3 (operator 2026-10-08, card 5467). Two rules, one outcome: a later review round whose
// blocking findings are all safe to defer is ACCEPTED, and those findings are filed as one follow-up backlog card,
// instead of sending the PR back for another fix round.
//
//   round-budget (5471, P5)          — after round K (setting `roundBudget`, shipped K=3), a `changes` round whose
//                                      held findings are all `cosmetic`/`degraded` is accepted with cards. A `broken`
//                                      or `unrecoverable` finding (or one with no stated impact) still blocks, at any
//                                      round. The round cap still stands: at round ≥ the cap the budget does not act.
//   binding-prior-round (5470, P3)   — when `scopedRereview` is `on`, a later round the scoped re-review shadow says
//                                      would not have blocked (every held finding sits on code unchanged since the
//                                      last reviewed head, none is CONFIRMED + broken, none carries a sent-back
//                                      finding) is accepted with cards. `shadow` only journals, as before.
//
// PURE: plain facts in, a decision out. The facts come from the run record: the verdict, the read (the resolved
// settings and the ledger round, written by the io shell), and the advise step's shadow summary. No label, forge or
// clock detail is inside a rule, so it can move into the delivery standard as-is (protocol card 5468).

/** The two rules, by name (also the card title's and the journal's word for them). */
export const ROUND_CARD_RULES = Object.freeze({ ROUND_BUDGET: 'round-budget', BINDING_PRIOR_ROUND: 'binding-prior-round' });

/** The impacts a round may turn into cards. Anything else (`broken`, `unrecoverable`, or none stated) blocks. */
const CARDABLE_IMPACTS = Object.freeze(['cosmetic', 'degraded']);

/** The findings that held the live verdict (the same test the shadow uses). PURE. */
export function heldRoundFindings(verdict) {
  const basisLenses = Array.isArray(verdict?.basisLenses) && verdict.basisLenses.length ? verdict.basisLenses : MANDATORY_LENSES;
  return (Array.isArray(verdict?.admittedFindings) ? verdict.admittedFindings : [])
    .filter((f) => normalizeFinding(f) && findingHeldVerdict(f, { basisLenses }));
}

/** The guards both rules share, in order. `null` when the round is eligible. PURE. */
function roundCardsRefusal(verdict) {
  if (verdict?.verdict !== VERDICTS.CHANGES) return 'not-changes';
  if (verdict.humanRequired === true) return 'human-required';
  if (verdict.pendingReferrals?.length) return 'referral-pending';
  if (verdict.blockedReferrals?.length) return 'referral-blocked';
  const admitted = Array.isArray(verdict.admittedFindings) ? verdict.admittedFindings : [];
  if (admitted.some(requiresMandatoryReferral)) return 'confirmed-broken';
  return null;
}

/**
 * Card 5471 — THE ROUND BUDGET (ruling P5). PURE. Accept with cards only on positive evidence: a `changes` verdict, a
 * known round past K and below the cap, no referral open or block-ruled, no CONFIRMED broken finding, and every held
 * finding `cosmetic` or `degraded`. Every doubt keeps today's bounce (edges 2 and 4).
 *
 * @param {{verdict?: object, round?: number|null, budget?: number|string, cap?: number}} facts - `round` is the ledger's
 *   reviewed-head round for this PR (`read.reviewRound`); `budget` the resolved `roundBudget` setting.
 * @returns {{rule: string, apply: boolean, reason: string, round: number|null, k: number|null, cards: Array<object>}}
 */
export function roundBudgetDecision({ verdict, round = null, budget = 'off', cap = DEFAULT_ROUND_CAP } = {}) {
  const k = isValidRoundBudget(budget) ? budget : null;
  const r = Number.isInteger(round) && round >= 1 ? round : null;
  const out = (apply, reason, cards = []) => ({ rule: ROUND_CARD_RULES.ROUND_BUDGET, apply, reason, round: r, k, cards });
  if (k === null) return out(false, 'off');
  const refusal = roundCardsRefusal(verdict);
  if (refusal) return out(false, refusal);
  if (r === null) return out(false, 'round-unknown');
  if (r <= k) return out(false, 'within-budget');
  if (r >= cap) return out(false, 'round-cap');
  const held = heldRoundFindings(verdict);
  if (!held.length) return out(false, 'no-held-finding');
  if (held.some((f) => !CARDABLE_IMPACTS.includes(normalizeFinding(f).impactIfUnfixed))) return out(false, 'blocking-impact');
  return out(true, 'over-budget', held);
}

/**
 * Card 5470 — THE BINDING PRIOR ROUND, `on` (ruling P3). PURE. Reads the scoped re-review shadow's own summary for
 * this round (the advise step's `review.scoped-rereview-shadow` result): when it says the round would have been
 * avoided, the held findings become cards. No summary, a full-review scope, or a shadow block keeps today's bounce.
 *
 * @param {{verdict?: object, mode?: string, shadow?: object|null}} facts - `mode` is `read.scopedRereview`; `shadow` the
 *   shadow summary.
 * @returns {{rule: string, apply: boolean, reason: string, round: number|null, k: null, cards: Array<object>}}
 */
export function bindingPriorRoundDecision({ verdict, mode = 'off', shadow = null } = {}) {
  const round = Number.isInteger(shadow?.round) ? shadow.round : null;
  const out = (apply, reason, cards = []) => ({ rule: ROUND_CARD_RULES.BINDING_PRIOR_ROUND, apply, reason, round, k: null, cards });
  if (mode !== 'on') return out(false, mode === 'shadow' ? 'shadow' : 'off');
  const refusal = roundCardsRefusal(verdict);
  if (refusal) return out(false, refusal);
  if (!shadow || typeof shadow !== 'object') return out(false, 'shadow-unavailable');
  if (!(round > 1) || shadow.scope !== 'delta') return out(false, 'full-review');
  if (shadow.shadowBlocked !== false || shadow.liveBlocked !== true || shadow.roundAvoided !== true) return out(false, 'still-blocks');
  const held = heldRoundFindings(verdict);
  if (!held.length) return out(false, 'no-held-finding');
  return out(true, 'unchanged-code', held);
}

/** The shadow summary the advise step recorded on this run, or null. PURE. */
export function adviseShadowSummary(run) {
  const effects = Array.isArray(run?.findings?.advise?.effects) ? run.findings.advise.effects : [];
  const hit = effects.find((e) => e?.type === REVIEW_EFFECTS.SCOPED_REREVIEW_SHADOW && e.status === 'applied');
  return hit?.result?.summary && typeof hit.result.summary === 'object' ? hit.result.summary : null;
}

/**
 * THE ONE DECISION the loop acts on: the round budget first, then the binding prior round. PURE. `apply: false` is
 * today's behaviour.
 * @param {object} run - a `review-pr` run record (or its in-flight form at the confirm stop).
 * @returns {{rule: string, apply: boolean, reason: string, round: number|null, k: number|null, cards: Array<object>}}
 */
export function roundCardsDecision(run) {
  const read = run?.findings?.read ?? {};
  const budget = roundBudgetDecision({ verdict: run?.verdict, round: read.reviewRound ?? null, budget: read.roundBudget ?? 'off' });
  if (budget.apply) return budget;
  const binding = bindingPriorRoundDecision({ verdict: run?.verdict, mode: read.scopedRereview ?? 'off', shadow: adviseShadowSummary(run) });
  return binding.apply ? binding : budget;
}

/**
 * IS THIS STOP THE MOMENT TO FILE THE ROUND'S CARDS AND ACCEPT? PURE — mirrors {@link isPreventionOutstandingParked}:
 * an agent-addressed confirm the policy declined because {@link roundCardsDecision} applies.
 * @param {{stopped?: string, run?: object}} outcome - a `driveRun` outcome.
 * @returns {boolean}
 */
export function isRoundCardsParked(outcome) {
  return outcome?.stopped === 'confirm'
    && outcome?.run?.pending?.of === CONFIRM_ACTORS.AGENT
    && roundCardsDecision(outcome.run).apply === true;
}

/**
 * Controls, format (zero-width, bidi, BOM), line/paragraph separators, private-use and surrogate code points, and the
 * Hangul filler characters that render as blanks: nothing a one-line field may carry. The fillers are named by code
 * point so no invisible character lives in this source file.
 */
const CARD_FIELD_UNSAFE = new RegExp(
  `[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Co}\\p{Cs}${[0x115f, 0x1160, 0x3164, 0xffa0].map((c) => String.fromCodePoint(c)).join('')}]+`, 'gu',
);

/**
 * THE ONE SANITIZER for any juror- or job-derived text that lands on a card line or in the accept comment (PR #4714
 * review, security/untrusted-text). PURE. A juror reads an attacker-controlled diff, so a field it returns is data,
 * never structure: NFKC first (a fullwidth backtick or compatibility form becomes the plain char it imitates), then
 * every control, line/paragraph separator and invisible mark becomes a space, runs of whitespace collapse, backticks
 * become apostrophes, and the result is trimmed and capped. Applied to EVERY such field, not just the summary.
 * @param {unknown} value
 * @param {number} cap - the longest the field may be.
 * @returns {string}
 */
export function sanitizeCardField(value, cap, { keepBackticks = false } = {}) {
  // Markup that would act on the PR comment or the card once rendered is made inert too: an `@` (a mention would notify
  // someone), angle brackets (HTML) and a link/image target `](`.
  const line = String(value ?? '').normalize('NFKC').replace(CARD_FIELD_UNSAFE, ' ').replace(/\s+/g, ' ')
    .replace(/@/g, '(at)').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\]\(/g, '] (');
  // Cut on code points, never inside a surrogate pair.
  return [...(keepBackticks ? line : line.replace(/`/g, "'")).trim()].slice(0, cap).join('').trim();
}

/** A prevention guard's free text as one line (same class as the round-card fields; backticks kept: guards cite code). */
const guardText = (f) => sanitizeCardField(f?.prevention, 1000, { keepBackticks: true });

/**
 * One finding's parts, each sanitized: the cited place, the lens, the severity and the summary. `uncapped` keeps the
 * summary whole (the fingerprint hashes it so two findings that differ only past the card's 300-char cap stay distinct).
 */
function roundCardParts(f, { uncapped = false } = {}) {
  const n = normalizeFinding(f) ?? { summary: '' };
  const lens = sanitizeCardField(String(n.category ?? '').split('/')[0], 40) || 'review';
  const sev = sanitizeCardField([n.verdict, n.impactIfUnfixed].filter(Boolean).join(' '), 40) || 'severity not stated';
  const summary = sanitizeCardField(n.summary, uncapped ? Infinity : 300);
  const anchor = cleanFindingFile(f) ? preventionGuardAnchor(f) : '`(no file cited)`';
  return { anchor, lens, sev, summary };
}

/** One finding as one plain line: the cited place, the lens and severity, and the summary (data, never parsed). */
function roundCardLine(f, i) {
  const { anchor, lens, sev, summary } = roundCardParts(f);
  return `${i + 1}. ${anchor} — ${lens}, ${sev}: ${summary}`;
}

/** The text a round card carries to name the head it was filed for (the retry key, like {@link preventionHeadMarker}). */
export function roundCardsHeadMarker(head) {
  return `reviewed head \`${head}\``;
}

/**
 * THE FINDING-SET FINGERPRINT (PR #4714 review): 16 hex of a hash over the sorted, sanitized identity of every carded
 * finding. PURE. A card is the same filing only for the same PR, rule, round, head AND findings: a same-head rerun that
 * raises a different or extra finding must not reuse a card that omits it. Order-independent, and independent of how a
 * (fresh) jury words a finding: it hashes the cited place and lens, not the prose.
 * @param {Array<object>} cards - the decision's held findings.
 * @returns {string}
 */
export function roundCardsFindingsFingerprint(cards = []) {
  // STABLE identity only: the retry after a failed accept is a FRESH jury that words the same finding differently, so the
  // prose is not part of it. The cited place and lens identify a finding (as `cardCoversGuard` does for guards); only a
  // finding that cites no file has nothing else to tell it apart, so its summary stands in.
  const identities = (Array.isArray(cards) ? cards : []).map((f) => {
    const { anchor, lens, summary } = roundCardParts(f, { uncapped: true });
    return [anchor, lens, cleanFindingFile(f) ? '' : summary].join('\u001f');
  }).sort();
  return createHash('sha256').update(identities.join('\u001e')).digest('hex').slice(0, 16);
}

/** The text a round card carries to name the finding set it was filed for (the lookup requires it). */
export function roundCardsFindingsMarker(fingerprint) {
  return `finding set \`${fingerprint}\``;
}

/** The card title: stable per PR + rule + round, never built from juror prose. PURE. */
export function roundCardsTitle({ repo, pr, rule, round }) {
  return `Review follow-ups (${rule}, round ${round ?? '?'}) from ${repo}#${pr}`;
}

/**
 * BUILD the `file-item` input for the ONE card that carries every finding a round turned into a card. PURE. One card
 * per round, one numbered line per finding — the same shape as {@link buildPreventionFilingInput}, for the same reason:
 * each filed card lands through its own lane and PR, so one card per finding would multiply that cost.
 *
 * @param {{repo: string, pr: number|string, head?: string|null, decision: object, queue?: string}} o
 * @returns {{title: string, kind: string, size: string, digest: string, scope: string, parent: string, queue: string}}
 */
export function buildRoundCardsFilingInput({ repo, pr, head = null, decision, queue = 'true' } = {}) {
  const cards = Array.isArray(decision?.cards) ? decision.cards : [];
  const files = [...new Set(cards.map(cleanFindingFile).filter(Boolean))];
  const why = decision?.rule === ROUND_CARD_RULES.ROUND_BUDGET
    ? `round ${decision.round} is past the round budget K=${decision.k} and no finding is broken (card 5471)`
    : `round ${decision?.round ?? '?'} raised these only on code unchanged since the last reviewed head (card 5470)`;
  const digestRaw = `Filed mechanically by the unattended review loop: ${repo}#${pr}'s review${head ? ` (${roundCardsHeadMarker(head)})` : ''} `
    + `(${roundCardsFindingsMarker(roundCardsFindingsFingerprint(cards))}) was accepted because ${why}. Each finding below was deferred to this card instead of another fix round:\n\n`
    + cards.map(roundCardLine).join('\n');
  return {
    title: roundCardsTitle({ repo, pr, rule: decision?.rule, round: decision?.round }),
    kind: 'story',
    size: '2',
    digest: qualifyLocusRefs(digestRaw, files),
    scope: files.map((f) => `${IN_REPO_LOCUS}${f}`).join(','),
    parent: '',
    queue: queue === 'false' || queue === false ? 'false' : 'true',
  };
}

/**
 * The `--reason` the accept is recorded with: the rule, and one line per carded finding, so the PR comment tells the
 * operator what was deferred and where it went. PURE.
 * @param {{decision: object, filed?: string|null}} o - `filed` names the card (path, number, or the landing handle).
 * @returns {string}
 */
export function roundCardsAcceptReason({ decision, filed = null } = {}) {
  const head = decision?.rule === ROUND_CARD_RULES.ROUND_BUDGET
    ? `Round budget (card 5471): round ${decision.round} > K=${decision.k}, no finding is broken, so this round accepts.`
    : `Binding prior round (card 5470): round ${decision?.round ?? '?'} found these only on code unchanged since the last reviewed head, so this round accepts.`;
  const cards = Array.isArray(decision?.cards) ? decision.cards : [];
  // `filed` is a path, a number or a landing handle read back from a job's stdout or a stored receipt: data, like the rest.
  const where = sanitizeCardField(filed, 200);
  return [`${head} ${cards.length} finding(s) filed as a follow-up card${where ? ` (${where})` : ''}:`, ...cards.map(roundCardLine)].join('\n');
}

/**
 * Card 5471 [A3] — THE CARD DEBT the round rules create, made visible: how many round cards were filed, how many
 * findings they carry, and the share of those cards since resolved (the later fix rate), per rule. PURE: it reads card
 * texts (the caller lists `backlog/`); a card is a round card only by its own `# Review follow-ups (<rule>, …` heading.
 * @param {string[]} cardTexts
 * @returns {{cards: number, findings: number, resolvedCards: number, fixRate: number|null,
 *   byRule: Record<string, {cards: number, findings: number, resolvedCards: number, fixRate: number|null}>}}
 */
export function roundCardsReport(cardTexts = []) {
  const blank = () => ({ cards: 0, findings: 0, resolvedCards: 0, fixRate: null });
  const total = blank();
  const byRule = {};
  const rules = Object.values(ROUND_CARD_RULES).join('|');
  for (const text of Array.isArray(cardTexts) ? cardTexts : []) {
    const m = new RegExp(`^# Review follow-ups \\((${rules}), round [^)]*\\) from \\S+#\\d+$`, 'm').exec(String(text ?? ''));
    if (!m) continue;
    const body = String(text).slice(m.index);
    const findings = (body.match(/^\d+\. /gm) ?? []).length;
    const resolved = /^status:\s*"?resolved\b/m.test(String(text).slice(0, m.index));
    for (const bucket of [total, (byRule[m[1]] ??= blank())]) {
      bucket.cards += 1;
      bucket.findings += findings;
      if (resolved) bucket.resolvedCards += 1;
    }
  }
  for (const bucket of [total, ...Object.values(byRule)]) bucket.fixRate = bucket.cards ? bucket.resolvedCards / bucket.cards : null;
  return { ...total, byRule };
}
