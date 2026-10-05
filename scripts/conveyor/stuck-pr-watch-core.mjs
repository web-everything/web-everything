/**
 * @file scripts/conveyor/stuck-pr-watch-core.mjs
 * @description THE STUCK-PR WATCH's PURE CORE (epic #3383). Operator (2026-09-23): "we also should have a
 *   health watch that launch and inspection if pr are stuck." This is the "decide `stuck`" half; the IO shell
 *   ({@link ./stuck-pr-watch.mjs}) is the thin `gh`/dispatch half — mirrors the split
 *   `we:scripts/conveyor/parked-pr-conflict-watch.mjs` and `we:scripts/conveyor/parked-pr-progress-watch.mjs`
 *   already use.
 *
 * STUCK = no progress for longer than the EXPECTED time for the PR's own stage, and nothing live is already
 * working it. "Progress" is a new commit, label event, or comment ({@link latestActivityAt}, read off the PR's
 * own GitHub issue-events/timeline — `we:scripts/conveyor/stuck-pr-watch.mjs`'s IO shell fetches it), OR a live
 * bound agent session ({@link ../reconcile-core.mjs#assessLiveness} / `#bindAgents`, REUSED — not re-derived,
 * per this item's own instructions — this file never re-implements the liveness binding
 * `we:scripts/conveyor/reconcile-pass.mjs` already established).
 *
 * FOUR TRACKED STAGES, each its own threshold (a tuning knob — a constant with an env override, never
 * hardcoded — {@link stuckThresholdMinutes}):
 *   - `review`   — `review:pending` or the informative `review-status:reviewing` label — a reviewer is owed.
 *   - `fix`      — `review:changes` — a repair is owed.
 *   - `approved` — `review:accepted` or `ready-to-merge`, AND GitHub reports `mergeable: MERGEABLE` — a merge
 *                  is owed.
 *   - `conflict` — GitHub reports `mergeable: CONFLICTING` — a rebase/resolve is owed. Checked FIRST, ahead of
 *                  every label-based stage: a conflicting PR is never going to merge regardless of what review
 *                  label it also carries (WE #2505's own shape: `review:accepted` *and* conflicting).
 *
 * NEVER STUCK, whatever its labels or activity age: `review:human` (a human-only gate — the watch never
 * second-guesses a PR already parked for a person), a draft (`isDraft` — not yet offered for review), or a PR
 * carrying the durable stand-down marker (`we:scripts/conveyor/stand-down.mjs#STAND_DOWN_MARKER` — a fixer
 * already stopped to ask a human; re-flagging it as "stuck" would just re-ask the same question a second way),
 * or a live load-flake hold awaiting a quiet host. Moved heads and resolved/superseded holds do not exclude it.
 *
 * IDEMPOTENCY, NO SEPARATE STORE (#2612). Exactly one inspection agent is launched per PR per STUCK EPISODE —
 * an episode is keyed by the PR's own last-activity timestamp at detection time
 * ({@link buildStuckDispatchComment} embeds it; {@link alreadyDispatchedForEpisode} reads it back off the PR's
 * own comment thread). If the PR gets fresh activity and then stalls again LATER, that is a NEW episode (a new
 * `activityAt`) and a fresh inspection is owed — this never permanently silences a PR the way a one-shot label
 * would.
 *
 * CONCURRENCY CAP ({@link planStuckDispatches}) — at most `maxConcurrent` (default 2) inspection agents run at
 * once, across every repo combined (the IO shell counts live `inspect-*` sessions the same way
 * `we:scripts/conveyor/reconcile-core.mjs#bindAgents` counts live `review-*`/`fix-*` ones). When capacity is
 * scarce the PR that has waited LONGEST past its own threshold is served first.
 *
 * PURE: no fs / gh / clock / process — every input (the PR record, the agents listing, `now`, the thresholds,
 * the already-fetched activity timestamp) is passed in.
 */
