#!/usr/bin/env node
/**
 * @file scripts/operations/review-loop-cli.mjs
 * @description #3072's REMAINING SLICE, MADE CALLABLE — drives ONE `review-pr` run unattended, using
 * `we:scripts/lib/review-loop-policy.mjs`'s ratified confirm policy, and files a notification either way the
 * policy leaves a debt behind: the queued-accept notice when it DECLINES a clean `accept` (`review:human`) — or,
 * since the #2749 fix (2026-09-26), MECHANICALLY FILES the owed prevention guard(s) as a real backlog card
 * through the declared `file-item` operation and resumes the SAME run with `accept` itself, when the verdict is
 * `prevention-outstanding` on the agent-addressed (`review:pending`) tier. That second case is NEVER surfaced to
 * a human (2026-09-26 scope ruling: filing the follow-up is not a decision an operator needs to make) — see
 * `review-loop-policy.mjs`'s header for the full account of why `#3442`'s old mechanical-accept-without-filing
 * was reversed and replaced rather than merely reverted.
 *
 *   node scripts/operations/review-loop-cli.mjs --pr=1234 --repo=web-everything/web-everything --cwd=<a lane>
 *   node scripts/operations/review-loop-cli.mjs --resume=<run-id> --repo=web-everything/web-everything --pr=1234
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
 * filing the queued-accept notification when that policy declines a clean accept, and — the #2749 addition —
 * mechanically filing the owed prevention card + auto-resuming to accept when the policy declines a
 * `prevention-outstanding` verdict. Everything else is reused, not re-derived: `run.mjs`'s own operation table
 * (`resolveOperation`, `createCliJudgeFactory`) builds the exact same declaration/registry/sinks/judge the human
 * CLI uses (for BOTH `review-pr` and, now, the nested `file-item` call), and
 * `we:scripts/operations/cli-adapter.mjs`'s own `parseOperationArgv` / `renderOutcome` / `runOperationCli` /
 * `restartCommand` render every stop this shares with the human path — so a bug fixed in either place is fixed
 * here too, and the two callers can never quietly drift on what a stop MEANS.
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
 * `#3279`'s dispatched session's job every time it runs, never a `while` loop inside this file. The ONE
 * exception is the mechanized prevention-filing branch below, which resumes the SAME run a second time within
 * THIS SAME invocation — that is not a second round (the diff has not changed), it is completing the ONE round
 * that was already decided, the same way a human's own `--answer=accept` resume would.
 *
 * IMPURE: spawns jurors (via the injected judge), writes run records, files a real backlog card through
 * `file-item` on a `prevention-outstanding` verdict, and — only on a queued clean accept — appends one line to
 * the learnings pool. Everything DECISION-shaped is imported from a pure module (`review-loop-policy.mjs`);
 * nothing here decides, it only wires and reports.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cwdFlagValue, driveRun, hasJsonFlag, outcomePayload, parseOperationArgv, renderOutcome, runOperationCli,
} from './cli-adapter.mjs';
import { startRun, runStatus, rewindRunToStep } from './engine.mjs';
import { createFileRunStore, newRunId } from './run-store.mjs';
import { REPO_ROOT as SCAFFOLD_ROOT } from './scaffold-io.mjs';
import { resolveOperation, createCliJudgeFactory } from './run.mjs';
import { appendEntry } from '../conveyor/learnings-drop.mjs';
import {
  acceptResumeCommand, buildAcceptQueueEntry, buildPreventionFilingInput, buildPreventionQueueEntry, preventionHeadMarker,
  cardCoversGuard, isPreventionOutstandingClear, isPreventionOutstandingParked, isQueuedAcceptStop, reviewLoopAutoConfirm,
  buildRoundCardsFilingInput, isRoundCardsParked, roundCardsAcceptReason, roundCardsDecision, roundCardsFindingsFingerprint,
  roundCardsFindingsMarker, roundCardsHeadMarker,
} from '../lib/review-loop-policy.mjs';
import { hasUncapturedPrevention } from '../lib/jury-core.mjs';
import { findResumableParkedRun, readReviewRunEvidence } from '../conveyor/review-referral-hold.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
// #4493 — this file's own mechanized prevention filing had the SAME orphaned-card bug `we:scripts/review-set-
// label.mjs#fileApprovalPreventionCard` was fixed for under #4317: `fileItemForPrevention` below drives
// `file-item` IN PROCESS, against whatever checkout is running the review daemon (routinely a read-only clone,
// never committed, never pushed). `fileItemForPreventionViaLandingJob` (below) routes through the SAME shared
// detached-landing-job seam #4317's caller already uses, extracted to this leaf for exactly this reuse.
import { spawnPreventionLandingJob } from '../lib/prevention-landing-job.mjs';

/** The operation this driver always runs. Not a flag: this file has exactly one job. */
export const REVIEW_LOOP_OP = 'review-pr';

