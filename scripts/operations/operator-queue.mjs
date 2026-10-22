import { execFileSyncThrottled as execFileSync } from '../lib/gh-throttle.mjs';
/**
 * @file Read-only operator queue: the SOLE authority on which human-gated PRs are worth the operator's time.
 *
 * THE OPERATOR'S RULE (2026-09-19): "I won't look at a human PR until it carries `advisory:accepted` and has no
 * request-changes or review-pending." A PR is in NEEDS YOU only when ALL of these hold:
 *   - it carries `review:human` AND `advisory:accepted`, and carries NEITHER `review:pending` NOR `review:changes`
 *     (a HARD gate on the labels — `review:pending` is by definition not ready);
 *   - the advisory COMMENT, parsed independently (`we:scripts/lib/advisory-labels.mjs#parseAdvisories`), agrees:
 *     its newest advisory covers the live head and accepts. The comment is the source of truth; the label is a
 *     derived view of it. Any disagreement between the two is reported in NOT READY as the reason, never resolved
 *     silently in either direction;
 *   - CI is green, except a single failed merge-gate whose own live-head verdict blocks ONLY on human
 *     review holds; unreadable verdicts, fail-closed rules and other holds still block. The PR is not
 *     conflicting, and GitHub reports it MERGEABLE;
 *   - (card x1b8hlo) the post-accept red team has no CONFIRMED break on the live head that `redTeam.confirmedBreaks`
 *     sends back to the fixer (`we:scripts/lib/red-team-gate.mjs#redTeamQueueReason`).
 *
 * RULING NEEDED also includes trusted live-head red-team round-cap records with unresolved send-back findings.
 *
 * THREE BUCKETS, not two. `mergeable: UNKNOWN` is GitHub's transient "still computing" state, and reporting it in
 * NOT READY ("agent work is owed") made a healthy PR flap between ready and not-ready from run to run. So an
 * UNKNOWN PR is re-polled a few times with backoff (GitHub computes on request); one that is STILL unknown lands in
 * PENDING — "transient, re-run", where no agent work is owed. A PR with a real failure stays in NOT READY and does
 * not list the transient state among its reasons.
 *
 * A FIFTH SECTION, STOOD DOWN, ORTHOGONAL TO ALL OF THE ABOVE (we:backlog/x6cjgz5). A conveyor stand-down comment
 * (`we:scripts/conveyor/stand-down.mjs`) is posted whenever a fix agent stops to ask for human judgment, and BY
 * DESIGN it changes no label — `review:human` stays whatever it already was, which for most stood-down PRs is
 * nothing at all. So a stood-down PR without `review:human` was in nobody's queue (live: PR #2505 sat stood down
 * and invisible). This section lists every OPEN PR carrying at least one stand-down comment, regardless of its
 * labels, reusing `standDownComments`/`STAND_DOWN_MARKER` rather than re-deriving the match rule — and never
 * duplicates a PR already shown in NEEDS YOU.
 */
import { readSettings } from '../lib/settings-files.mjs';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ADVISORY_LABELS, ADVISORY_OUTCOMES, advisoryCoversHead, latestAdvisory,
} from '../lib/advisory-labels.mjs';

import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { readUnsupported } from '../conveyor/unsupported-repo.mjs';
// Imports the LIGHTWEIGHT marker module directly, never `stuck-pr-watch-core.mjs` itself — that file pulls in
// `reconcile-core.mjs`'s much heavier transitive graph (`rearm-review.mjs` → `review-set-label.mjs` →
// `merge-ai-prs.mjs`), which broke this file's own mocked `node:child_process` test setup. See
// `we:scripts/conveyor/stuck-pr-dispatch-marker.mjs`'s own header for the full story.
import { stuckDispatchEpisodes } from '../conveyor/stuck-pr-dispatch-marker.mjs';
import { standDownComments, standDownReason, standDownHeadChangeAt, annotateLapsedStandDowns, standDownTrailerReason, STAND_DOWN_REASONS } from '../conveyor/stand-down.mjs';
import { healthSectionLines } from '../conveyor/health-watch-section.mjs';
// Card x1b8hlo — the LIGHT red-team gate module (no heavy graph): a confirmed red-team break the setting sends back
// keeps the PR out of NEEDS YOU while it is unresolved on the live head.
import { CONFIRMED_BREAKS_DEFAULTS, readConfirmedBreaks, redTeamQueueReason, redTeamRulingNeeded } from '../lib/red-team-gate.mjs';
// Partial CLI copies may lack the verdict reader. Keep their queue runnable, but never excuse a check.
let humanReviewOnlyHold, parsePrResultTable;
let mergeGateVerdictImportError;
try { ({ humanReviewOnlyHold, parsePrResultTable } = await import('../lib/merge-gate-verdict.mjs')); }
catch (error) { mergeGateVerdictImportError = String(error?.message ?? error).split('\n')[0]; }
// Partial CLI copies may lack the send-back reader. Keep the queue runnable, but never
// declare a PR ready when its operator requests could not be checked.
let sendBackLedger = null;
let sendBackLedgerError = null;
try { sendBackLedger = await import('../lib/operator-send-backs.mjs'); }
catch (error) { sendBackLedgerError = String(error?.message ?? error).split('\n')[0]; }
const operatorSendBackHoldReasons = (pr) => sendBackLedger
  ? sendBackLedger.operatorSendBackHoldReasons(pr)
  : [`operator send-back check unavailable: ${sendBackLedgerError}`];
// Partial copies may also lack the saved red-team reader (and its store graph). The queue still runs, but says that a
// round-cap break the gate decided on saved evidence could be missing from RULING NEEDED.
let savedRedTeamFallback = null;
let savedRedTeamError = null;
try { ({ savedRedTeamFallback } = await import('../lib/drain-saved-red-team.mjs')); }
catch (error) { savedRedTeamError = String(error?.message ?? error).split('\n')[0]; }
// Staged CLI copies may omit this transitive graph. Without the canonical answer reader,
// keep stand-downs visible as unanswered so the operator can still act on them.
let standDownAnswers = null;
try { standDownAnswers = await import('../conveyor/stand-down-answer-core.mjs'); }
catch { /* Fail safe toward operator judgment. */ }
// Optional like the siblings below: a staged CLI copy without the settings module keeps the built-in layout.
let reviewSettings = null;
try { reviewSettings = await import('../lib/review-settings.mjs'); } catch { /* built-in */ }
let remainingStandDownFindings;
try { ({ remainingStandDownFindings } = await import('../conveyor/ruling-resolved-stand-down.mjs')); }
catch { /* Staged copies still surface the question without remaining findings. */ }
let needsPersonRow;
try { ({ needsPersonRow } = await import('./operator-queue-needs-person.mjs')); } catch { /* optional in staged copies */ }
// An open, still-collecting card batch is held on purpose; staged copies without the module keep alerting.
let isCollectingBatchPr = () => false;
try { ({ isCollectingBatchPr } = await import('./card-batch-hold-state.mjs')); } catch { /* optional in staged copies */ }

