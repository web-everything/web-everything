/**
 * @file scripts/operations/route-pr-outcome-io.mjs
 * @description THE IO SHELL of the `route-pr-outcome` declaration (#xrpo1, gap noted in session review) — the
 *   reader `./route-pr-outcome.mjs`'s `read` step is injected with.
 *
 * IT REUSES, IT DOES NOT RESTATE. The battle-tested disposition logic already lives in
 * `we:scripts/lib/review-core.mjs` (`deriveReviewDisposition`), the escalation-block parser already lives in
 * `we:scripts/review-detail.mjs` (`parseEscalationReason`, the same parser the Plateau Loop review console
 * relies on), and the review-label vocabulary already lives in `we:scripts/lib/review-escalation.mjs`
 * (`REVIEW_LABELS`, `hasReviewLabel`). This file calls all three; it decides none of what they decide.
 *
 * WHY THE CALL HAPPENS HERE AND NOT IN THE DECLARATION. `./route-pr-outcome.mjs` is registered as a READ-ONLY
 * operation (both its steps are `compute`, no effect) — the same class `pr-status`/`gate-health`/`suggest-next`/
 * `verify` are in — and `__tests__/http-adapter.test.mjs` pins that a read-only operation's DECLARING module
 * imports nothing that can act (`importGraph(...).external` must be `[]`). `review-core.mjs` and
 * `review-escalation.mjs` are NOT leaves: `review-escalation.mjs` imports `node:crypto` directly (for its own
 * unrelated hashing concerns) and `review-core.mjs` reaches `markdown-it` through `jury-core.mjs`, so importing
 * even ONE named export from either file drags that whole external graph into whatever imports it — ES module
 * static imports do not tree-shake for this scanner. Importing them into the pure declaration file would either
 * fail that pinned assertion or force `route-pr-outcome` off the read-only path with a manufactured effect step
 * it does not need. Calling the pure functions from THIS file instead — mirroring `./resolve-io.mjs`, which
 * calls the pure `reconcileScope` from inside `createResolveReader` for the identical reason — keeps the
 * declaration importing only `./registry.mjs` and `./step-kinds.mjs`, and hands it an ALREADY-DECIDED finding
 * to validate rather than raw materials to judge.
 *
 * `deriveRouteFinding` BELOW IS STILL PURE (no fs, no clock, no process, no network) despite living in the "-io"
 * file — same shape as `resolveBacklogFile`/`readScopeList`/`observedFilesForResolve` in `./resolve-io.mjs`:
 * colocated with the reader that needs it, unit-testable with plain objects, no subprocess required. Only
 * `createRouteOutcomeReader` below actually shells `gh`.
 *
 * IMPURE by construction (that one function): `child_process`.
 */
import { execFileSync } from 'node:child_process';

import { deriveReviewDisposition } from '../lib/review-core.mjs';
import { REVIEW_LABELS, hasReviewLabel } from '../lib/review-escalation.mjs';
import { parseEscalationReason } from '../review-detail.mjs';

/** How long a `gh` call may take before it is abandoned. A kill lands as a throw, never as an empty view. */
export const GH_TIMEOUT_MS = 60 * 1000;

// The closed set of `refusal` values this file may produce is declared ONCE, in `./route-pr-outcome.mjs`
// (`ROUTE_OUTCOME_REFUSALS`) — not restated here. `shapeRouteRead` there validates against it; this file only
// ever assigns the two string literals below, and importing the declaration's constant just to re-freeze a
// copy would be a second place for the set to drift from the one `shapeRouteRead` actually checks.

/**
 * The argv for the one `gh` call this operation needs. PURE, exported so a test can assert the exact command
 * with no subprocess — the discipline `pr-status-io.mjs`'s `listArgv` applies to its own spawn.
 *
 * Only the fields the routing question actually needs: `body` (the escalation-reason block lives there) and
 * `labels` (the review-class cross-check). No `comments`/`files` — those feed the Plateau Loop review CONSOLE
 * (`we:scripts/review-detail.mjs`'s `assembleReviewDetail`), a different, heavier question than "what should
 * happen to this PR", and fetching them here would be this thin operation paying for a read it does not use.
 */
export function viewArgv({ repo, pr }) {
  return ['pr', 'view', String(pr), '--repo', repo, '--json', 'number,title,url,body,labels'];
}