/**
 * #xu2pp2m — WHO A RUN THROUGH THIS ENTRY POINT IS ATTRIBUTED TO, when the caller named nobody.
 *
 * `review-pr`'s `actor` field defaults to `'operator'` (`we:scripts/operations/review-pr.mjs`), which is
 * exactly right for `run.mjs review-pr` — a HUMAN at a terminal answering `confirm` themselves. It is exactly
 * WRONG here: this file is the unattended driver, it already tells `driveRun` `attemptedBy: 'agent'`, and
 * nothing about the run involves an operator at all. Live-caught 2026-09-12 (PR #2122): a fully mechanical
 * clear recorded its durable verdict as `Recorded by operator.` and its operator notice as
 * `PR … — human review accepted by operator.` — a machine-made clear, indistinguishable downstream from one a
 * person actually looked at.
 *
 * THE DEFAULT MOVES, THE FLAG DOES NOT. A caller who passes `--actor=<name>` still gets exactly that name
 * (`applyUnattendedActorDefault` only fills in an absent one), so the human-driven `--resume … --answer=accept`
 * ceremony — which goes through this file too, with `--actor=` supplied — is unchanged.
 */
export const UNATTENDED_REVIEW_ACTOR = 'agent (unattended review-loop)';

/**
 * PURE — the input a run started through this driver should carry. Fills `actor` with
 * {@link UNATTENDED_REVIEW_ACTOR} only when the invocation named none.
 *
 * WHY IT READS RAW `argv` AND NOT `parsed.input.actor`. The declaration's own `default: 'operator'` has
 * ALREADY been applied by the time `parseOperationArgv` returns, so `parsed.input.actor === 'operator'` is
 * indistinguishable between "nobody said" and "somebody typed `--actor=operator`". Raw argv is the only place
 * that distinction still exists — the same reason `cwdFlagValue`/`hasJsonFlag` read argv directly.
 *
 * @param {object} input - `parseOperationArgv`'s `input`.
 * @param {string[]} argv
 * @returns {object}
 */
export function applyUnattendedActorDefault(input, argv = []) {
  const named = argv.some((t) => typeof t === 'string' && (t === '--actor' || t.startsWith('--actor=')));
  if (named) return input;
  return { ...input, actor: UNATTENDED_REVIEW_ACTOR };
}

/**
 * A `fileItem` BINDING (#2749) THAT DRIVES `file-item` IN PROCESS, exactly the way `run.mjs file-item --json
 * --title=… …` would from a terminal (same `resolveOperation`/`runOperationCli` this file already uses for
 * `review-pr` itself). `file-item` has no `confirm`/`judge` step (every step is `compute`/`effect`), so this
 * always settles in ONE `driveRun` sweep — no `makeJudge`, no resume.
 *
 * NO LONGER `runReviewLoopOnce`'s PRODUCTION DEFAULT (#4493). This writes the filed card into `file-item`'s own
 * root — wherever THIS process's checkout is, which for the real caller (the review daemon) is routinely a
 * read-only clone that never commits or pushes: the exact bug `we:scripts/review-set-label.mjs
 * #fileApprovalPreventionCard` was fixed for under #4317, just via this file's own separate caller (74 orphaned
 * `backlog/x*.md` cards in `~/workspace/wev-review-daemon` as of 2026-09-29, from BOTH callers). Kept, still
 * exported and tested, as a plain in-process binding a caller genuinely running inside its own writable lane
 * could still choose to inject; the production default is {@link fileItemForPreventionViaLandingJob}.
 *
 * A FRESH `createFileRunStore()` PER CALL, not the caller's own `review-pr` store: `file-item` is a DIFFERENT
 * operation with its own run-record namespace (`we:scripts/operations/run-store.mjs` keys records by run id,
 * which `newRunId(declaration.name)` already scopes per-operation) — reusing the review-pr store would work by
 * accident (`driveRun` starts a fresh run either way) but would mix two operations' records under one store
 * instance for no reason. `.operations/runs/` is gitignored, so this leaves no stray file in the diff.
 *
 * @param {{title:string,kind:string,size:string,digest:string,scope:string,parent:string,queue:string}} input -
 *   {@link module:review-loop-policy.buildPreventionFilingInput}'s own output.
 * @param {{resolve?: Function, run?: Function, makeStore?: Function}} [deps] - test seams only; production
 *   always uses the real `resolveOperation`/`runOperationCli`/`createFileRunStore`.
 * @returns {Promise<{code:number, lines:string[]}>}
 */
export async function fileItemForPrevention(input, {
  resolve = resolveOperation, run = runOperationCli, makeStore = createFileRunStore,
} = {}) {
  const argv = buildFileItemArgv(input);
  const { declaration, registry, sinks } = resolve('file-item', { json: true });
  return run({
    declaration, argv, registry, store: makeStore(), sinks, newRunId: () => newRunId('file-item'),
  });
}

/**
 * THE PRODUCTION `fileItem` BINDING (#4493) — routes the review-loop's own mechanized prevention filing through
 * the SAME detached landing job (`we:scripts/operations/land-prevention-card.mjs`, #4317) that `we:scripts/
 * review-set-label.mjs#fileApprovalPreventionCard`'s approval-time caller already uses, via the shared leaf
 * {@link module:prevention-landing-job.spawnPreventionLandingJob}, instead of {@link fileItemForPrevention}'s
 * in-process `file-item` drive. See this file's own header import comment for the bug this closes.
 *
 * SHAPED TO MATCH {@link fileItemForPrevention}'s OWN RETURN CONTRACT `{code, lines}` so every downstream
 * reader in `runReviewLoopOnce` (`parseFiledPayload`, the `filed?.code !== 0` refusal check) needs no new
 * plumbing: a successful spawn synthesizes a `file-item`-shaped JSON line carrying `queued: true` and the job's
 * own tracking handle in place of a real card number — not known yet, since the job lands the card later, on
 * its own time, exactly like the approval-time caller's own "queued for landing" case; a failed spawn reports a
 * non-zero `code`, which the EXISTING refusal path already handles unchanged.
 *
 * @param {{title:string,kind:string,size:string,digest:string,scope:string,parent:string,queue:string}} input -
 *   {@link module:review-loop-policy.buildPreventionFilingInput}'s own output.
 * @param {{spawnJob?: Function}} [deps] - `spawnJob` is injectable (same shape as
 *   {@link module:prevention-landing-job.spawnPreventionLandingJob}) so a test asserts the argv with no real
 *   subprocess and no real `backlog/` write in the calling checkout; production always uses the real one.
 * @returns {Promise<{code:number, lines:string[]}>}
 */