// The optional ledger also pulls in a graph that staged CLI copies may omit.
let pausedReferrals = null;
try { pausedReferrals = await import('../conveyor/review-referral-hold.mjs'); } catch { /* staged copies */ }
let rulingLedger = null;
let rulingLedgerError = null;
try { rulingLedger = await import('../lib/ruling-ledger.mjs'); } catch (e) { rulingLedgerError = String(e?.message ?? e).split('\n')[0]; }
// The effective ladder says where a twice-ignored finding becomes the operator's; absent, the platform default stands.
let rulingHumanAt;
try { rulingHumanAt = (await import('../conveyor/fixer-ladder.mjs')).loadFixerLadder().humanAt; } catch { /* default */ }
// Staged CLI copies may omit the complete reader. Capped listings and the split fallback need it;
// an unavailable reader must fail that read, never substitute an empty comment thread.
let readCompletePrComments, enrichStandDownHeadChange;
let LIST_COMMENTS_PAGE_SIZE = 100;
let completeCommentsImportError;
try { ({ readCompletePrComments, enrichStandDownHeadChange, LIST_COMMENTS_PAGE_SIZE = 100 } = await import('../conveyor/pr-comments-complete.mjs')); }
catch (error) { completeCommentsImportError = error; }
// Standing-ruling round grants (PR #5758): the red-team rows credit an automatic grant only with this verified scope.
// A staged copy without the reader credits none (fail closed), as before.
let enrichPrsWithStandingRulingGrants = (prs) => prs;
try { ({ enrichPrsWithStandingRulingGrants } = await import('../conveyor/standing-ruling-io.mjs')); } catch { /* no automatic grant credit */ }
const hasLabel = (pr, name) => (pr.labels ?? []).some((label) => label.name === name);

/** Both GraphQL rollup variants, in the CheckRun shape used by every queue classifier. */
function queueChecks(pr) {
  return (pr?.statusCheckRollup ?? []).map((check) => {
    if (check.status !== undefined || typeof check.state !== 'string') return check;
    const state = check.state.toUpperCase();
    return { ...check, name: check.context,
      status: ['SUCCESS', 'FAILURE', 'ERROR'].includes(state) ? 'COMPLETED' : 'IN_PROGRESS', conclusion: state };
  }).filter((check) => check.name !== 'review-gate');
}

/**
 * RULING NEEDED row (live 2026-10-04, PR #3794: parked about 8 h with confirmed findings awaiting a ruling and no
 * alert anywhere). Derived from the PR thread alone, for ANY open PR (the park is the signal, whatever the labels
 * say), so it shows until a ruling or a new head clears it. `findings` is one line each plus the file.
 */
export function rulingNeededRow(repo, pr, options = {}) {
  // A throwing paused-referral read must never drop this PR (or the rest of the repo's sections): fall back to the
  // ordinary ledger read, as before this reader existed.
  let paused = null;
  try { paused = pausedReferrals?.pausedReviewRulingNeeded(pr, { repo, ...options }) ?? null; } catch { paused = null; }
  const need = paused ?? rulingLedger?.rulingNeeded(pr, rulingHumanAt === undefined ? {} : { humanAt: rulingHumanAt });
  if (!need) return null;
  return {
    repo, number: pr.number, title: pr.title, head: need.head,
    since: need.since === null ? null : new Date(need.since).toISOString(),
    findings: need.findings.map((f) => ({ ...(paused ? { key: f.key } : {}), file: f.file, line: f.line, summary: f.summary, reason: f.reason })),
  };
}

/** A red-team round-cap ruling and its read-only operator command suggestions. PURE. */
export function redTeamRulingRow(repo, pr, setting = CONFIRMED_BREAKS_DEFAULTS, { readSaved = null } = {}) {
  const need = redTeamRulingNeeded(pr, setting, { readSaved, repo: repo || pr?.repo || null });
  if (!need) return null;
  const command = `node scripts/review-set-label.mjs ${pr.number} --repo=${repo}`;
  return {
    repo, number: pr.number, title: pr.title, head: need.head, since: need.since,
    findings: need.findings.map(({ file, line, summary }) => ({ file, line, summary, reason: 'red-team-round-cap' })),
    redTeam: true,
    commands: {
      block: `${command} --to=changes --body-file=<fix-list.md> --actor=<your login> --channel='<where you ruled>'`,
      notReal: `${command} --to=clear-human --actor=<your login> --reason='<your words>'`,
    },
  };
}

/** Combine both ruling sources for the same PR without changing either source row. PURE. */
export function mergeRulingRows(ledger, redTeam) {
  if (!ledger || !redTeam || ledger.repo !== redTeam.repo || ledger.number !== redTeam.number) {
    return [ledger, redTeam].filter(Boolean);
  }
  return [{
    ...ledger, findings: [...ledger.findings, ...redTeam.findings], redTeam: true, commands: redTeam.commands,
  }];
}

/** The open-PR listing's stdout cap (it carries every PR's comments). See the listing call in `main`. */
export const PR_LIST_MAX_BUFFER = 256 * 1024 * 1024;

/** The `review:*` label an opening path adds beside `review:human` until the advisory comment posts. */
export const AWAITING_ADVISORY_LABEL = 'review:awaiting-advisory';

/** How many times an UNKNOWN mergeability is re-polled, and the first backoff (doubling each attempt). */
export const MERGEABLE_POLL_ATTEMPTS = 4;
export const MERGEABLE_POLL_DELAY_MS = 1000;

/**
 * Evaluate one PR against every readiness gate. Pure.
 * @returns {{ready: boolean, reasons: string[], transient: boolean}} `transient` is true when the ONLY thing
 *   between this PR and `ready` is GitHub's still-computing mergeability — `ready` is then false and `reasons` empty.
 */
