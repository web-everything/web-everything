/**
 * @file scripts/conveyor/queue-cap-refusal-count.mjs
 * @description THE DURABLE, RESTART-SURVIVING QUEUE-CAP REFUSAL COUNT for a fix-dispatch PR (#4229, bornAs
 *   xo2emdz, epic #4075/#3383). Mirrors `we:scripts/conveyor/unowned-rebase-attempt-count.mjs`'s own shape and
 *   reason for existing: a leaf, PR-comment-backed capacity counter with a marker spam cap, for a population neither
 *   `we:scripts/conveyor/ci-heal-mark.mjs` nor `we:scripts/conveyor/conflict-fix-round-count.mjs` can see.
 *
 * WHY THIS EXISTS. The flow checker (`node scripts/conveyor/flows/check.mjs`) flags
 * `we:scripts/conveyor/reconcile-fix-dispatch.mjs`'s own queue admission check (state `queue-cap-hit`,
 * `we:scripts/conveyor/flows/fix.flow.json`) as `uncapped-retry`: `createQueueBudget#tryAdmit` refuses a fix
 * dispatch `'queue-cap'` whenever the projected heavy-test queue wait would exceed budget, with no durable count
 * and no escalation — a persistently saturated heavy queue can refuse the SAME PR indefinitely with nothing
 * surfaced to a human beyond a per-pass, in-memory refusal line nobody centrally watches.
 *
 * NEVER STOPS RETRYING — ONLY STOPS BEING SILENT. Unlike the unowned-rebase-drop cap (a genuinely broken
 * mechanical action, correctly abandoned once its cap is spent) queue congestion is expected to clear on its
 * own; refusing forever IS the correct behavior while the queue stays saturated. So
 * `we:scripts/conveyor/reconcile-fix-dispatch.mjs` keeps calling `tryAdmit` every pass past the cap exactly as
 * before — this counter only gates (a) whether another durable capacity-deferral comment gets posted (capped at
 * {@link QUEUE_CAP_REFUSAL_CAP}, so a saturated queue's own refusal history can never spam the PR thread once a
 * few markers exist) and (b) whether a per-head host capacity starvation alert still needs posting after the
 * elapsed-time threshold. A refusal uses no repair attempt; the fix has not run or failed.
 * Capped untimed histories get one separate per-head baseline to start the clock without adding refusals.
 *
 * PURE reader (this file, mirrors every sibling counter's split); the writer (posting the marker comment) lives
 * in the IO shell (`reconcile-fix-dispatch.mjs`), same split as every sibling counter in this directory.
 */
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

/**
 * we:scripts/conveyor/queue-cap-refusal-count.mjs#QUEUE_CAP_REFUSAL_MARKER — the stable FIRST LINE of the
 * durable comment posted for each of the first {@link QUEUE_CAP_REFUSAL_CAP} `queue-cap` refusals a PR's fix
 * dispatch sees. Single-sourced HERE: `we:scripts/conveyor/reconcile-fix-dispatch.mjs` posts it,
 * {@link countQueueCapRefusals} matches it. Treat this line as fixed — changing it orphans the count on every
 * open PR's existing history.
 */
export const QUEUE_CAP_REFUSAL_MARKER = '⏳ conveyor — fix dispatch refused, queue-cap (#4229)';

/**
 * we:scripts/conveyor/queue-cap-refusal-count.mjs#QUEUE_CAP_REFUSAL_CAP — the queue-cap refusal cap, before this
 * PR's fix dispatch stops posting a fresh durable marker comment for every further refusal. Independent of
 * the elapsed-time starvation alert. Mirrors `we:scripts/conveyor/reconcile-core.mjs#CI_HEAL_ROUND_CAP` /
 * `we:scripts/conveyor/unowned-rebase-attempt-count.mjs#UNOWNED_REBASE_ATTEMPT_CAP`'s own value (3) — the same
 * small, fixed comment bound, not re-derived from either (this population is
 * counted off its own marker, so sharing the numeric value only keeps the two independently tunable).
 */
export const QUEUE_CAP_REFUSAL_CAP = 3;

const CAPACITY_BASELINE_MARKER = '⏳ conveyor — host capacity clock started (queue-cap-baseline)';

/** One migration record for a known head whose legacy refusal markers have no timestamp. */
export function buildCapacityBaselineComment(headSha, now) {
  if (!headSha || !capacityIso(now)) throw new Error('capacity baseline requires a head and timestamp');
  return buildQueueCapRefusalComment('Host capacity deferral clock starts now for this head; no repair attempt was used.', headSha, now)
    .replace(QUEUE_CAP_REFUSAL_MARKER, CAPACITY_BASELINE_MARKER);
}

/**
 * we:scripts/conveyor/queue-cap-refusal-count.mjs#queueCapHeadLine — the machine-read line recording WHICH PR head
 * a refusal marker was posted against. One capacity EPISODE = one head (PR #2760 review): a new head pushed after
 * an episode was surfaced starts a fresh count, so a second saturation is surfaced again instead of being
 * deduplicated against the first episode's alert. Pure.
 * @param {string} headSha
 * @returns {string}
 */
