/**
 * @file scripts/operations/route-pr-outcome.mjs
 * @description THE `route-pr-outcome` DECLARATION — for one open PR, what should happen to it: land, converge,
 *   go to a human, or nothing (it is not currently escalated)?
 *
 * THE GAP THIS CLOSES. `deriveReviewDisposition` (`we:scripts/lib/review-core.mjs`) is the shared, heavily
 * fought-over derivation from an escalation-reason list to `{mode, autoLand}` — `we:scripts/lane-drain.mjs`,
 * `we:scripts/merge-ai-prs.mjs`, `we:scripts/pr-land.mjs`, `we:scripts/review-detail.mjs` and
 * `we:scripts/review-core-cli.mjs` all reach it directly today. None of `we:scripts/operations/*.mjs` imported
 * any of that logic before this file, so a caller going through the operations engine (the command line, or the
 * eventual headless conveyor runner) had no declared way to ask "what should happen to this PR" — it would have
 * had to reach around the engine into `review-core.mjs`/`review-escalation.mjs` directly, the exact
 * second-implementation shape the statute
 * [#operations-declared-once-callers-generated](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)
 * forbids.
 *
 * A THIN WRAPPER, DELIBERATELY. This file decides NOTHING about escalation or disposition — every bit of that
 * judgment stays in `deriveReviewDisposition`/`parseEscalationReason`/`hasReviewLabel`, called from
 * `./route-pr-outcome-io.mjs`'s `deriveRouteFinding` (see that file's header for why the CALL lives there and
 * not here — the short version: those homes are not import-graph leaves, and this declaration must stay one to
 * register on the read-only path). `read` below does exactly one thing: refuse a reader result this operation
 * cannot act on. `route` does exactly one more: turn an already-decided `{disposition, refusal}` pair into the
 * single flat `action` a caller can switch on without inspecting a nested shape.
 *
 * COMPUTE-ONLY, NO SINK, ON PURPOSE. Asking "what should happen" is a READ — the answer is FOR a caller to act
 * on, not something this operation applies itself. `we:scripts/review-set-label.mjs` already exists to apply a
 * review label; duplicating that machinery here to turn a routing answer into a write would be exactly the
 * second-implementation shape this file exists to avoid, aimed at a different mechanism. Both steps are
 * `compute`, so `./http-adapter.mjs` derives a `GET`-only, run-record-free surface — the same path `pr-status`,
 * `gate-health`, `suggest-next` and `verify` already take, pinned in `__tests__/http-adapter.test.mjs`.
 *
 * PURE. No fs, no clock, no process, no network in this file — `./route-pr-outcome-io.mjs` is the only place
 * this operation touches the world, and it is injected, so every branch below is reachable in a test with no
 * `gh` and no subprocess.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

/** The operation's stable id. Adapters resolve it by this name. */
export const ROUTE_PR_OUTCOME_OP = 'route-pr-outcome';

/** Why `disposition` came back `null`. A closed set, so a caller can branch without string-matching prose. */
export const ROUTE_OUTCOME_REFUSALS = Object.freeze(['no-escalation-reasons', 'unrecognized-reasons']);

/** The single flat verdict `planRouteOutcome` reduces `{disposition, refusal}` to. */
export const ROUTE_ACTIONS = Object.freeze(['land', 'converge', 'human', 'unrouted']);

/**
 * Shape + validate the injected reader's result into the `read` finding. PURE.
 *
 * REFUSES A SHAPE THIS OPERATION CANNOT ACT ON rather than filling in a permissive default — the same boundary
 * `resolve.mjs`'s `shapeResolveRead` and `pr-status.mjs`'s `shapeReadFinding` draw. This matters more here than
 * in most operations: the whole point of `route-pr-outcome` is telling a caller whether a PR may auto-land, so
 * a reader that returned something malformed and got read as "no escalation, safe to land" would be this
 * operation manufacturing the exact unsafe answer it exists to prevent.
 */