export function evaluatePr(pr, { redTeamSetting = CONFIRMED_BREAKS_DEFAULTS, mergeGateVerdict } = {}) {
  const reasons = operatorSendBackHoldReasons(pr);
  if (!hasLabel(pr, 'review:human')) reasons.push('no review:human label');

  const advisory = latestAdvisory(pr.comments);
  const head = (pr.headRefOid ?? '').toLowerCase();
  const covers = advisory ? advisoryCoversHead(advisory, head) : false;
  if (!advisory) {
    reasons.push('no advisory verdict');
  } else if (!covers) {
    reasons.push(`advisory is on ${advisory.head.toLowerCase().slice(0, 9)}, head is ${head.slice(0, 9)}`);
  }
  if (advisory?.outcome === ADVISORY_OUTCOMES.CHANGES || hasLabel(pr, 'review:changes')) {
    reasons.push('changes requested');
  }
  if (hasLabel(pr, 'review:pending')) reasons.push('review:pending label (advisory not accepted yet)');

  // THE LABEL GATE, and its cross-check against the parsed comment. `parsed` is what the comment says about the
  // CURRENT head: a stale or missing advisory says nothing, so any advisory label riding on it is a disagreement.
  const accepted = hasLabel(pr, ADVISORY_LABELS.ACCEPTED);
  const changes = hasLabel(pr, ADVISORY_LABELS.CHANGES);
  const parsed = advisory && covers ? advisory.outcome : null;
  const parsedText = parsed
    ? `advisory comment says ${parsed} on this head`
    : (advisory ? 'advisory comment is not on this head' : 'no advisory comment');
  if (accepted && changes) {
    reasons.push(`label/comment disagreement: ${ADVISORY_LABELS.ACCEPTED} and ${ADVISORY_LABELS.CHANGES} are both set`);
  } else if (accepted && parsed !== ADVISORY_OUTCOMES.ACCEPT) {
    reasons.push(`label/comment disagreement: ${ADVISORY_LABELS.ACCEPTED} is set but ${parsedText}`);
  } else if (changes && parsed !== ADVISORY_OUTCOMES.CHANGES) {
    reasons.push(`label/comment disagreement: ${ADVISORY_LABELS.CHANGES} is set but ${parsedText}`);
  } else if (!accepted && parsed === ADVISORY_OUTCOMES.ACCEPT) {
    reasons.push(`label/comment disagreement: ${parsedText} but ${ADVISORY_LABELS.ACCEPTED} is absent`);
  } else if (parsed && parsed !== ADVISORY_OUTCOMES.ACCEPT && parsed !== ADVISORY_OUTCOMES.CHANGES) {
    // A converted note's `inconclusive` (PR #2781 review, round 4): neither cleared nor blocking, no label owed.
    reasons.push(`advisory is ${parsed} on this head (a human must confirm the escalation)`);
  }

  // #4722 — `review:awaiting-advisory` says "the advisory has not posted yet". When the comment on this head exists
  // the label is stale, and that is a disagreement like any other: reported, never resolved silently here. Its
  // owner (the advisory-label sweep's repair path) clears it. Without an advisory on this head the label is
  // consistent and the "no advisory" reasons above already explain the wait.
  if (hasLabel(pr, AWAITING_ADVISORY_LABEL) && parsed) {
    reasons.push(`label/comment disagreement: ${AWAITING_ADVISORY_LABEL} is set but ${parsedText}`);
  }

  // Card x1b8hlo — the post-accept red team CONFIRMED a break on this exact head that `redTeam.confirmedBreaks` sends
  // back: the fixer owns it, not the operator (live PR #4722). A new head clears it; the gate's `round-cap` record
  // hands it to the operator instead.
  const redTeam = redTeamQueueReason(pr, redTeamSetting);
  if (redTeam) reasons.push(redTeam);

  const checks = queueChecks(pr);
  const pending = checks.filter((check) => check.status !== 'COMPLETED');
  let failing = checks.filter((check) => check.status === 'COMPLETED'
    && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion));
  const mergeGateFailures = failing.filter((check) => check.name === 'merge-gate');
  let humanHolds;
  let verdictReason;
  if (mergeGateFailures.length === 1 && mergeGateVerdict) {
    if (mergeGateVerdictImportError || mergeGateVerdict.error || !Array.isArray(mergeGateVerdict.results)) {
      verdictReason = `merge-gate verdict unreadable: ${mergeGateVerdictImportError || mergeGateVerdict.error || 'missing results'}`;
    } else if (!head || String(mergeGateVerdict.headSha ?? '').toLowerCase() !== head) {
      verdictReason = `merge-gate verdict is for ${String(mergeGateVerdict.headSha ?? '').slice(0, 9)}, head is ${head.slice(0, 9)}`;
    } else {
      const { only, holds, others } = humanReviewOnlyHold(mergeGateVerdict.results);
      if (only) {
        failing = failing.filter((check) => check !== mergeGateFailures[0]);
        humanHolds = holds;
      } else {
        verdictReason = `merge-gate holds beyond human review: ${others.map(({ id, status }) => `${id}(${status})`).join(', ') || 'no human review hold'}`;
      }
    }
  }
  const names = (entries) => entries.map((check) => check.name || check.context || 'unnamed check').join(', ');
  if (failing.length) reasons.push(`CI failing: ${names(failing)}`);
  if (verdictReason) reasons.push(verdictReason);
  if (pending.length) reasons.push(`CI pending: ${names(pending)}`);
  if (hasLabel(pr, 'ci:failed')) reasons.push('ci:failed label');

  if (pr.mergeable === 'CONFLICTING' || hasLabel(pr, 'merge-status:conflicting')) {
    reasons.push('conflicts with base');
  }
  const mergeabilityUnknown = pr.mergeable !== 'MERGEABLE' && pr.mergeable !== 'CONFLICTING';
  const transient = mergeabilityUnknown && reasons.length === 0;
  // Read logs only when this single check is all that stands between the PR and the operator.
  const needsMergeGateVerdict = !mergeGateVerdict && mergeGateFailures.length === 1
    && failing.length === 1 && reasons.length === 1 && reasons[0] === 'CI failing: merge-gate';
  return { ready: reasons.length === 0 && !mergeabilityUnknown, reasons, transient,
    ...(humanHolds ? { humanHolds } : {}),
    ...(needsMergeGateVerdict ? { needsMergeGateVerdict: true, mergeGateCheck: mergeGateFailures[0] } : {}),
  };
}

/** A non-review:human PR owes clear-human only when the live job proves a human-only acceptance hold. Pure. */
export function evaluateCeremonyOwed(pr, { redTeamSetting = CONFIRMED_BREAKS_DEFAULTS, mergeGateVerdict } = {}) {
  const reasons = operatorSendBackHoldReasons(pr);
  if (pr.isDraft) reasons.push('draft PR');
  for (const label of ['review:human', 'review:changes', 'review:pending', 'status:sent-back-red-team', 'ci:failed', 'merge-status:conflicting']) {
    if (hasLabel(pr, label)) reasons.push(`${label} label`);
  }
  const redTeam = redTeamQueueReason(pr, redTeamSetting);
  if (redTeam) reasons.push(redTeam);
  const checks = queueChecks(pr);
  if (checks.some((check) => check.status !== 'COMPLETED')) reasons.push('CI pending');
  const failing = checks.filter((check) => check.status === 'COMPLETED'
    && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion));
  if (failing.length !== 1 || failing[0].name !== 'merge-gate') reasons.push('CI must fail only merge-gate');
  if (pr.mergeable !== 'MERGEABLE') reasons.push('not MERGEABLE');
  if (reasons.length) return { owed: false, reasons };
  if (mergeGateVerdict === undefined) {
    return { owed: false, reasons, needsMergeGateVerdict: true, mergeGateCheck: failing[0] };
  }
  if (mergeGateVerdictImportError || !mergeGateVerdict || mergeGateVerdict.error || !Array.isArray(mergeGateVerdict.results)) {
    return { owed: false, reasons: ['merge-gate verdict unreadable'] };
  }
  const head = String(pr.headRefOid ?? '').toLowerCase();
  if (!head || String(mergeGateVerdict.headSha ?? '').toLowerCase() !== head) {
    return { owed: false, reasons: ['merge-gate verdict is not for the live head'] };
  }
  const { only, holds } = humanReviewOnlyHold(mergeGateVerdict.results);
  const acceptance = mergeGateVerdict.results.find((row) => row.id === 'review-acceptance'
    && row.status === 'hold' && /human-only/i.test(row.reason));
  if (!only || !acceptance) return { owed: false, reasons: ['merge-gate does not hold only for human-only review-acceptance'] };
  const detail = String(acceptance.reason).trim().slice(0, 160);
  const reason = `clear-human owed at live head ${head.slice(0, 9)}: merge-gate holds review-acceptance as human-only (${detail})`
    + (hasLabel(pr, 'review:accepted') ? ' — review:accepted is stale (from an older head)' : '');
  return { owed: true, reasons, reason, holds };
}

/** Bind a job's own verdict to its head; missing or unreadable evidence never excuses CI. */
export function readMergeGateVerdict({ repo, check, number, exec = execFileSync }) {
  try {
    if (mergeGateVerdictImportError) return { error: mergeGateVerdictImportError };
    const id = check?.detailsUrl?.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1];
    if (!id) return { error: 'merge-gate check URL has no job id' };
    const endpoint = `repos/${repo}/actions/jobs/${id}`;
    const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 };
    const job = JSON.parse(exec('gh', ['api', endpoint], options));
    if (typeof job?.head_sha !== 'string' || !job.head_sha) return { error: 'job has no head_sha' };
    const log = exec('gh', ['api', `${endpoint}/logs`], options);
    const parsed = parsePrResultTable(log, number);
    return parsed.error ? parsed : { headSha: job.head_sha, ...parsed };
  } catch (error) {
    return { error: String(error?.message ?? error).split('\n')[0] };
  }
}