export async function fileItemForPreventionViaLandingJob(input, { spawnJob = spawnPreventionLandingJob } = {}) {
  const filed = spawnJob(input, { sessionPrefix: 'review-loop-prevention' });
  if (!filed.ok) {
    return { code: 1, lines: [filed.error ?? 'land-prevention-card: unknown spawn failure'] };
  }
  return {
    code: 0,
    lines: [JSON.stringify({
      verdict: { num: null, rel: null }, queued: true, handle: filed.handle, session: filed.session,
    })],
  };
}

/**
 * THE `file-item` ARGV {@link fileItemForPrevention} DRIVES — split out and PURE so a test can pin it against
 * the real `file-item` declaration's own parse (PR #2766 advisory: the production binding had no test).
 *
 * NO `--cwd`, DELIBERATELY. The review loop's own `--cwd` is the JUROR's lane — a clone checked out at the
 * PR under review (`cwdFlagValue`'s doc). Filing the owed card THERE would write it into the very diff being
 * judged, and `file-item` has no juror so its parse refuses `--cwd` outright (`JUROR_FLAGS`). The card belongs
 * to `file-item`'s own root, the same place a human's `run.mjs file-item` would put it.
 *
 * @param {{title:string,kind:string,size:string,digest:string,scope:string,parent:string,queue:string}} input
 * @returns {string[]}
 */
export function buildFileItemArgv(input) {
  return [
    `--title=${input.title}`,
    `--kind=${input.kind}`,
    `--size=${input.size}`,
    `--digest=${input.digest}`,
    `--scope=${input.scope}`,
    ...(input.parent ? [`--parent=${input.parent}`] : []),
    `--queue=${input.queue}`,
    '--json',
  ];
}

/**
 * WHICH OWED GUARDS HAVE ALREADY BEEN FILED? (PR #2766 advisory.) The filing runs BEFORE the accept's effects,
 * so a label swap that fails AFTER a successful filing leaves the run `effect-halted`; the next unattended round
 * reaches `prevention-outstanding` again and must neither file a second card for the same guards nor skip a
 * guard its fresh jury newly names.
 *
 * Matching is PER GUARD, not per card. The candidate cards are the backlog files carrying the same `# <title>`
 * heading (the title names `<repo>#<pr>`) and — when the head is pinned — the same reviewed head
 * ({@link preventionHeadMarker}); a push moves the head, so a later round on new code still files its own
 * card. A guard is covered when some candidate card contains its {@link preventionGuardAnchor} — its
 * `file:line`, not the juror's prose, which a fresh jury rewords. With no pinned head (a degraded read), every
 * same-title card is a candidate, and the anchor still keeps a reworded retry from filing again. A resolved or
 * closed card is never a candidate. Known trade-off: a DIFFERENT guard at the exact same `file:line` counts as
 * covered, and the same guard cited one line off is filed again.
 *
 * @param {{title: string}} input - {@link module:review-loop-policy.buildPreventionFilingInput}'s output.
 * @param {{root?: string, head?: (string|null), findings?: Array<object>}} [o] - the repo root `file-item`
 *   writes under (defaults to its own `REPO_ROOT`), the pinned head the review judged, and the verdict's findings.
 * @returns {{filed: Array<{num: string, path: string}>, uncovered: Array<object>}} the candidate cards that
 *   cover at least one owed guard, and the owed guards none of them covers.
 */
export function findFiledPreventionCard({ title }, { root = SCAFFOLD_ROOT, head = null, findings = [] } = {}) {
  const owed = (Array.isArray(findings) ? findings : []).filter(hasUncapturedPrevention);
  const dir = join(root, 'backlog');
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return { filed: [], uncovered: owed };
  }
  const heading = `# ${title}\n`;
  const source = /\(from (\S+#\d+) review\)$/.exec(title)?.[1];
  const legacyHeading = source ? `# File the prevention guard(s) owed by ${source}'s independent review` : null;
  const cards = [];
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      continue;
    }
    const actualHeading = /^# .+$/m.exec(text)?.[0];
    if (actualHeading !== heading.trimEnd() && !(source && (
      actualHeading === legacyHeading || actualHeading?.endsWith(` (from ${source} review)`)))) continue;
    if (head && !text.includes(preventionHeadMarker(head))) continue;
    // A closed card tracks nothing any more — a guard it named is owed again.
    if (/^status:\s*"?(?:resolved|closed|done|wontfix|superseded)\b/m.test(text.split(actualHeading)[0])) continue;
    cards.push({ num: name.replace(/-.*$/, '').replace(/\.md$/, ''), path: `backlog/${name}`, text });
  }
  const covers = (card, f) => cardCoversGuard(card.text, f);
  return {
    filed: cards.filter((c) => owed.some((f) => covers(c, f))).map(({ num, path }) => ({ num, path })),
    uncovered: owed.filter((f) => !cards.some((c) => covers(c, f))),
  };
}