import { REVIEW_LABELS, hasReviewLabel, READY_TO_MERGE_LABEL } from '../lib/review-escalation.mjs';
import { countStandDownComments } from './stand-down.mjs';
import { isLegacyLoadFlakeHoldSuperseded } from './load-flake-hold.mjs';
import { assessLiveness, bindAgents } from './reconcile-core.mjs';
// The dispatch-marker builder/reader lives in its OWN lightweight file — see that file's own header for why:
// `we:scripts/operations/operator-queue.mjs` needs it too, and must NOT pull in this file's much heavier
// `reconcile-core.mjs` import (a real module-load crash, confirmed live, under that file's own mocked
// `node:child_process`). Re-exported here so every existing importer of THIS file is unaffected.
export {
  STUCK_DISPATCH_MARKER, buildStuckDispatchComment, stuckDispatchEpisodes, alreadyDispatchedForEpisode,
  STUCK_INSPECTION_COMMENT_PREFIX, isStuckInspectionOwnComment,
  STUCK_DISPATCH_RETRACTED_MARKER, buildStuckDispatchRetractionComment, stuckDispatchRetractions,
  MAX_RETRACTIONS_PER_EPISODE,
} from './stuck-pr-dispatch-marker.mjs';
import { isStuckInspectionOwnComment } from './stuck-pr-dispatch-marker.mjs';

/** The informative "actively being reviewed" label `we:scripts/conveyor/review-status-tag.mjs` applies
 *  alongside `review:pending` — checked in addition to `review:pending` itself so a PR that (by some label-
 *  timing edge case) carries only this one is still recognized as being IN the `review` stage. */
export const REVIEWING_STATUS_LABEL = 'review-status:reviewing';

/** The four tracked stages (see file header). Frozen so a caller cannot accidentally add a fifth without also
 *  registering its threshold below. */
export const STUCK_STAGES = Object.freeze({
  REVIEW: 'review',
  FIX: 'fix',
  APPROVED: 'approved',
  CONFLICT: 'conflict',
});

/** The bold-default thresholds (tuning knobs, per the operator's own agreed defaults) — minutes of NO progress
 *  before a PR in this stage counts as stuck. */
export const DEFAULT_STUCK_THRESHOLD_MINUTES = Object.freeze({
  [STUCK_STAGES.REVIEW]: 45,
  [STUCK_STAGES.FIX]: 45,
  [STUCK_STAGES.APPROVED]: 30,
  [STUCK_STAGES.CONFLICT]: 45,
});

/** The env var that overrides each stage's threshold — never hardcode a knob with no override, per this
 *  item's own instructions. */
export const STUCK_THRESHOLD_ENV = Object.freeze({
  [STUCK_STAGES.REVIEW]: 'WE_STUCK_PR_REVIEW_THRESHOLD_MINUTES',
  [STUCK_STAGES.FIX]: 'WE_STUCK_PR_FIX_THRESHOLD_MINUTES',
  [STUCK_STAGES.APPROVED]: 'WE_STUCK_PR_APPROVED_THRESHOLD_MINUTES',
  [STUCK_STAGES.CONFLICT]: 'WE_STUCK_PR_CONFLICT_THRESHOLD_MINUTES',
});

/**
 * Read every stage's threshold from `env`, falling back to {@link DEFAULT_STUCK_THRESHOLD_MINUTES} per-stage.
 * Throws on a non-positive/non-finite override — a bad knob should fail loud, not silently disable a stage.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Record<string, number>}
 */
export function stuckThresholdMinutes(env = process.env) {
  const out = {};
  for (const stage of Object.values(STUCK_STAGES)) {
    const raw = String(env?.[STUCK_THRESHOLD_ENV[stage]] ?? '').trim();
    if (!raw) { out[stage] = DEFAULT_STUCK_THRESHOLD_MINUTES[stage]; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new TypeError(`${STUCK_THRESHOLD_ENV[stage]} must be a positive number of minutes, got ${JSON.stringify(raw)}`);
    }
    out[stage] = n;
  }
  return out;
}

/** Is this PR a draft (not yet offered for review)? */
export function isDraftPr(pr) {
  return pr?.isDraft === true;
}

/**
 * NEVER STUCK, whatever its activity age (see file header for the three exclusions). Pure.
 * @param {{labels?:Array, isDraft?:boolean, comments?:Array}} pr
 * @returns {boolean}
 */
export function isNeverStuckPr(pr) {
  if (hasReviewLabel(pr?.labels, REVIEW_LABELS.human)) return true;
  if (isDraftPr(pr)) return true;
  if (countStandDownComments(pr?.comments, { headRefOid: pr?.headRefOid, isSuperseded: isLegacyLoadFlakeHoldSuperseded }) > 0) return true;
  return false;
}

