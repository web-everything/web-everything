/**
 * @file scripts/conveyor/unowned-rebase-attempt-count.mjs
 * @description THE DURABLE, RESTART-SURVIVING ATTEMPT COUNT for the UNOWNED population's mechanical rebase-drop
 *   attempt (#xu38vlf, epic #4075/#3383). Mirrors `we:scripts/conveyor/conflict-fix-round-count.mjs`'s own shape
 *   and reason for existing (a leaf, PR-comment-backed counter with its own marker and cap — never a shared one,
 *   for the same reason that file states: a different KIND of round needs its own floor).
 *
 * WHY THIS EXISTS. The flow checker (`we:scripts/conveyor/flows/check.mjs`) flagged
 * `we:scripts/conveyor/parked-pr-conflict-watch.mjs#defaultAttemptUnownedConflictRebase` (state
 * `unowned-mechanical-rebase-attempt`, `we:scripts/conveyor/flows/conflict.flow.json`) as `uncapped-retry`: every
 * ~120s sweep re-attempts the rebase-drop against `main` with NO per-PR counter of its own. The ordinary
 * `action:'skip'`/`'error'` fall-through USUALLY exits this population within the same sweep (it labels the PR
 * `review:changes` + `merge-status:conflicting`, which reclassifies it as PARKED next sweep, inheriting
 * `CONFLICT_FIX_ROUND_CAP` there) — but a THROW from the git-level attempt itself (a stale lock, a corrupted
 * ref, a protected-branch push denial) used to abort the WHOLE per-PR handler before that label ever applied,
 * leaving the PR unowned again next sweep with nothing durable recording that an attempt had even been made:
 * silently retried forever, with no cap and no operator-visible trace beyond a per-tick `entry.error` line
 * nobody centrally watches.
 *
 * Only content-conflict skips spend the cap. Infrastructure failures, throws, precondition skips,
 * deferred attempts and clean successes post no content marker. Infrastructure failures use a separate
 * head-scoped marker and retry cap. New markers include the outcome on their first
 * line; legacy markers remain readable through the stable prefix.
 *
 * PURE reader (this file, mirrors every sibling counter's split); the writer (posting the marker comment) lives
 * in the IO shell (`parked-pr-conflict-watch.mjs`), same split as every sibling counter in this directory.
 */
import { cascadePolicy, platformPreference } from '../lib/policy-cascade.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { roundExtensionGrants } from './round-extension-mark.mjs';
import { CARD_CONFLICT_PRECONDITION_REASONS } from '../lib/card-conflict-resolve.mjs';

/**
 * we:scripts/conveyor/unowned-rebase-attempt-count.mjs#UNOWNED_REBASE_ATTEMPT_MARKER — the stable first-line PREFIX of
 * the durable comment posted right after each unowned-population mechanical rebase-drop attempt that came back
 * with a content-conflict `'skip'`. Single-sourced HERE: `parked-pr-conflict-watch.mjs` posts it,
 * {@link countUnownedRebaseAttempts} matches it. Treat this prefix as fixed — changing it orphans the count on
 * every open unowned-conflict PR's existing history.
 */
export const UNOWNED_REBASE_ATTEMPT_MARKER = '🔁 conveyor — unowned mechanical rebase attempted (#xu38vlf)';

/**
 * we:scripts/conveyor/unowned-rebase-attempt-count.mjs#UNOWNED_REBASE_ATTEMPT_CAP — the attempt cap for the
 * unowned population's mechanical rebase-drop, before it stops retrying and falls through to the ordinary
 * bounce/stand-down with an operator-visible note. Mirrors `we:scripts/conveyor/reconcile-core.mjs
 * #CONFLICT_FIX_ROUND_CAP`'s own value (3) — the same "a mechanical, no-judgment round gets a small, fixed
 * floor" reasoning, not re-derived from it (this population's rounds are counted off a DIFFERENT marker, so
 * sharing the numeric value only, not the constant itself, keeps the two populations' caps independently
 * tunable without a cross-file edit).
 */
export const UNOWNED_REBASE_ATTEMPT_CAP = 3;

/** Independent stable prefix: infrastructure never spends a content round. */
export const UNOWNED_REBASE_INFRA_MARKER = '🔁 conveyor — unowned mechanical rebase infrastructure failure';
export const UNOWNED_REBASE_INFRA_RETRY_CAP_DEFAULT = 10;

/** Resolve the operator cutoff; null means count all historical attempts. */
export function loadUnownedRebaseSettings({ env = process.env, platform = platformPreference('unownedRebase', { env }),
  repo = readSettings()?.unownedRebase } = {}) {
  return cascadePolicy('unownedRebase', repo, { standard: { countSince: null, infraRetryCap: UNOWNED_REBASE_INFRA_RETRY_CAP_DEFAULT }, platform, env,
    envValues: { countSince: env.WE_UNOWNED_REBASE_COUNT_SINCE,
      infraRetryCap: env.WE_UNOWNED_REBASE_INFRA_RETRY_CAP === undefined ? undefined : Number(env.WE_UNOWNED_REBASE_INFRA_RETRY_CAP) },
    valid: { infraRetryCap: v => Number.isInteger(v) && v > 0, countSince: v => typeof v === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)
      && Number.isFinite(Date.parse(v)) } });
}

const cardResolverPrecondition = result => result?.action === 'skip' && result.precondition === true
  && CARD_CONFLICT_PRECONDITION_REASONS.includes(result.reason);

/** Generic skips still spend the content cap. Explicit card-resolver preconditions spend the infra
 *  budget instead, and therefore retain main's aggregate ceiling; they cannot retry without a bound. */