/**
 * Build the STUCK — INSPECTED row for a PR the stuck-PR watch (epic #3383) has already dispatched at least one
 * diagnosis-only inspection agent for, or `null` for a PR carrying no such marker. Pure — reuses
 * {@link stuckDispatchEpisodes} (`we:scripts/conveyor/stuck-pr-watch-core.mjs`) rather than re-deriving the
 * marker match, mirroring {@link standDownRow}'s own "read the same durable marker the watch itself reads"
 * shape. The MOST RECENT episode is what's surfaced when a PR has been inspected more than once.
 * @param {string} repo
 * @param {{number:number, title:string, comments?: unknown}} pr
 * @returns {{repo:string, number:number, title:string, episodes:number, lastEpisode:string}|null}
 */
export function stuckInspectedRow(repo, pr) {
  const episodes = stuckDispatchEpisodes(pr.comments);
  if (!episodes.length) return null;
  return { repo, number: pr.number, title: pr.title, episodes: episodes.length, lastEpisode: episodes[episodes.length - 1] };
}

/**
 * Build the STOOD DOWN row for a PR that carries at least one stand-down comment, or `null` for a PR that carries
 * none. Pure — reuses {@link standDownComments}/{@link standDownReason} rather than
 * re-deriving the leading-line marker match; this function only shapes the ones that already matched.
 *
 * When a PR has stood down more than once (cleared, then stood down again), the MOST RECENT comment is what's
 * surfaced — same "most recent wins" convention `latestAdvisory` uses, sorted by `createdAt` (ties keep array
 * order) rather than assuming `gh` always returns comments oldest-first.
 * @param {string} repo
 * @param {{number:number, title:string, comments?: unknown, labels?: Array<{name:string}>}} pr
 * @returns {{repo:string, number:number, title:string, standDownAt: ?string, reason: ?string, alsoReviewHuman: boolean}|null}
 */
export function standDownRow(repo, pr) {
  const matches = standDownComments(pr.comments, { headRefOid: pr.headRefOid, headChangedAt: standDownHeadChangeAt(pr) });
  if (!matches.length) return null;
  const latest = matches
    .map((c, index) => ({ ...c, time: Date.parse(c.createdAt) || 0, index }))
    .sort((a, b) => b.time - a.time || b.index - a.index)[0];
  return {
    repo,
    number: pr.number,
    title: pr.title,
    standDownAt: latest.createdAt,
    reason: standDownReason(latest.body),
    alsoReviewHuman: hasLabel(pr, 'review:human'),
  };
}

// Card 334 — NEEDS YOUR MERGE. The drain never enqueues a PR whose diff touches a workflow or action file (only a
// person may land it), so an approved, all-green one sat silent (#5193, #5253, #5298). Optional like the siblings
// above: a staged CLI copy without the enqueue module simply shows no such rows.
let workflowEditHold = null;
let readMergeQueueState = null;
try { ({ workflowEditHold, readMergeQueueState } = await import('../lib/merge-queue-enqueue.mjs')); } catch { /* no needs-your-merge rows */ }

const NEEDS_YOUR_MERGE_BLOCKING_LABELS = ['review:human', 'review:changes', 'review:pending', 'ci:failed', 'merge-status:conflicting'];

/**
 * Card 334 — the cheap half of "needs your merge", from the listing alone: approved, not held, mergeable, and every
 * check green. Only a PR passing this costs the extra changed-files read. Pure.
 * @returns {string[]} reasons it is not a candidate (empty = candidate)
 */
export function needsYourMergePrecheck(pr) {
  const reasons = [];
  if (pr?.isDraft) reasons.push('draft PR');
  if (pr?.isInMergeQueue === true) reasons.push('already in merge queue');
  if (!hasLabel(pr, 'review:accepted')) reasons.push('no review:accepted label');
  for (const label of NEEDS_YOUR_MERGE_BLOCKING_LABELS) if (hasLabel(pr, label)) reasons.push(`${label} label`);
  if (pr?.mergeable !== 'MERGEABLE') reasons.push('not MERGEABLE');
  const checks = queueChecks(pr);
  if (!checks.length) reasons.push('no checks');
  if (checks.some((check) => check.status !== 'COMPLETED' || !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion))) {
    reasons.push('checks not all green');
  }
  return reasons;
}

/**
 * Card 334 — is this an approved PR that passes every gate except the person-only enqueue? The precheck plus the
 * drain's own human-only rule (`workflowEditHold`) on its full change list. Pure.
 * @param {object} pr - a listing row
 * @param {{files?: Array<string|{path:string}|{filename:string, previous_filename?:string}>, changedFiles?: number}} o
 * @returns {{owed:boolean, paths:string[], reasons:string[]}}
 */
export function evaluateNeedsYourMerge(pr, { files, changedFiles } = {}) {
  const reasons = needsYourMergePrecheck(pr);
  if (reasons.length) return { owed: false, paths: [], reasons };
  if (!workflowEditHold) return { owed: false, paths: [], reasons: ['workflow-edit rule unavailable'] };
  // Strings, `gh pr view` rows (`{path}`) and REST rows (`{filename, previous_filename}`) are all accepted.
  const list = Array.isArray(files) ? files.map((f) => (typeof f === 'string' || f?.filename ? f : f?.path)) : files;
  const hold = workflowEditHold({ files: list, expectedCount: changedFiles });
  if (hold.hold && hold.humanOnly) return { owed: true, paths: hold.paths, reasons: [] };
  return { owed: false, paths: [], reasons: [hold.hold ? hold.error : 'touches no workflow or action file — the drain lands it'] };
}

/**
 * Card 334 — the one command the operator runs for a needs-your-merge row. Pure. It goes through
 * an explicit fast-forward update so even a checkout predating `we:scripts/run-fresh.mjs` gets the launcher.
 * The launcher then runs it from a fresh lane at origin/main. A failed update stops before the operation runs.
 */
export function needsYourMergeCommand({ repo, number }) {
  return `git pull --ff-only origin main && node scripts/run-fresh.mjs land-human-only --pr=${number} --repo=${repo} --actor=<your login> `
    + "--channel=<where you said it> --reason='<your words>'";
}

/**
 * #3383 — LANE RECLAIM, best-effort. `lane-whois.mjs` (a SEPARATE module — see that file's own header) is
 * the read-only per-lane report over the WE lane pool; this shells out to its `--json` output rather than
 * statically importing it, so a host/checkout with no lane pool at all (or a copy of this file staged without
 * that sibling, as `operator-queue-entry.test.mjs` does) degrades to an EMPTY queue instead of failing this
 * whole report. Only `finished-needs-review` / `unknown-work` lanes are worth the operator's time — an
 * `in-use` or `finished-reclaimable` lane needs no decision at all (the latter's dry-run reclaim plan is
 * `lane-whois.mjs`'s own concern, never actioned here).
 */