/**
 * Which of the four tracked stages (if any) this PR is in RIGHT NOW. Pure. `conflict` is checked first — see
 * the file header for why a conflicting PR is tracked as `conflict` even when it also carries `review:accepted`
 * (WE #2505's own shape). Returns `null` for a PR in no tracked stage (e.g. no review label yet, or
 * `mergeable: UNKNOWN` on an otherwise-approved PR — GitHub is still computing, never guessed at).
 * @param {{labels?:Array, mergeable?:string}} pr
 * @returns {'review'|'fix'|'approved'|'conflict'|null}
 */
export function classifyStuckStage(pr) {
  const mergeable = String(pr?.mergeable || '').toUpperCase();
  if (mergeable === 'CONFLICTING') return STUCK_STAGES.CONFLICT;
  if (hasReviewLabel(pr?.labels, REVIEW_LABELS.changes)) return STUCK_STAGES.FIX;
  if (hasReviewLabel(pr?.labels, REVIEW_LABELS.pending) || hasReviewLabel(pr?.labels, REVIEWING_STATUS_LABEL)) {
    return STUCK_STAGES.REVIEW;
  }
  const approvedLabel = hasReviewLabel(pr?.labels, REVIEW_LABELS.accepted) || hasReviewLabel(pr?.labels, READY_TO_MERGE_LABEL);
  if (approvedLabel && mergeable === 'MERGEABLE') return STUCK_STAGES.APPROVED;
  return null;
}

/** The three GitHub timeline event types that count as "progress" — a new commit, a label event, or a comment
 *  (the task's own literal wording). Every other timeline event (a review, an assignment, a reference, …) is
 *  deliberately NOT progress for this watch — narrower than "anything happened", per the ratified scope. */
export const PROGRESS_TIMELINE_EVENTS = Object.freeze(['labeled', 'commented', 'committed']);

/**
 * The most recent progress timestamp across a PR's own GitHub issue-events/timeline, or `null` when none of
 * the tracked event types are present (never guessed — the caller must fail closed on `null`, exactly like
 * `we:scripts/conveyor/parked-pr-progress-watch.mjs#labeledAtFor` does for its own single-label read). Pure —
 * `events` is already the flattened `{createdAt, event, body?}` list the IO shell's timeline reader produced.
 * A `commented` event that is this feature's OWN write (its dispatch marker or the inspection agent's diagnosis,
 * {@link isStuckInspectionOwnComment}) is NOT progress — counting it reset the clock on every dispatch and made
 * each threshold a "new episode" forever (PR #2553 review).
 * @param {Array<{createdAt?:string, event?:string, body?:string}>} events
 * @returns {string|null}
 */
export function latestActivityAt(events) {
  const list = Array.isArray(events) ? events : [];
  let best = null;
  let bestMs = -Infinity;
  for (const e of list) {
    if (!e || !PROGRESS_TIMELINE_EVENTS.includes(e.event)) continue;
    if (e.event === 'commented' && isStuckInspectionOwnComment(e.body)) continue;
    const ms = Date.parse(e.createdAt);
    // `>=` (not `>`), matching `parked-pr-progress-watch.mjs#labeledAtFor`'s own tie-break: pick the LATEST by
    // parsed value, never trust array order alone as the sole tie-break signal.
    if (Number.isFinite(ms) && ms >= bestMs) { bestMs = ms; best = e.createdAt; }
  }
  return best;
}

/**
 * Minutes elapsed between `activityAt` and `now`. Returns `null` (never negative/NaN) when `activityAt` cannot
 * be parsed — the caller fails closed (never stuck) on that, since the whole point is a real elapsed duration.
 * @param {string|number|Date|null|undefined} activityAt
 * @param {number|Date} [now]
 * @returns {number|null}
 */
export function minutesSinceActivity(activityAt, now = Date.now()) {
  if (activityAt === null || activityAt === undefined) return null;
  const t = activityAt instanceof Date ? activityAt.getTime() : new Date(activityAt).getTime();
  if (!Number.isFinite(t)) return null;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const mins = (nowMs - t) / 60_000;
  return mins < 0 ? null : mins;
}