/**
 * Reads `file-item --json`'s payload out of its stdout lines without ever throwing: a warning line (e.g. a Node
 * deprecation notice) may precede the JSON, which may itself span several lines. Tries each line, then the text
 * from the first line starting with `{` to the end; returns `{}` when nothing parses.
 *
 * @param {string[]} lines
 * @returns {object}
 */
export function parseFiledPayload(lines = []) {
  const tryParse = (text) => {
    try {
      const v = JSON.parse(text);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  };
  for (const line of lines) {
    const v = tryParse(line);
    if (v) return v;
  }
  const start = lines.findIndex((l) => l.trimStart().startsWith('{'));
  return (start === -1 ? null : tryParse(lines.slice(start).join('\n'))) ?? {};
}

/** The step a ruled, parked review is rewound to: the one that reads the rulings off the thread and re-reduces. */
/**
 * Cards 5471 / 5470 — HAS THIS ROUND'S FOLLOW-UP CARD ALREADY BEEN FILED? A retry after an accept that failed part-way
 * must not file a second card. A candidate is an open backlog card with the same `# <title>` heading (the title names
 * the PR, the rule and the round), when the head is pinned the same reviewed-head marker, and — PR #4714 review — when
 * a fingerprint is given the same finding-set marker, so a same-head rerun that raises a different or extra finding
 * never reuses a card that omits it.
 * @param {{title: string}} input - {@link module:review-loop-policy.buildRoundCardsFilingInput}'s output.
 * @param {{root?: string, head?: string|null, fingerprint?: string|null}} [o]
 * @returns {{num: string, path: string}|null}
 */
export function findFiledRoundCardsCard({ title }, { root = SCAFFOLD_ROOT, head = null, fingerprint = null } = {}) {
  let names;
  try { names = readdirSync(join(root, 'backlog')).filter((n) => n.endsWith('.md')); } catch { return null; }
  for (const name of names) {
    let text;
    try { text = readFileSync(join(root, 'backlog', name), 'utf8'); } catch { continue; }
    if (/^# .+$/m.exec(text)?.[0] !== `# ${title}`) continue;
    if (head && !text.includes(roundCardsHeadMarker(head))) continue;
    if (fingerprint && !text.includes(roundCardsFindingsMarker(fingerprint))) continue;
    if (/^status:\s*"?(?:resolved|closed|done|wontfix|superseded)\b/m.test(text)) continue;
    return { num: name.replace(/-.*$/, '').replace(/\.md$/, ''), path: `backlog/${name}` };
  }
  return null;
}

/**
 * PR #4714 review — THE FILING RECEIPT A RUN KEEPS, so a retry after an accept that failed part-way reuses the filing
 * instead of enqueueing a second card. The backlog scan above cannot see a card still `queued` for landing, so the
 * receipt is persisted on the run (`input.roundCardsFiling`) BEFORE the accept is driven. PURE. A receipt answers a
 * retry only for the SAME reviewed head and finding set; anything else (absent, malformed, stale) is no receipt.
 * A receipt for a card still QUEUED expires after {@link QUEUED_RECEIPT_TTL_MS}: nothing here can see whether the
 * landing job died, so past the TTL the landed-card scan alone decides and a dead job's findings are filed again
 * instead of being accepted with no card ever landing.
 * @param {unknown} receipt - `run.input.roundCardsFiling`.
 * @param {{head?: string|null, fingerprint: string, nowMs?: number}} o
 * @returns {{num: string|null, path: string|null, queued: boolean, handle: string|null}|null}
 */
export function retainedRoundCardsReceipt(receipt, { head = null, fingerprint, nowMs = Date.now() } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  if ((receipt.head ?? null) !== (head ?? null) || !fingerprint || receipt.fingerprint !== fingerprint) return null;
  const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
  const out = { num: text(receipt.num), path: text(receipt.path), queued: receipt.queued === true, handle: text(receipt.handle),
    at: typeof receipt.at === 'string' ? receipt.at : null };
  if (out.queued && !out.path) {
    const age = nowMs - Date.parse(receipt.at);
    if (!Number.isFinite(age) || age < 0 || age > QUEUED_RECEIPT_TTL_MS) return null;
  }
  return out.path || out.queued ? out : null;
}

/** How long a receipt for a still-queued card answers a retry (a landing job needs a lane and a PR to merge). */
export const QUEUED_RECEIPT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * PR #4714 review — THE RECEIPT, FOUND ACROSS RUNS. The real retry after an accept that failed part-way is a FRESH run
 * on the same head (the halted run cannot be resumed: its label swap is not idempotent), so it has a new id and none of
 * the first run's input. Scan the run store for a prior `review-pr` run on this PR that kept a receipt for this head
 * and finding set. The current run is in the store too, so one scan covers both. Runs only on the rare round-cards path,
 * and only after the landed-card scan missed. An unreadable record is skipped, never fatal.
 * Only records whose id starts `<op>-` are read (the id `newRunId(op)` mints, as `readReviewRunEvidence` assumes), so the
 * shared runs directory's other operations are never parsed.
 * @param {{store: {list(): string[], read(id: string): (object|null)}, repo: string, pr: number|string,
 *   head?: string|null, fingerprint: string, op?: string, nowMs?: number}} o
 * @returns {ReturnType<typeof retainedRoundCardsReceipt>}
 */
export function findRetainedRoundCardsReceipt({ store, repo, pr, head = null, fingerprint, op = 'review-pr', nowMs = Date.now() }) {
  let ids;
  try { ids = store.list(); } catch { return null; }
  for (const id of ids) {
    if (!id.startsWith(`${op}-`)) continue;
    let prior;
    try { prior = store.read(id); } catch { continue; }
    if (prior?.op !== op || String(prior.input?.repo) !== String(repo) || String(prior.input?.pr) !== String(pr)) continue;
    const hit = retainedRoundCardsReceipt(prior.input?.roundCardsFiling, { head, fingerprint, nowMs });
    if (hit) return hit;
  }
  return null;
}

export const RESUME_STEP = 'mandatoryReferrals';
/** How many times one parked run is driven again after its resume failed part-way, before a fresh review is allowed. */
export const RESUME_MAX_ATTEMPTS = 3;

/**
 * Card xq1xbsl — THE PARKED RUN AN OPERATOR'S RULING RESUMES, if there is one. Reads the PR's live head and thread and
 * the local run evidence, and asks the same pure rule the hold uses ({@link findResumableParkedRun}). Never throws: an
 * unreadable PR or store answers `null`, which means "start a fresh review" exactly as before this existed.
 * @returns {string|null} the run id to resume.
 */
export function defaultFindResumableRun({ repo, pr }, { readPr = defaultReadResumePr, readRuns = readReviewRunEvidence } = {}) {
  try {
    const view = readPr({ repo, pr });
    if (!view?.headRefOid) return null;
    return findResumableParkedRun({ ...view, number: Number(pr) }, readRuns(), { repo })?.id ?? null;
  } catch { return null; }
}

function defaultReadResumePr({ repo, pr }) {
  const { headRefOid } = JSON.parse(execFileSyncThrottled('gh', ['pr', 'view', String(pr), ...(repo ? ['--repo', repo] : []), '--json', 'headRefOid'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }));
  // The complete, paginated thread: a ruling is the newest comment, which a 100-comment page can miss.
  return { headRefOid, comments: readCompletePrComments(pr, { repo }) };
}

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
 * @param {(o: {cwd: (string|null), model: (string|null), provider: (string|null)}) => Function} o.makeJudge
 * @param {() => string} o.mintRunId
 * @param {(pending: object|null, run: object) => ({value: string}|null)} [o.autoConfirm] - injected so a test
 *   can supply a stub; the real caller always passes {@link reviewLoopAutoConfirm}.
 * @param {(entry: object, opts: object) => {record: object, path: string}} [o.appendLearning] - injected so a
 *   test never touches the real pool file; the real caller always passes `learnings-drop.mjs#appendEntry`.
 * @param {string} [o.session] - the learnings-pool session slug the queued-accept entry files under.
 * @param {(input: object) => Promise<{code: number, lines: string[]}>} [o.fileItem] - #2749: files the owed
 *   prevention card. Injected so a test never touches the real backlog/queue files; the real caller always
 *   passes {@link fileItemForPreventionViaLandingJob} (#4493 — routes through a real lane, never the calling
 *   checkout directly; see that function's own doc).
 * @param {(input: object, o: object) => ({filed: Array<object>, uncovered: Array<object>}|null)} [o.findFiledPrevention] -
 *   PR #2766: splits the owed guards into those an earlier round already filed and those still unfiled (`null`
 *   means none filed); the real caller always passes {@link findFiledPreventionCard}.
 * @returns {Promise<{code: number, lines: string[], run: (object|null), stopped: string}>}
 */
export async function runReviewLoopOnce({
  declaration, registry, argv, store, sinks, makeJudge, mintRunId, autoConfirm = reviewLoopAutoConfirm,
  appendLearning = appendEntry, session = 'review-loop', fileItem = fileItemForPreventionViaLandingJob,
  findFiledPrevention = findFiledPreventionCard, findResumableRun = () => null, now = () => new Date().toISOString(),
  findFiledRoundCards = findFiledRoundCardsCard,
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

  const activeJudge = makeJudge({
    cwd: parsed.control.cwd || null, model: parsed.control.model || null, provider: parsed.control.provider || null,
  });

  let run;
  if (parsed.control.resume) {
    run = store.read(parsed.control.resume);
    if (!run) return { code: 2, lines: [`error: no run record for ${JSON.stringify(parsed.control.resume)}`], run: null, stopped: 'refused' };
    if (run.op !== declaration.name) {
      return { code: 2, lines: [`error: run ${run.id} is a \`${run.op}\` run, not \`${declaration.name}\``], run: null, stopped: 'refused' };
    }
  } else {
    // Card xq1xbsl — A RULING ON AN UNCHANGED HEAD RESUMES THE PAUSED REVIEW; IT DOES NOT START A NEW PANEL. A fresh
    // panel judges the same head again, raises referrals the first one did not, and parks the PR for a ruling it
    // already had (live 2026-10-08, #4361/#4388). The parked run already holds the panel's verdict and findings, so it
    // goes back to the step that reads the rulings and carries on from there. New referrals come only from a new push.
    let resumedId = null;
    if (parsed.input.repo && parsed.input.pr != null && process.env.WE_REVIEW_RESUME_PARKED !== '0') {
      try { resumedId = findResumableRun({ repo: parsed.input.repo, pr: parsed.input.pr }); } catch { resumedId = null; }
    }
    // Any doubt (an unreadable record, a run that cannot be rewound) falls back to a fresh review, never aborts the round.
    let rewound = null;
    try {
      const parked = resumedId ? store.read(resumedId) : null;
      // A run parked on a confirm, or one an earlier resume rewound and never finished (it died or threw part-way).
      // "Unfinished" = the earlier resume never got through `advise` (the same test `reviewRunEvidence` applies).
      const unfinishedResume = Boolean(parked?.resumeOf) && !parked.stepTimings?.find((t) => t.step === 'advise')?.finishedAt;
      const attempts = unfinishedResume ? Number(parked.resumeOf.attempts) || 1 : 0;
      // A resume that keeps failing is bounded: after RESUME_MAX_ATTEMPTS the round falls back to a fresh review.
      if (parked && parked.op === declaration.name && attempts < RESUME_MAX_ATTEMPTS
        && (parked.pending?.kind === 'confirm' || unfinishedResume)) {
        rewound = rewindRunToStep(parked, { registry, step: RESUME_STEP, at: now() });
        // The rewind drops the parked verdict and the referral step, and the record is saved before the resumed pass
        // finishes. Keep what it set aside (`resumeOf`) so a resume that fails part-way still reads as the parked run
        // it was (`reviewRunEvidence`) and is resumed again, never replaced by a fresh panel. An unfinished earlier
        // resume keeps ITS `resumeOf` (the last parked pass); a finished, re-parked one captures its new parked pass.
        rewound = { ...rewound, resumeOf: unfinishedResume ? { ...parked.resumeOf, attempts: attempts + 1 }
          : { verdict: parked.findings?.referralVerdict ?? parked.verdict ?? null,
            mandatoryReferrals: parked.findings?.mandatoryReferrals ?? null,
            adviseFinishedAt: parked.stepTimings?.find((t) => t.step === 'advise')?.finishedAt ?? null, attempts: 1 } };
      }
    } catch { rewound = null; }
    if (rewound) {
      run = rewound;
      store.write(run);
    } else {
      run = startRun({
        op: declaration.name,
        id: parsed.control.runId || mintRunId(),
        // #xu2pp2m — see `applyUnattendedActorDefault`: this driver is the UNATTENDED one, so an unnamed actor
        // is an agent, never `review-pr`'s own human-terminal `'operator'` default.
        input: applyUnattendedActorDefault(parsed.input, argv),
        registry,
      });
      store.write(run);
    }
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

  // ── THE MECHANIZED PREVENTION-FILING BRANCH (#2749 fix, 2026-09-26 scope ruling) ─────────────────────────
  // `reviewLoopAutoConfirm` DECLINES a `prevention-outstanding` verdict (it must — filing a card is impure
  // I/O, and the policy stays pure). Filing the owed guard(s) is NOT a decision for an operator, so this is
  // NEVER surfaced as a queued-for-a-human notice: the loop files ONE real backlog card itself, through the
  // declared `file-item` operation (`buildPreventionFilingInput` — pure — derives its input from the SAME
  // findings the verdict already carries), cleared to the conveyor, and — only once that filing actually
  // succeeds — resumes THIS SAME run with the `accept` the policy would not answer itself. The debt is now
  // TRACKED (a real card, not a notice nobody is obligated to act on), so the #2823 "blocks a clean accept
  // until filed" gate is satisfied by construction. A FAILED filing does the opposite of the accept path: it
  // leaves the run parked EXACTLY as it was (nothing recorded) and reports the failure loudly — never
  // swallowed, and never advances to a mechanical accept over a debt that, this time, genuinely went unfiled.
  if (isPreventionOutstandingParked(outcome)) {
    const { pr, repo } = outcome.run.input;
    const head = outcome.run.findings?.read?.netBasis?.rev ?? null;
    const findings = outcome.run.verdict.findings;
    const filingInput = buildPreventionFilingInput({ repo, pr, head, findings });
    let filedPayload = null;
    let filingError = null;
    // PR #2766 advisory — a retry after an `effect-halted` accept must not file a SECOND card for guards an
    // earlier round already filed, and must still file any guard its fresh jury newly names.
    let alreadyFiled = null;
    try {
      const prior = findFiledPrevention(filingInput, { head, findings });
      const priorCards = Array.isArray(prior?.uncovered) ? (prior.filed ?? []) : [];
      if (priorCards.length && prior.uncovered.length === 0) {
        alreadyFiled = priorCards[0];
      } else {
        const toFile = priorCards.length
          ? buildPreventionFilingInput({ repo, pr, head, findings: prior.uncovered })
          : filingInput;
        const filed = await fileItem(toFile);
        const out = (filed?.lines ?? []).join(' / ');
        if (filed?.code !== 0) {
          filingError = `file-item refused: ${out}`;
        } else {
          // The card IS filed (exit 0) — so an unreadable stdout (a Node warning line before the JSON, or no JSON
          // at all) must never crash the loop, and must never re-park either (PR #2767 advisory).
          filedPayload = parseFiledPayload(filed.lines);
        }
      }
    } catch (e) {
      filingError = String(e?.message ?? e);
    }

    if (filingError) {
      const rendered = renderOutcome({ outcome, json: parsed.control.json, declaration });
      if (parsed.control.json) {
        const payload = { ...JSON.parse(rendered.lines[0]), preventionFilingError: filingError };
        return { code: 1, lines: [JSON.stringify(payload, null, 2)], run: outcome.run, stopped: outcome.stopped };
      }
      return {
        code: 1,
        lines: [
          ...rendered.lines, '',
          `FAILED to file the owed prevention card mechanically: ${filingError}`,
          'The run stays parked — nothing was recorded, and this verdict is never auto-cleared unfiled.',
        ],
        run: outcome.run,
        stopped: outcome.stopped,
      };
    }

    const filedNum = alreadyFiled ? alreadyFiled.num : (filedPayload?.verdict?.num ?? null);
    const filedRel = alreadyFiled ? alreadyFiled.path : (filedPayload?.verdict?.rel ?? null);
    // #4493 — the production filer now spawns a detached landing job (see `fileItemForPreventionViaLandingJob`)
    // rather than filing synchronously, so `filedNum`/`filedRel` are genuinely unknown yet on that path — never
    // confuse that with the pre-existing "stdout was unreadable" case (`filedPayload` parsed to `{}`), which
    // stays rendered exactly as before via the `(no path) (#?)` fallback below.
    const filedQueued = !alreadyFiled && filedPayload?.queued === true;
    const filedHandle = filedQueued ? (filedPayload?.handle ?? null) : null;

    // THE CARD IS FILED AND TRACKED — resume THIS SAME run with the mechanical `accept` the policy itself
    // declined to answer, so the label swap + durable comment apply exactly as a clean accept's would.
    const acceptResume = { step: outcome.run.pending.step, value: 'accept' };
    const acceptedOutcome = await driveRun({
      run: outcome.run, registry, store, sinks, judge: activeJudge, resume: acceptResume, autoConfirm, attemptedBy: 'agent',
    });
    const rendered = renderOutcome({ outcome: acceptedOutcome, json: parsed.control.json, declaration });
    if (parsed.control.json) {
      const payload = {
        ...JSON.parse(rendered.lines[0]),
        preventionFiled: {
          num: filedNum, path: filedRel,
          ...(alreadyFiled ? { alreadyFiled: true } : {}),
          ...(filedQueued ? { queued: true, handle: filedHandle } : {}),
        },
      };
      return { code: rendered.code, lines: [JSON.stringify(payload, null, 2)], run: acceptedOutcome.run, stopped: acceptedOutcome.stopped };
    }
    return {
      code: rendered.code,
      lines: [
        ...rendered.lines, '',
        alreadyFiled
          ? `prevention guard(s) ALREADY filed by an earlier round — ${filedRel} (#${filedNum}); not filed again.`
          : filedQueued
            ? `prevention guard(s) queued for landing via a lane (tracking ${filedHandle ?? 'an untracked job'}), `
              + 'cleared to the conveyor; no human was asked.'
            : `prevention guard(s) filed mechanically — ${filedRel ?? '(no path)'} (#${filedNum ?? '?'}), cleared to `
              + 'the conveyor; no human was asked.',
      ],
      run: acceptedOutcome.run,
      stopped: acceptedOutcome.stopped,
    };
  }

  // ── CARDS 5471 / 5470 — A LATER ROUND THAT ENDS IN CARDS, NOT ANOTHER FIX ROUND ─────────────────────────────────────
  // `reviewLoopAutoConfirm` DECLINES a round the round rules turn into cards (the round budget past K, or the binding
  // prior round when `on`): filing is impure, so it happens here, exactly like the prevention branch above. ONE card
  // carries every deferred finding; only once it is filed (or queued for landing) does THIS SAME run resume with
  // `accept`, its `--reason` naming the rule and one line per carded finding (rendered in the PR comment). A failed
  // filing leaves the run parked and unaccepted, and says so loudly — never an accept over findings that went unfiled.
  if (isRoundCardsParked(outcome)) {
    const decision = roundCardsDecision(outcome.run);
    const { pr, repo } = outcome.run.input;
    const head = outcome.run.findings?.read?.netBasis?.rev ?? null;
    const filingInput = buildRoundCardsFilingInput({ repo, pr, head, decision });
    // The filing identity is title + head + the finding set. A card that landed answers a retry; so does the receipt this
    // run kept for a card still queued for landing (PR #4714 review) — either way the filing is reused, never repeated.
    const fingerprint = roundCardsFindingsFingerprint(decision.cards);
    let filedPayload = null;
    let alreadyFiled = null;
    let filingError = null;
    try {
      const landed = findFiledRoundCards(filingInput, { head, fingerprint }) ?? null;
      alreadyFiled = landed
        ? { num: landed.num, path: landed.path, queued: false, handle: null }
        : (retainedRoundCardsReceipt(outcome.run.input?.roundCardsFiling, { head, fingerprint, nowMs: Date.parse(now()) })
          ?? findRetainedRoundCardsReceipt({ store, repo, pr, head, fingerprint, op: declaration.name, nowMs: Date.parse(now()) }));
      if (!alreadyFiled) {
        const filed = await fileItem(filingInput);
        if (filed?.code !== 0) filingError = `file-item refused: ${(filed?.lines ?? []).join(' / ')}`;
        else filedPayload = parseFiledPayload(filed.lines);
      }
    } catch (e) {
      filingError = String(e?.message ?? e);
    }
    if (filingError) {
      const rendered = renderOutcome({ outcome, json: parsed.control.json, declaration });
      if (parsed.control.json) {
        const payload = { ...JSON.parse(rendered.lines[0]), roundCardsFilingError: filingError };
        return { code: 1, lines: [JSON.stringify(payload, null, 2)], run: outcome.run, stopped: outcome.stopped };
      }
      return {
        code: 1,
        lines: [...rendered.lines, '', `FAILED to file the round's follow-up card: ${filingError}`,
          'The run stays parked — nothing was recorded, and these findings are never accepted unfiled.'],
        run: outcome.run,
        stopped: outcome.stopped,
      };
    }
    const queued = alreadyFiled ? alreadyFiled.queued : filedPayload?.queued === true;
    const num = alreadyFiled ? alreadyFiled.num : (filedPayload?.verdict?.num ?? null);
    const path = alreadyFiled ? alreadyFiled.path : (filedPayload?.verdict?.rel ?? null);
    const handle = queued ? ((alreadyFiled ? alreadyFiled.handle : filedPayload?.handle) ?? null) : null;
    const where = path ?? (queued ? `queued for landing (${handle ?? 'untracked job'})` : '(no path)');
    // The receipt is stored on the run BEFORE the accept is driven: if the accept fails part-way, the retry finds it.
    const receipt = { head, fingerprint, num, path, queued, handle, at: alreadyFiled?.at ?? now() };
    const accepting = {
      ...outcome.run,
      input: { ...outcome.run.input, reason: roundCardsAcceptReason({ decision, filed: where }), roundCardsFiling: receipt },
    };
    store.write(accepting);
    const acceptedOutcome = await driveRun({
      run: accepting, registry, store, sinks, judge: activeJudge, resume: { step: outcome.run.pending.step, value: 'accept' },
      autoConfirm, attemptedBy: 'agent',
    });
    const rendered = renderOutcome({ outcome: acceptedOutcome, json: parsed.control.json, declaration });
    const summaryLine = `round-cards: ${repo}#${pr} round ${decision.round ?? '?'} (${decision.rule}${decision.k ? `, K=${decision.k}` : ''}): `
      + `accepted; ${decision.cards.length} finding(s) carded → ${where}${alreadyFiled ? ' (already filed)' : ''}`;
    if (parsed.control.json) {
      const payload = {
        ...JSON.parse(rendered.lines[0]),
        roundCardsFiled: { rule: decision.rule, round: decision.round, k: decision.k, count: decision.cards.length, num, path,
          ...(alreadyFiled ? { alreadyFiled: true } : {}), ...(queued ? { queued: true, handle } : {}) },
      };
      return { code: rendered.code, lines: [JSON.stringify(payload, null, 2)], run: acceptedOutcome.run, stopped: acceptedOutcome.stopped };
    }
    return { code: rendered.code, lines: [...rendered.lines, '', summaryLine], run: acceptedOutcome.run, stopped: acceptedOutcome.stopped };
  }

  // ── THE QUEUED-ACCEPT BRANCH — the one behaviour `runOperationCli` does not have ──────────────────────────
  // The policy already declined a CLEAN accept on a `review:human` PR (see `review-loop-policy.mjs`); this
  // only decides whether to FILE the notification and say so, or fall through to the SAME rendering the
  // human CLI would give an ordinary confirm stop. `prevention-outstanding` NEVER reaches this branch — see
  // the mechanized branch above, which handles that verdict before this one is ever consulted.
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

  // ── THE PREVENTION-FILED BRANCH — reachable only via a HUMAN's manual `--answer=accept` resume of a
  // previously-parked `prevention-outstanding` run (`#3442`'s automatic version, answered by `reviewLoopAutoConfirm`
  // itself, was REVERSED by the #2749 fix above — see that function's doc). A human who read the queued notice,
  // decided to file (or already had) the named guard(s), and resumed with `--answer=accept` still gets this
  // same file-then-notify treatment: the accept already recorded (a human answered it), so this only files the
  // named guard(s) as the notification, then falls through to the ordinary rendering below (an `accept`
  // outcome, same as a genuinely clean verdict would render) with the filing result spliced in.
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
  // #xu2pp2m — `cwd` for the SAME pre-parse reason as `json` (see `cwdFlagValue`). THIS entry point is the
  // one a dispatched/mechanical review runs through, and it is ALWAYS given a lane, so before this the diff it
  // judged came from `REPO_ROOT` on every single unattended review ever run (PR #2122 merged on it).
  const { declaration, registry, sinks } = resolveOperation(
    REVIEW_LOOP_OP, { json: hasJsonFlag(argv), cwd: cwdFlagValue(argv) },
  );
  runReviewLoopOnce({
    declaration,
    registry,
    argv,
    store: createFileRunStore(),
    sinks,
    makeJudge: createCliJudgeFactory(),
    mintRunId: () => newRunId(declaration.name),
    findResumableRun: defaultFindResumableRun,
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