/** Normalize `gh`'s label objects (`{name}`) to bare names, tolerating either shape (same normalization
 * `pr-status-io.mjs`'s `labelNames` and `review-detail.mjs`'s private `labelNames` each carry independently —
 * trivial data shaping, not judgment, so a third small copy costs nothing and buys no shared home worth having
 * for three lines). */
export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : []).map((l) => String((l && l.name) ?? l ?? '')).filter(Boolean);
}

/** Shape `gh`'s raw JSON into the plain view `deriveRouteFinding` reads. PURE. */
export function shapeGhView(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    number: Number(v.number) || 0,
    title: String(v.title ?? ''),
    url: String(v.url ?? ''),
    body: typeof v.body === 'string' ? v.body : '',
    labels: labelNames(v.labels),
  };
}

/**
 * Derive the routing finding for ONE PR from its already-shaped `gh pr view` fields. PURE — no io, unit-testable
 * with plain objects. This is where `deriveReviewDisposition`/`parseEscalationReason`/`hasReviewLabel` are
 * actually called; `./route-pr-outcome.mjs`'s `read` step only validates the shape this returns.
 *
 * `disposition` IS `null` IN TWO DISTINCT CASES, and `refusal` says which — the same "could not check" vs.
 * "checked and clean" split `./resolve.mjs`'s `scopeUnchecked` draws, applied here to a disposition instead of
 * a scope reconciliation:
 *   - `no-escalation-reasons` — the PR carries no `## Escalation reason` block at all. This is the ORDINARY
 *     state for an unparked PR (`we:scripts/review-detail.mjs`'s own `assembleReviewDetail` reports the same
 *     case as a plain `disposition: null`), so `deriveReviewDisposition` is never even called with an empty
 *     array — calling it would throw `at least one reason is required` for what is, for most open PRs, the
 *     normal case, not a refusal.
 *   - `unrecognized-reasons` — the block exists but canonicalizes to nothing `deriveReviewDisposition` knows
 *     (a corrupted body, or a reason token `scoreEscalation` started emitting that this repo's disposition
 *     vocabulary has not caught up to). Collapsing this into the same `no-escalation-reasons` case would hide a
 *     real drift between the scorer and the disposition function behind the same "nothing to route" reading an
 *     ordinary unparked PR gets — exactly the kind of silent collapse `./resolve.mjs`'s own header warns against.
 *
 * @param {{repo:string, view:{number:number,title:string,url:string,body:string,labels:string[]}}} o
 */
export function deriveRouteFinding({ repo, view }) {
  const labels = Array.isArray(view.labels) ? view.labels : [];
  const humanRequired = hasReviewLabel(labels, REVIEW_LABELS.human);
  const reviewClass = humanRequired
    ? 'human'
    : hasReviewLabel(labels, REVIEW_LABELS.pending)
      ? 'pending'
      : 'none';

  const escalationReason = parseEscalationReason(view.body);

  let disposition = null;
  let refusal = null;
  if (!escalationReason.length) {
    refusal = 'no-escalation-reasons';
  } else {
    try {
      disposition = deriveReviewDisposition({ reasons: escalationReason });
    } catch {
      refusal = 'unrecognized-reasons';
    }
  }

  return {
    repo: String(repo || ''),
    pr: Number(view.number) || 0,
    title: String(view.title || ''),
    url: String(view.url || ''),
    labels,
    humanRequired,
    reviewClass,
    escalationReason,
    disposition,
    refusal,
  };
}

/**
 * Build the injected reader. `run` is injected so every branch is reachable with no `gh`, no network and no
 * credential — the same discipline `pr-status-io.mjs`'s `createPrReader` applies.
 *
 * A FAILED `gh` CALL THROWS, and it must. An empty/absent read here is read downstream as
 * `no-escalation-reasons` → "nothing to route" — the SAFE, do-nothing answer. A reader that swallowed a network
 * error into that same shape would manufacture the most dangerous possible misreading for a routing operation:
 * a PR this repo could not actually inspect presenting as one that is definitely not escalated.
 */
export function createRouteOutcomeReader({ run = execFileSync } = {}) {
  return ({ repo, pr }) => {
    const raw = String(run('gh', viewArgv({ repo, pr }), {
      encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    }) ?? '');
    const view = shapeGhView(JSON.parse(raw || '{}'));
    return deriveRouteFinding({ repo, view });
  };
}