/**
 * THE WHOLE DECISION for one PR. Pure. Every branch returns a `reason` so a caller (and a reader) can always
 * audit WHY a PR was not flagged — the same "a refusal a reader cannot audit is the defect" discipline
 * `we:scripts/conveyor/reconcile-core.mjs` already established for its own four refusals.
 * @param {object} o
 * @param {object} o.pr - `{labels, mergeable, isDraft, comments, headRefOid, number}`.
 * @param {Array<object>} [o.agents] - the enriched `claude agents --json` listing (see
 *   `we:scripts/conveyor/reconcile-pass.mjs#enrichAgents`) — REUSED for {@link ../reconcile-core.mjs#assessLiveness}.
 * @param {string} [o.repo] - the internal repo key (`we`/`frontierui`/`plateau-app`), for `bindAgents`'s own
 *   name-based bind.
 * @param {number} [o.now] - epoch ms.
 * @param {Record<string,number>} [o.thresholds] - per-stage minutes, defaults to {@link DEFAULT_STUCK_THRESHOLD_MINUTES}.
 * @param {string|null} [o.activityAt] - {@link latestActivityAt}'s own return for this PR — already fetched by
 *   the IO shell (a per-PR timeline fetch is too costly to run from inside a pure function).
 * @returns {{stuck:boolean, reason:string, stage?:string|null, minutesSince?:number|null, thresholdMinutes?:number, activityAt?:string|null, live?:object}}
 */
export function evaluateStuckPr({
  pr, agents = [], repo = 'we', now = Date.now(), thresholds = DEFAULT_STUCK_THRESHOLD_MINUTES, activityAt = null,
} = {}) {
  if (isNeverStuckPr(pr)) return { stuck: false, reason: 'excluded' };
  const stage = classifyStuckStage(pr);
  if (!stage) return { stuck: false, reason: 'no-tracked-stage', stage: null };
  const minutesSince = minutesSinceActivity(activityAt, now);
  if (minutesSince === null) return { stuck: false, reason: 'no-activity-evidence', stage, activityAt: null };
  const thresholdMinutes = thresholds[stage] ?? DEFAULT_STUCK_THRESHOLD_MINUTES[stage];
  if (minutesSince < thresholdMinutes) {
    return { stuck: false, reason: 'within-threshold', stage, minutesSince, thresholdMinutes, activityAt };
  }
  const live = assessLiveness(bindAgents(pr, agents, repo));
  if (live) return { stuck: false, reason: 'live-agent', stage, minutesSince, thresholdMinutes, activityAt, live };
  return { stuck: true, reason: 'stuck', stage, minutesSince, thresholdMinutes, activityAt };
}

// ── CONCURRENCY CAP ──────────────────────────────────────────────────────────────────────────────────────────

/** How many inspection agents may run at once, across every repo combined — a tuning knob with an env
 *  override, per this item's own instructions. */
export const DEFAULT_MAX_CONCURRENT_INSPECTIONS = 2;
export const MAX_CONCURRENT_INSPECTIONS_ENV = 'WE_STUCK_PR_MAX_CONCURRENT_INSPECTIONS';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function maxConcurrentInspections(env = process.env) {
  const raw = String(env?.[MAX_CONCURRENT_INSPECTIONS_ENV] ?? '').trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_INSPECTIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(`${MAX_CONCURRENT_INSPECTIONS_ENV} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Given every stuck PR not yet dispatched for its current episode ({@link alreadyDispatchedForEpisode} already
 * applied by the caller), decide which to dispatch NOW under the concurrency cap. Pure. The PR that has waited
 * LONGEST past its own threshold is served first when capacity is scarce (`minutesSince - thresholdMinutes`,
 * descending) — a fair, deterministic tie-break, never dispatch order or repo order.
 * @param {Array<{minutesSince:number, thresholdMinutes:number}>} [candidates]
 * @param {number} [liveInspectCount] - how many `inspect-*` sessions are ALREADY live right now.
 * @param {number} [maxConcurrent]
 * @returns {{toDispatch:Array<object>, deferred:Array<object>}}
 */
export function planStuckDispatches({ candidates = [], liveInspectCount = 0, maxConcurrent = DEFAULT_MAX_CONCURRENT_INSPECTIONS } = {}) {
  const capacity = Math.max(0, maxConcurrent - Math.max(0, liveInspectCount));
  const ordered = [...(Array.isArray(candidates) ? candidates : [])]
    .sort((a, b) => (b.minutesSince - b.thresholdMinutes) - (a.minutesSince - a.thresholdMinutes));
  return {
    toDispatch: ordered.slice(0, capacity),
    deferred: ordered.slice(capacity).map((c) => ({ ...c, deferredReason: 'concurrency-cap' })),
  };
}