export function laneReclaimQueue({ exec = execFileSync, scriptDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  try {
    const script = join(scriptDir, '..', 'lane-whois.mjs');
    // A full-pool scan is genuinely slow — one `git` read (or more) per lane, times every lane in the pool,
    // plus a `gh pr search` per distinct guessed card — 9+ minutes measured live against the real ~65-lane WE
    // pool under normal host contention. A short timeout here silently degrades every run to "[]" long before
    // that, which is worse than just being slow: it reads as "nothing needs a decision" instead of "unknown".
    const out = exec('node', [script, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20 * 60_000 });
    const report = JSON.parse(out);
    return (report.lanes || [])
      // #4139 — `!row.kept`: an operator's `lane-pool.mjs keep --lane=N` call (still fresh — its fingerprint
      // matches this lane's CURRENT content, see `we:scripts/lib/lane-whois-core.mjs#keepMarkerApplies`)
      // excludes the lane from this list until its content changes again.
      .filter((row) => row.exists && !row.kept && (row.verdict === 'finished-needs-review' || row.verdict === 'unknown-work'))
      .map((row) => ({
        lane: row.lane, path: row.path, verdict: row.verdict, reason: row.reason,
        // #4139 — carried through so the CLI print below can offer the RIGHT one-click reclaim command: plain
        // `reclaim` for a lane whose content is already provably preserved (true for some `unknown-work` rows
        // — preservation doesn't gate that verdict), `reclaim --override` only when it's actually needed.
        preserved: row.preserved,
      }));
  } catch {
    return []; // no pool on this host, no gh/claude available, or the sibling module isn't staged — never fail the PR queue over this
  }
}

/**
 * we:xniq7xs — the live per-repo pr-limit counts, via a CHILD PROCESS to `node scripts/lib/pr-limit.mjs
 * status` — mirrors {@link laneReclaimQueue}'s own subprocess pattern immediately above, same reason: that
 * module's own dependencies (the throttled-gh admission chain, the review-label rubric) are real and
 * legitimately heavier than this report's, so shelling it out (rather than statically importing it) keeps
 * THIS file's own module graph light and its checkout-staging contract unchanged — a host/checkout without
 * `pr-limit.mjs` degrades to an EMPTY count list rather than failing this whole report.
 */
export function prLimitCounts({ exec = execFileSync, scriptDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  try {
    const script = join(scriptDir, '..', 'lib', 'pr-limit.mjs');
    const out = exec('node', [script, 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed?.counts) ? parsed.counts : [];
  } catch {
    return [];
  }
}

/** we:xniq7xs — of the live per-repo pr-limit counts ({@link prLimitCounts}'s own shape), the ones actually
 *  AT/OVER their cap — the operator-queue BACKPRESSURE alert line's row shape. Pure — no gh, no fs, no
 *  child-process; the live IO is {@link prLimitCounts}'s job. Skips a repo whose count is `unavailable` (a
 *  gh read failed) — there is nothing to alert on from an unknown count, and a transient gh hiccup must
 *  never manufacture a false alarm. */
export function backpressureRows(counts) {
  return (Array.isArray(counts) ? counts : [])
    .filter((c) => c && c.unavailable !== true && Number.isFinite(c.limit) && Number(c.count) >= c.limit)
    .map((c) => ({ repo: c.repoKey, count: c.count, limit: c.limit, prNumbers: Array.isArray(c.prNumbers) ? c.prNumbers : [] }));
}

/**
 * we:xg460kw (#4191, epic #4075/#3383) — RECONCILE NOTES: `we:scripts/conveyor/reconcile-core.mjs#planReconcile`
 * already emits `notes` (`ci-heal-exhausted` — a PR out of CI-fix attempts; `awaiting-permission` — a bound
 * session blocked on a prompt with nobody there to answer it), but nothing ever surfaced either one to the
 * operator's OWN read-only queue — an exhausted PR looked identical to any other quiet PR here, and the operator
 * only reviews a PR once it is "clean … AND its advisory has run" (this file's own header), so an exhausted PR
 * with no advisory at all was never on the list at all.
 *
 * SHELLS `node scripts/conveyor/reconcile-pass.mjs --repo=<slug> --json` — mirrors {@link laneReclaimQueue}'s and
 * {@link prLimitCounts}'s own subprocess pattern just above, and for the SAME reason this file's own header
 * already states for `stuck-pr-dispatch-marker.mjs` vs `stuck-pr-watch-core.mjs`: a static import of
 * `reconcile-pass.mjs` (or `reconcile-core.mjs`) pulls in a MUCH heavier transitive graph
 * (`rearm-review.mjs` → `review-set-label.mjs` → `merge-ai-prs.mjs`, plus `dispatch-lane.mjs`/`jury-core.mjs`/…)
 * than this file's own mocked `node:child_process` test setup (and its staged-copy CLI-entry test) stage —
 * exactly the breakage that file's own comment already documents. Shelling the EXISTING CLI (`reconcile-pass.mjs`
 * already prints `{dispatch, refusals, notes, prs, agents}` as JSON via `--json`) reuses the SAME `planReconcile`
 * plan a reconcile tick runs, without adding a single new static import to this file's own module graph.
 * @param {string[]} repos - repo slugs to read (`gh --repo <slug>` shape, mirrors every other section's loop).
 * @param {{exec?:Function, scriptDir?:string}} [io] - `exec` is injectable (defaults to the real
 *   `execFileSync`), mirrors {@link laneReclaimQueue}'s own IO shape.
 * @returns {Array<object>} every note this read saw, repo-tagged (`{...note, repo}`); a repo whose read fails
 *   (or returns unparsable output) contributes one synthetic `notes-read-failed` row rather than failing the
 *   whole report.
 */
export function reconcileNotesFor(repos, { exec = execFileSync, scriptDir = dirname(fileURLToPath(import.meta.url)) } = {}) {
  const notes = [];
  for (const repo of repos) {
    try {
      const script = join(scriptDir, '..', 'conveyor', 'reconcile-pass.mjs');
      const out = exec('node', [script, `--repo=${repo}`, '--json'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      });
      const parsed = JSON.parse(out);
      for (const n of (parsed?.notes ?? [])) notes.push({ ...n, repo });
    } catch (e) {
      notes.push({
        repo, kind: 'notes-read-failed', prNumber: null,
        text: String(e?.stderr || e?.message || e).trim().split('\n')[0],
      });
    }
  }
  return notes;
}

/** Blocking sleep for synchronous PR-read retries and UNKNOWN-mergeability polling. */
const blockingSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Re-poll one PR's mergeability until GitHub reports a definite answer or the attempts run out. GitHub computes
 * `mergeable` on request, so the answer usually arrives on the first or second poll. A failed poll counts as
 * "still unknown" — it must never turn a transient state into a hard failure.
 * @returns {string} the last `mergeable` value seen (`UNKNOWN` if it never settled).
 */
export function pollMergeable({
  repo, number, exec = execFileSync, sleep = blockingSleep,
  attempts = MERGEABLE_POLL_ATTEMPTS, delayMs = MERGEABLE_POLL_DELAY_MS,
}) {
  let mergeable = 'UNKNOWN';
  for (let attempt = 0; attempt < attempts && mergeable === 'UNKNOWN'; attempt += 1) {
    sleep(delayMs * 2 ** attempt);
    try {
      const out = exec('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'mergeable'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      mergeable = JSON.parse(out).mergeable || 'UNKNOWN';
    } catch { /* transient — keep the last known value and try again */ }
  }
  return mergeable;
}

/** Declared setting: operatorQueue.readAttempts; env wins, default 3, minimum 2. Pure. */
export function resolveReadAttempts({ env = {}, file = {} } = {}) {
  for (const [raw, source] of [
    [env.OPERATOR_QUEUE_READ_ATTEMPTS, 'env'], [file?.operatorQueue?.readAttempts, 'settings'],
  ]) {
    if (!['string', 'number'].includes(typeof raw) || String(raw).trim() === '') continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value)) return { value: Math.max(2, value), source };
  }
  return { value: 3, source: 'default' };
}

function permanentPrReadFailure(error) {
  if (error?.code === 'INVALID_PR_RESPONSE') return true;
  const detail = `${error?.stderr ?? ''} ${error?.message ?? error}`;
  return /Could not resolve to a Repository|\bHTTP\s+(?:401|404)\b|bad credentials|authentication (?:failed|required)|requires authentication|not logged (?:in|into)|gh auth login|resource not accessible by (?:integration|personal access token)/i.test(detail);
}

/** Retry transient transport/JSON failures with at most four seconds of backoff per read. */
function retryPrRead(read, { attempts, sleep }) {
  let lastError;
  let backoffMs = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return read(lastError);
    } catch (error) {
      if (permanentPrReadFailure(error) || attempt === attempts - 1 || backoffMs >= 4000) throw error;
      lastError = error;
      const delayMs = Math.min(500 * 2 ** Math.min(attempt, 3), 4000 - backoffMs);
      sleep(delayMs);
      backoffMs += delayMs;
    }
  }
}