export function queueCapHeadLine(headSha) {
  return `<!-- queue-cap-head: ${headSha} -->`;
}

/**
 * we:scripts/conveyor/queue-cap-refusal-count.mjs#buildQueueCapRefusalComment — the durable per-refusal comment
 * body: {@link QUEUE_CAP_REFUSAL_MARKER} as the FIRST line (so {@link countQueueCapRefusals} matches it), the
 * {@link queueCapHeadLine} when the head is known, the human-readable reason below. Pure.
 * @param {string} [why] - `we:scripts/conveyor/reconcile-fix-dispatch.mjs#queueCapWhy`'s own text.
 * @param {string|null} [headSha] - the PR's `headRefOid` at refusal time.
 * @param {string|Date|number} [now] - optional timestamp of this deferral.
 * @returns {string}
 */
export function buildQueueCapRefusalComment(why, headSha = null, now) {
  const head = headSha ? `\n${queueCapHeadLine(headSha)}` : '';
  const at = capacityIso(now);
  const deferred = at ? `\n<!-- queue-cap-deferred-at: ${at} -->` : '';
  return `${QUEUE_CAP_REFUSAL_MARKER}${head}${deferred}\n\n${why || 'fix dispatch refused this pass (queue-cap)'}`;
}

// Invalid or absent times provide no evidence of elapsed starvation.
function capacityIso(value) {
  if (!(typeof value === 'string' || typeof value === 'number' || value instanceof Date)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Shared trusted-author, leading-marker and head rules for capacity history and alerts. */
function capacityBodies(comments, marker, headSha) {
  return (Array.isArray(comments) ? comments : []).filter(c => {
    const body = typeof c === 'string' ? c : c?.body;
    return typeof body === 'string' && body.trimStart().startsWith(marker) && isTrustedMarkerAuthor(c)
      && (!headSha || body.includes(queueCapHeadLine(headSha)));
  }).map(c => typeof c === 'string' ? c : c.body);
}

/** Pure capacity evidence; legacy markers count but supply no elapsed-time evidence. */
export function summarizeCapacityDeferral(comments, { headSha = null } = {}) {
  const bodies = capacityBodies(comments, QUEUE_CAP_REFUSAL_MARKER, headSha);
  const timedBodies = [...bodies, ...capacityBodies(comments, CAPACITY_BASELINE_MARKER, headSha)];
  const times = timedBodies.flatMap(body => [...body.matchAll(/^<!-- queue-cap-deferred-at: (.+) -->\r?$/gm)]
    .map(match => capacityIso(match[1])).filter(Boolean)).sort();
  return { deferredForCapacity: bodies.length, firstAt: times[0] ?? null, lastAt: times.at(-1) ?? null };
}

export const FIX_STARVED_CAPACITY_MARKER = '⏳ conveyor — fix starved on host capacity (fix-starved-capacity)';

/** Operator-visible host capacity fallback, independent of the repair budget. */
export function buildFixStarvedCapacityComment({ headSha, hours, deferredForCapacity, firstAt }) {
  const head = headSha ? `\n${queueCapHeadLine(headSha)}` : '';
  return `${FIX_STARVED_CAPACITY_MARKER}${head}\n\nHost capacity starvation: the fix has not failed; no attempt was used. `
    + `The heavy-test queue has refused it for ${hours} hours (since ${firstAt}; ${deferredForCapacity} recorded capacity deferrals). `
    + 'Please look at host capacity. Dispatch keeps retrying automatically.';
}

/** One trusted starvation alert per capacity episode/head. */
export function hasFixStarvedCapacityAlert(comments, { headSha = null } = {}) {
  return capacityBodies(comments, FIX_STARVED_CAPACITY_MARKER, headSha).length > 0;
}

/**
 * we:scripts/conveyor/queue-cap-refusal-count.mjs#countQueueCapRefusals — how many `queue-cap` refusals have
 * already been durably recorded against this PR, read back off its OWN comment thread. Pure — the caller passes
 * the PR's `comments` exactly as `gh pr view <pr> --json comments` returns them (`[{ body }]`); a bare-string
 * array is tolerated too. A comment is counted only when the marker is its LEADING line
 * (`trimStart().startsWith`, the same narrowing every sibling counter in this repo uses) AND its author passes
 * {@link isTrustedMarkerAuthor} — a forged marker from an untrusted login must never inflate this population's
 * cap.
 *
 * With `headSha`, only markers carrying that head's {@link queueCapHeadLine} are counted (the current episode);
 * without it, every marker on the PR is counted.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @param {{headSha?:(string|null)}} [o]
 * @returns {number} the number of durable queue-cap-refusal comments on the PR (0 for a non-array / empty input)
 */
export function countQueueCapRefusals(comments, { headSha = null } = {}) {
  return capacityBodies(comments, QUEUE_CAP_REFUSAL_MARKER, headSha).length;
}