export function shouldCountRebaseAttempt(result) {
  return result?.action === 'skip' && !cardResolverPrecondition(result);
}

/** Stable prefix plus a single-line, bounded outcome for operator inspection. */
export function formatUnownedRebaseAttemptMarker(result) {
  const reason = String(result?.reason ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  return `${UNOWNED_REBASE_ATTEMPT_MARKER} outcome=${result.action}:${reason}`;
}

/**
 * we:scripts/conveyor/unowned-rebase-attempt-count.mjs#countUnownedRebaseAttempts — how many unowned-population
 * mechanical rebase-drop attempts have already run against this PR, read back off its OWN comment thread.
 * Pure — the caller passes the PR's `comments` exactly as `gh pr view <pr> --json comments` returns them
 * (`[{ body }]`); a bare-string array is tolerated too. A comment is counted only when the marker is its
 * LEADING line (`trimStart().startsWith`, the same narrowing every sibling counter in this repo uses) AND its
 * author passes {@link isTrustedMarkerAuthor} — a forged marker from an untrusted login must never inflate this
 * population's attempt cap (the same authz rule every other durable marker reader in this file's sibling
 * modules already applies).
 * A cutoff excludes only parseable createdAt values strictly before it; missing/invalid dates still count.
 * @param {Array<{body?:string,createdAt?:string}|string>|null|undefined} comments
 * @param {{countSince?:string|null}} [options]
 * @returns {number} the number of durable unowned-rebase-attempt comments on the PR (0 for a non-array / empty input)
 */
export function countUnownedRebaseAttempts(comments, { countSince } = {}) {
  if (!Array.isArray(comments)) return 0;
  const cutoff = Date.parse(countSince);
  let n = 0;
  for (const c of comments) {
    if (Date.parse(c?.createdAt) < cutoff) continue;
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body === 'string' && body.trimStart().startsWith(UNOWNED_REBASE_ATTEMPT_MARKER) && isTrustedMarkerAuthor(c)) n += 1;
  }
  return n;
}

/** An error result or caught exception spends only the infrastructure budget. */
export function shouldCountRebaseInfra(result) {
  return result instanceof Error || result?.thrown === true || result?.action === 'error' || cardResolverPrecondition(result);
}

/** Put head before the free-text reason so reason tokens cannot impersonate a head. */
export function formatUnownedRebaseInfraMarker(result, headSha) {
  const reason = String(result?.reason ?? result?.message ?? result ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ').trim().slice(0, 120);
  const head = headSha ? ` head=${String(headSha).replace(/\s/g, '')}` : '';
  return `${UNOWNED_REBASE_INFRA_MARKER}${head} outcome=infra:${reason}`;
}

/** Trusted leading markers only; legacy headless markers match every head. Same cutoff as content. */
export function countUnownedRebaseInfraFailures(comments, { countSince, headSha } = {}) {
  if (!Array.isArray(comments)) return 0;
  const cutoff = Date.parse(countSince);
  return comments.filter(c => {
    if (Date.parse(c?.createdAt) < cutoff || !isTrustedMarkerAuthor(c)) return false;
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string') return false;
    const line = body.trimStart().split(/[\r\n\u2028\u2029]/, 1)[0];
    if (!line.startsWith(UNOWNED_REBASE_INFRA_MARKER)) return false;
    const metadata = line.slice(UNOWNED_REBASE_INFRA_MARKER.length).split(' outcome=')[0];
    const markerHead = metadata.match(/(?:^|\s)head=(\S+)/)?.[1];
    return !headSha || !markerHead || markerHead === headSha;
  }).length;
}

/**
 * The aggregate ceiling main has always enforced: content skips AND infrastructure failures (errors, throws) share
 * ONE {@link UNOWNED_REBASE_ATTEMPT_CAP}, counted over the PR's whole history (no `countSince` cutoff, every head).
 * The separate infra budget above may only surface earlier, never let more attempts run than this.
 * @param {Array<{body?:string,createdAt?:string}|string>|null|undefined} comments
 * @returns {number}
 */
export function countUnownedRebaseAggregateAttempts(comments) {
  return countUnownedRebaseAttempts(comments) + countUnownedRebaseInfraFailures(comments);
}

/**
 * we:scripts/conveyor/unowned-rebase-attempt-count.mjs#grantedRebaseCap — the cap after operator round grants.
 * PR #5716 stayed at "unowned-mechanical-rebase-infra auto-repair rounds exhausted (10/10)" after the operator
 * granted +1 with `extend-rounds`: these two caps never read the grant. Each audited grant (operator-authored, or
 * an automation-posted standing-ruling grant inside the scope the IO shell verified — the SAME reader and
 * ten-round ceiling `reconcile-core.mjs` uses) means "N more attempts from the moment it was posted":
 * cap' = max(cap, attemptsBeforeGrant + by). Bounded: no grant → the base cap, and every grant is a visible,
 * authenticated PR comment. `count` is the cap's own counter, run over the thread prefix before the grant.
 * @param {number} cap
 * @param {Array<object>} comments - chronological, as the conflict watch lists them
 * @param {(prefix:Array<object>) => number} count
 * @param {{repo:string, pr:number, standingRuling?:object|null}} scope
 * @returns {{cap:number, grants:number}}
 */
export function grantedRebaseCap(cap, comments, count, { repo, pr, standingRuling = null }) {
  if (!Array.isArray(comments)) return { cap, grants: 0 };
  const grants = roundExtensionGrants(comments, { repo, pr, standingRuling });
  return { cap: Math.max(cap, ...grants.map(g => count(comments.slice(0, g.index)) + g.by)),
    grants: grants.reduce((sum, g) => sum + g.by, 0) };
}