function readPrJson(args, { attempts, sleep, valid }) {
  return retryPrRead((lastError) => {
    const response = execFileSync('gh', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: PR_LIST_MAX_BUFFER,
    });
    if (typeof response !== 'string') {
      // Preserve the preceding transport diagnostic when no response follows it.
      throw Object.assign(new Error(lastError?.message ?? 'invalid PR read response: expected a string'), {
        code: 'INVALID_PR_RESPONSE', stderr: lastError?.stderr,
      });
    }
    const value = JSON.parse(response);
    if (!valid(value)) throw new Error('invalid PR read response');
    return value;
  }, { attempts, sleep });
}

export function main(args = process.argv.slice(2), { sleep = blockingSleep, pollAttempts, pollDelayMs, unsupportedPath } = {}) {
  const standDownQueueSection = reviewSettings?.resolveReviewSettings().standDownQueueSection ?? 'needs-you';
  console.error(`operator-queue: standDownQueueSection=${standDownQueueSection} (source: ${reviewSettings ? reviewSettings.resolveReviewSettingSource('standDownQueueSection') : 'built-in'})`);
  const readAttempts = resolveReadAttempts({ env: process.env, file: readSettings() });
  console.error(`operator-queue: read attempts=${readAttempts.value} (source: ${readAttempts.source})`);
  const read = (argv, valid) => readPrJson(argv, { attempts: readAttempts.value, sleep, valid });
  const requested = args.filter((arg) => arg.startsWith('--repo=')).map((arg) => arg.slice(7));
  const unsupported = readUnsupported({ path: unsupportedPath }).filter(
    (row) => !requested.length || requested.some((repo) => repoKeyForSlug(repo) === row.repo),
  );
  // #3383 — LANE RECLAIM is opt-in via `--with-lanes` (a real `node`+`lane-whois.mjs` subprocess call, best-
  // effort): a bare `main()` call must stay side-effect-free over the PR queue's own `execFileSync('gh', …)`
  // sequence — several existing tests replace the WHOLE `node:child_process` module with one shared mock
  // queued per expected gh call, and an unconditional extra call here would silently consume one of those
  // slots and cascade-fail every assertion after it. Real operator usage passes the flag explicitly.
  const laneDecisions = args.includes('--with-lanes') ? laneReclaimQueue() : [];
  // we:xniq7xs — BACKPRESSURE is opt-in via `--with-backpressure`, mirroring `--with-lanes` just above and for
  // the SAME reason (see that flag's own comment): it is a real extra `gh` round-trip (one throttled `pr list`
  // per constellation repo, `countOpenPrsAllRepos`), and a bare `main()` call must stay side-effect-free over
  // this file's own PR-queue `execFileSync('gh', …)` sequence so the shared-mock call-queue tests above are
  // never silently thrown off by an uncounted extra call.
  const backpressure = args.includes('--with-backpressure') ? backpressureRows(prLimitCounts()) : [];
  // #4077 — HEALTH is opt-in via `--with-health`, like the two sections above: it reads the health watch's own
  // store (`we:scripts/conveyor/health-watch-section.mjs`, no child process). When on, it is the FIRST thing
  // printed, and its first line is the health watch's last-tick-completed age.
  const health = args.includes('--with-health') ? healthSectionLines() : null;
  // #4191 (epic #4075/#3383) — RECONCILE NOTES is opt-in via `--with-reconcile-notes`, mirroring every section
  // above and for the SAME reason (a real extra `node reconcile-pass.mjs` subprocess per repo — see
  // `reconcileNotesFor`'s own docblock — which a bare `main()` call must stay side-effect-free over).
  const repoSlugs = requested.length ? requested : Object.values(CONSTELLATION_REPOS).map(({ slug }) => slug);
  const reconcileNotes = args.includes('--with-reconcile-notes') ? reconcileNotesFor(repoSlugs) : [];
  const report = {
    ready: [], rulingNeeded: [], needsPerson: [], pending: [], notReady: [], stoodDown: [], stuck: [], errors: [], unsupported, laneDecisions, backpressure, reconcileNotes, ...(health ? { health } : {}),
  };
  if (rulingLedgerError) report.errors.push(`ruling-needed section unavailable: ${rulingLedgerError}`);
  if (sendBackLedgerError) report.errors.push(`operator send-back check unavailable: ${sendBackLedgerError}`);
  if (savedRedTeamError) report.errors.push(`saved red-team ruling check unavailable: ${savedRedTeamError}`);
  let readFailures = 0;
  const failedRead = (subject, error) => {
    readFailures += 1;
    const detail = String(error.stderr || error.message || error).trim().replace(/\s+/g, ' ');
    report.errors.push(`${subject}: ${detail}`);
  };
  for (const repo of repoSlugs) {
    try {
      const fields = 'number,title,labels,headRefOid,mergeable,statusCheckRollup,isDraft,body,createdAt';
      const listing = ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json'];
      const completePr = (pr) => {
        try {
          const comments = retryPrRead(() => {
            if (!readCompletePrComments) throw completeCommentsImportError;
            return readCompletePrComments(pr.number, { repo, exec: execFileSync });
          }, { attempts: readAttempts.value, sleep });
          return [{ ...pr, comments }];
        } catch (error) {
          failedRead(`${repo}#${pr.number}`, error);
          // Never classify a PR using a missing or partial thread.
          return [];
        }
      };
      let prs;
      // Short threads keep the one-call success path; capped threads need a complete read.
      // Only after its final failed attempt fall back to a small listing plus separate comment reads.
      try {
        prs = read([...listing, `${fields},comments`], Array.isArray);
        prs = prs.flatMap((pr) => Array.isArray(pr.comments) && pr.comments.length >= LIST_COMMENTS_PAGE_SIZE
          ? completePr(pr) : [pr]);
      } catch (error) {
        if (permanentPrReadFailure(error)) throw error;
        prs = read([...listing, fields], Array.isArray);
        prs = prs.flatMap(completePr);
      }
      // The repo travels with each PR: the red-team readers credit an operator round grant only for the PR's own repo.
      prs = enrichPrsWithStandingRulingGrants(prs.map(pr => ({ ...(enrichStandDownHeadChange?.(pr, { repo, exec: execFileSync }) ?? pr), repo: pr.repo ?? repo })), { repo });
      const readyNumbersThisRepo = new Set();
      const redTeamSetting = readConfirmedBreaks().value;
      for (const listed of prs.filter((candidate) => hasLabel(candidate, 'review:human'))) {
        let pr = listed;
        let result = evaluatePr(pr, { redTeamSetting });
        let mergeGateVerdict;
        if (result.needsMergeGateVerdict) {
          mergeGateVerdict = readMergeGateVerdict({ repo, check: result.mergeGateCheck, number: pr.number });
          result = evaluatePr(pr, { redTeamSetting, mergeGateVerdict });
        }
        // Only a PR that would otherwise be ready is worth re-polling — one with a real failure is not-ready
        // whatever GitHub says about mergeability.
        if (result.transient) {
          pr = { ...pr, mergeable: pollMergeable({
            repo, number: pr.number, sleep, attempts: pollAttempts, delayMs: pollDelayMs,
          }) };
          result = evaluatePr(pr, { redTeamSetting, mergeGateVerdict });
        }
        const row = { repo, number: pr.number, title: pr.title };
        if (result.ready) {
          report.ready.push({ ...row, ...(result.humanHolds ? { humanHolds: result.humanHolds } : {}) });
          readyNumbersThisRepo.add(pr.number);
        } else if (result.transient) report.pending.push(row);
        else report.notReady.push({ ...row, reasons: result.reasons });
      }
      for (const pr of prs.filter((candidate) => !hasLabel(candidate, 'review:human'))) {
        const sendBackReasons = operatorSendBackHoldReasons(pr);
        if (sendBackReasons.length) {
          report.notReady.push({ repo, number: pr.number, title: pr.title, reasons: sendBackReasons });
          continue;
        }
        let result = evaluateCeremonyOwed(pr, { redTeamSetting });
        if (result.needsMergeGateVerdict) {
          const mergeGateVerdict = readMergeGateVerdict({ repo, check: result.mergeGateCheck, number: pr.number });
          result = evaluateCeremonyOwed(pr, { redTeamSetting, mergeGateVerdict });
        }
        if (result.owed) {
          report.ready.push({ repo, number: pr.number, title: pr.title, ceremonyOwed: true,
            reason: result.reason, humanHolds: result.holds });
          readyNumbersThisRepo.add(pr.number);
        }
      }
      // Card 334 — NEEDS YOUR MERGE: approved human-only PRs that pass every gate except the person-only enqueue.
      for (const pr of prs) {
        if (readyNumbersThisRepo.has(pr.number) || !workflowEditHold || needsYourMergePrecheck(pr).length) continue;
        // `gh pr view --json files` stops at 100 files, so the full list comes from the paginated REST read (renames
        // carry `previous_filename`), checked against GitHub's own count.
        let changed;
        try {
          const { changedFiles } = read(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'changedFiles'],
            (value) => value && Number.isInteger(value.changedFiles));
          const pages = read(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr.number}/files?per_page=100`], Array.isArray);
          changed = { files: pages.flat(), changedFiles };
        } catch (error) { failedRead(`${repo}#${pr.number}`, error); continue; }
        const result = evaluateNeedsYourMerge(pr, changed);
        if (!result.owed) continue;
        const queue = readMergeQueueState({ repo, pr: pr.number, readJson: (args) => read(args, (value) => value && typeof value === 'object') });
        if (queue.error || queue.head !== pr.headRefOid) {
          failedRead(`${repo}#${pr.number}`, new Error(queue.error || 'PR head moved since the listing; re-run'));
          continue;
        }
        if (queue.inQueue) continue;
        (report.needsYourMerge ??= []).push({ repo, number: pr.number, title: pr.title, paths: result.paths,
          command: needsYourMergeCommand({ repo, number: pr.number }) });
        readyNumbersThisRepo.add(pr.number);
      }
      for (const pr of prs) {
        // The gate can hold a break decided on saved evidence (its comment withheld); unreadable evidence is a visible error.
        let redTeamRow = null;
        try {
          redTeamRow = redTeamRulingRow(repo, pr, redTeamSetting,
            { readSaved: savedRedTeamFallback?.({ repo, pr: pr.number, head: pr.headRefOid }) ?? null });
        } catch (error) { failedRead(`${repo}#${pr.number} red-team ruling`, error); }
        let ledgerRow = null;
        try { ledgerRow = rulingNeededRow(repo, pr); } catch (error) { failedRead(`${repo}#${pr.number} ruling-needed`, error); }
        report.rulingNeeded.push(...mergeRulingRows(ledgerRow, redTeamRow));
      }
      for (const pr of prs) {
        if (readyNumbersThisRepo.has(pr.number)) continue;
        const row = needsPersonRow?.(repo, pr);
        if (!row) continue;
        // Only the withdrawn-draft notice is expected for a collecting batch; any other person-note still raises.
        if (row.kind === 'draft-withdrawn' && pr.isDraft === true && isCollectingBatchPr(repo, pr.number)) continue;
        const notReady = report.notReady.findIndex(r => r.repo === repo && r.number === pr.number);
        report.needsPerson.push({ ...row, alsoNotReady: notReady < 0 ? [] : report.notReady.splice(notReady, 1)[0].reasons });
      }
      // STOOD DOWN — every OPEN PR (any labels) carrying a stand-down comment, minus anything already in NEEDS
      // YOU above. `standDownComments` is the reused, single-sourced gate for "does this PR qualify at all".
      for (const pr of prs) {
        if (readyNumbersThisRepo.has(pr.number)) continue;
        if (standDownComments(pr.comments, { headRefOid: pr.headRefOid, headChangedAt: standDownHeadChangeAt(pr) }).length === 0) continue;
        const comments = [...annotateLapsedStandDowns(pr, { onLapse: () => {} }).comments]
          .sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
        const unresolved = standDownAnswers?.latestUnresolvedStandDown(comments);
        if (standDownAnswers && !unresolved) {
          if (standDownAnswers.latestOperatorAnswer(comments)) {
            (report.standDownAnswered ??= []).push({ repo, number: pr.number, title: pr.title,
              answeredAt: standDownAnswers.latestOperatorAnswerAt(comments) });
          }
        } else if (unresolved && standDownQueueSection === 'needs-you'
          && standDownTrailerReason(unresolved.body) === 'needs-judgment') {
          const reason = standDownReason(unresolved.body) ?? '';
          const clause = STAND_DOWN_REASONS['needs-judgment'];
          const question = reason === clause ? '' : reason.startsWith(`${clause}. `) ? reason.slice(clause.length + 2) : reason;
          const remaining = remainingStandDownFindings?.({ ...pr, comments }, { repo }) ?? [];
          (report.needsYouStandDowns ??= []).push({ repo, number: pr.number, title: pr.title,
            standDownAt: unresolved.createdAt, question, remaining });
        } else {
          report.stoodDown.push(unresolved ? { repo, number: pr.number, title: pr.title,
            standDownAt: unresolved.createdAt, reason: standDownReason(unresolved.body),
            alsoReviewHuman: hasLabel(pr, 'review:human') } : standDownRow(repo, pr));
        }
      }
      // STUCK — INSPECTED (epic #3383's stuck-PR watch): every open PR the watch has already dispatched a
      // diagnosis-only inspection agent for — this costs no extra `gh` call, since `comments` already rode the
      // ONE listing fetched above. Same "minus anything already in NEEDS YOU" narrowing as STOOD DOWN.
      for (const pr of prs) {
        if (readyNumbersThisRepo.has(pr.number)) continue;
        const row = stuckInspectedRow(repo, pr);
        if (row) report.stuck.push(row);
      }
    } catch (error) {
      failedRead(repo, error);
    }
  }
  if (readFailures) {
    process.exitCode = 1;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(readFailures ? { ...report, incomplete: true } : report, null, 2));
  } else {
    // Card 334 — rows a section printed ahead of its main rows (NEEDS YOUR MERGE) mean that section is not "(none)".
    let shownAhead = false;
    const printRows = (rows) => {
      if (rows) console.log(rows);
      if (readFailures) console.log('UNKNOWN — reads failed, re-run');
      else if (!rows && !shownAhead) console.log('(none)');
      shownAhead = false;
    };
    for (const error of report.errors) console.error(`ERROR ${error}`);
    // #4722 — a repo whose listing failed shows NONE of its PRs below, so the failure must be on the same page as
    // the sections, never only on stderr (where it read as "nothing is waiting").
    if (report.errors.length) {
      console.log('ERRORS — the sections below are INCOMPLETE (these reads failed):');
      console.log(report.errors.join('\n'));
    }
    if (health) console.log(health.join('\n'));
    console.log('NEEDS YOU (review:human + advisory:accepted, all gates pass; or a clear-human owed at the live head):');
    const mergeRows = (report.needsYourMerge ?? []).map((pr) => `${pr.repo}#${pr.number}  ${pr.title} — needs your merge: `
      + `approved, all gates green, touches ${pr.paths.join(', ')} (only a person may enqueue)\n    merge: ${pr.command}`);
    if (mergeRows.length) { console.log(mergeRows.join('\n')); shownAhead = true; }
    printRows(report.ready.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}`
      + (pr.ceremonyOwed ? ` — ${pr.reason}\n    clear-human: node scripts/review-set-label.mjs ${pr.number} --repo=${pr.repo} --to=clear-human --actor=<your login> --reason='<your words>'`
        : (pr.humanHolds ? ` — merge-gate holds only for human review: ${pr.humanHolds.join(', ')}` : ''))).concat((report.needsYouStandDowns ?? []).map((pr) => `${pr.repo}#${pr.number}  ${pr.title}  [stood down ${pr.standDownAt || 'time unknown'} — the fixer asks] ${pr.question}`
      + pr.remaining.map((f) => `\n    - still needs your ruling: ${f.file || '(no file)'}${f.line != null ? `:${f.line}` : ''}  ${f.summary}`).join(''))).concat(report.needsPerson.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}  [conveyor asks since ${pr.noteAt}] ${pr.headline}${pr.detail ? ` — ${pr.detail}` : ''}`
      + (pr.commands.releaseDraft ? `\n    release draft: ${pr.commands.releaseDraft}`
        : `\n    extend rounds: ${pr.commands.extendRounds}\n    send back past the cap: ${pr.commands.sendBack}\n    answer the stand-down: ${pr.commands.standDownAnswer}\n    close: ${pr.commands.close}`))).join('\n'));
    console.log('RULING NEEDED — review parked with confirmed findings; each needs your block/card/not-real ruling:');
    printRows(report.rulingNeeded.map((r) => `${r.repo}#${r.number}  ${r.title}  [waiting since ${r.since || 'time unknown'}, head ${r.head.slice(0, 9)}]\n`
      + r.findings.map((f) => `    - ${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''}  ${f.summary}${f.reason === 'dispute' ? '  [came back after your block ruling; the fixer and reviewer disagree]' : f.reason === 'red-team-round-cap' ? '  [red team confirmed break; round cap reached, not sent back]' : ''}`).join('\n')
      + (r.redTeam ? `\n    block (send back past the cap): ${r.commands.block}\n    not real (clear it):            ${r.commands.notReal}` : '')).join('\n'));
    console.log('PENDING — transient, re-run (GitHub is still computing mergeability; no agent work owed):');
    printRows(report.pending.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}`).join('\n'));
    console.log('UNSUPPORTED REPO — owed work the conveyor cannot dispatch for this repo:');
    printRows(report.unsupported.map((row) => `${row.repo}#${row.prNumber}  ${row.action}  ${row.why}`).join('\n'));
    console.log('NOT READY — agent work (review:human but gates fail):');
    printRows(report.notReady.map((pr) => `${pr.repo}#${pr.number}  ${pr.reasons.join('; ')}`).join('\n'));
    console.log('STOOD DOWN — needs your judgment (a fix agent asked a question; no label changed):');
    printRows(report.stoodDown.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}  `
      + `[stood down ${pr.standDownAt || 'time unknown'}] ${pr.reason || '(no reason recorded)'}`
      + (pr.alsoReviewHuman ? '  [also review:human]' : '')).join('\n'));
    if (report.standDownAnswered?.length) {
      console.log('answered — waiting for the fixer to resume');
      printRows(report.standDownAnswered.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}  [answered ${pr.answeredAt || 'time unknown'}]`).join('\n'));
    }
    console.log('STUCK — inspected (epic #3383 dispatched a diagnosis-only agent; read its comment):');
    printRows(report.stuck.map((pr) => `${pr.repo}#${pr.number}  ${pr.title}  `
      + `[${pr.episodes} episode${pr.episodes === 1 ? '' : 's'}, last ${pr.lastEpisode}]`).join('\n'));
    console.log('LANE RECLAIM — needs your decision (#3383, see `node scripts/lane-whois.mjs`):');
    // #4139 — ONE-CLICK actions, printed ready to paste: this file stays READ-ONLY (per its own header) and
    // never runs either of these itself. `reclaim` needs `--override` only when the lane's content is not
    // ALREADY provably preserved (`d.preserved` — some `unknown-work` rows are preserved; every
    // `finished-needs-review` row, by construction, is not). `keep` records the operator's own call so this
    // lane drops out of this list until its content changes (`we:scripts/lib/lane-whois-core.mjs#keepMarkerApplies`).
    printRows(report.laneDecisions.map((d) => (
      `lane-${d.lane}  [${d.verdict}]  ${d.reason}  ${d.path}\n`
      + `    reclaim: node scripts/lane-pool.mjs reclaim --lane=${d.lane}${d.preserved ? '' : ' --override'} --json\n`
      + '    keep:    node scripts/lane-pool.mjs keep --lane='
      + `${d.lane} --reason='<why>'`
    )).join('\n'));
    if (args.includes('--with-backpressure')) {
      console.log('BACKPRESSURE — open-PR limit reached (we:xniq7xs; land/review the existing PRs, or override `node scripts/operations/pr-limit.mjs allow|off`):');
      printRows(report.backpressure.map((b) => `${b.repo}  ${b.count}/${b.limit} open agent PR(s) not yet review:accepted  (#${b.prNumbers.join(', #')})`).join('\n'));
    }
    if (args.includes('--with-reconcile-notes')) {
      // #4191 (epic #4075/#3383) — ESCALATIONS: a PR whose auto-heal is exhausted, or whose bound session is
      // stuck on a permission prompt with nobody there to answer it. Printed as this file's own header's rule
      // demands: "an exhausted PR should read as 'needs your decision: fix attempts exhausted', with the last
      // failure reason" — never a bare count. `n.text` (`reconcile-core.mjs#planReconcile`'s own note) already
      // carries the last failure reason inline for `ci-heal-exhausted` — never re-appended here, or it reads
      // twice.
      console.log('ESCALATIONS — needs your decision (ci-heal exhausted / a session is blocked on a permission prompt):');
      printRows(report.reconcileNotes.map((n) => `${n.repo}#${n.prNumber ?? '?'}  [${n.kind}]  ${n.text}`).join('\n'));
    }
  }
}

/** True when this module is the CLI entry, even if argv[1] was typed via a symlink or a doubled slash (`$TMPDIR//x`). */
export function isCliEntry(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  let resolved = argv1;
  try { resolved = realpathSync(argv1); } catch { /* not on disk — compare the raw spelling */ }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isCliEntry()) main();