export function shapeRouteRead(raw, { repo, pr } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(
      `route-pr-outcome.read: the injected reader returned ${typeof raw}, not a route finding for `
      + `${JSON.stringify(String(repo ?? ''))}#${JSON.stringify(String(pr ?? ''))} — an unreadable PR must `
      + 'never present as one that is safe to route',
    );
  }
  const number = Number(raw.pr);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`route-pr-outcome.read: no usable PR number in the reader's result for ${JSON.stringify(String(repo ?? ''))}#${JSON.stringify(String(pr ?? ''))}`);
  }
  if (!Array.isArray(raw.labels)) {
    throw new Error('route-pr-outcome.read: the injected reader must return a `labels` array');
  }
  if (!Array.isArray(raw.escalationReason)) {
    throw new Error('route-pr-outcome.read: the injected reader must return an `escalationReason` array');
  }
  if (raw.refusal != null && !ROUTE_OUTCOME_REFUSALS.includes(raw.refusal)) {
    throw new Error(`route-pr-outcome.read: unknown refusal ${JSON.stringify(raw.refusal)} — not in ${ROUTE_OUTCOME_REFUSALS.join('|')}`);
  }
  if (raw.disposition != null) {
    const d = raw.disposition;
    if (typeof d !== 'object' || (d.mode !== 'human' && d.mode !== 'converge') || typeof d.autoLand !== 'boolean') {
      throw new Error('route-pr-outcome.read: `disposition`, when present, must be `{mode: "human"|"converge", autoLand: boolean}`');
    }
  }
  // Exactly one of `disposition`/`refusal` may be set — a reader that returned both, or neither, has not
  // actually decided anything, and proceeding to `route` would have to guess which one is authoritative.
  if ((raw.disposition != null) === (raw.refusal != null)) {
    throw new Error('route-pr-outcome.read: the reader must return exactly one of `disposition` or `refusal`, never both or neither');
  }
  return {
    repo: String(raw.repo || repo || ''),
    pr: number,
    title: String(raw.title || ''),
    url: String(raw.url || ''),
    labels: raw.labels.map(String),
    humanRequired: raw.humanRequired === true,
    reviewClass: String(raw.reviewClass || 'none'),
    escalationReason: raw.escalationReason.map(String),
    disposition: raw.disposition ? { mode: raw.disposition.mode, autoLand: raw.disposition.autoLand === true } : null,
    refusal: raw.refusal ?? null,
  };
}

/**
 * Reduce the `read` finding's `{disposition, refusal}` to the one flat `action` a caller switches on. PURE, and
 * calls NEITHER `deriveReviewDisposition` nor any other judgment function — the decision already happened in
 * the reader; this only names it.
 *
 * `unrouted` covers BOTH refusal reasons deliberately: whichever one fired, this operation has no `action` to
 * hand a caller (an ordinary unparked PR and a corrupted/unrecognized escalation block both mean "nothing this
 * operation can route"). The FULL distinction survives on `refusal` for a caller that needs it — `action` is the
 * collapsed field for the common case, `refusal` is the uncollapsed one for the operator/alerting case.
 */
export function planRouteOutcome(read) {
  const action = read.refusal
    ? 'unrouted'
    : read.disposition.mode === 'human'
      ? 'human'
      : read.disposition.autoLand
        ? 'land'
        : 'converge';
  return { ...read, action };
}

/**
 * Build the declaration. `readPrView` is injected — `./route-pr-outcome-io.mjs` supplies the real `gh` reader.
 */
export function routePrOutcomeOperation({ readPrView } = {}) {
  if (typeof readPrView !== 'function') {
    throw new TypeError(
      'route-pr-outcome: needs a `readPrView({repo,pr})` reader — the io is injected so the declaration stays '
      + 'testable without `gh`; the real binding is `we:scripts/operations/route-pr-outcome-io.mjs`.',
    );
  }

  return op(ROUTE_PR_OUTCOME_OP, {
    input: {
      repo: { type: 'string', required: true },
      pr: { type: 'number', required: true },
    },
    verdictFrom: 'route',

    read: compute({
      reads: ['input.repo', 'input.pr'],
      fn: (view) => shapeRouteRead(
        readPrView({ repo: view.input.repo, pr: view.input.pr }),
        { repo: view.input.repo, pr: view.input.pr },
      ),
    }),

    route: compute({
      reads: ['findings.read'],
      fn: (view) => planRouteOutcome(view.findings.read),
    }),
  });
}
