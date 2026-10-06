/**
 * @file scripts/lib/advisory-labels.mjs
 * @description THE `advisory:*` LABEL PAIR — the machine-maintained, at-a-glance answer to "did the independent
 *   AI advisory clear this `review:human` PR, on its CURRENT head?" PURE and a true leaf (no imports), so the
 *   `advise` step, its sink, the staleness sweep and `operator-queue.mjs` all read ONE definition.
 *
 * WHY THESE LABELS EXIST. On a PR carrying `review:human` the independent review deliberately records no verdict
 * (`we:scripts/operations/review-pr.mjs`'s `advise` step posts a comment headed "NOT A RECORDED VERDICT" and never
 * calls `decideSetLabel`), so a human-gated PR whose advisory came back clean looked, by label, exactly like one
 * never reviewed — both sat at `review:human` + `review:pending`. The operator's rule (2026-09-19): "I won't look
 * at a human PR until it carries [`advisory:accepted`] and has no request-changes or review-pending."
 *
 * THE LABEL IS A DERIVED VIEW, NEVER THE SOURCE OF TRUTH. The truth is the advisory COMMENT: its
 * `**Advisory outcome:**` line (or, on comments posted before that line existed, its `**Verdict:**` line) plus
 * its `Net basis: <base>..<head>` line, compared against the PR's live head sha. {@link parseAdvisories} reads
 * that; `operator-queue.mjs` cross-checks the label against it and reports any disagreement rather than trusting
 * either side silently.
 *
 * WHAT THIS PAIR NEVER DOES: touch `review:human`, or add `review:accepted`. Only a human's `/review` ceremony
 * clears the human gate; the strongest thing an advisory can do is say "nothing blocking on this head".
 */

/** The two advisory labels. Mutually exclusive on a PR; both are dropped the moment the head moves. */
export const ADVISORY_LABELS = Object.freeze({
  ACCEPTED: 'advisory:accepted',
  CHANGES: 'advisory:changes',
});

/** `gh label create` metadata — matches the labels created by hand in web-everything/web-everything and frontier-ui/frontierui. */
export const ADVISORY_LABEL_META = Object.freeze({
  [ADVISORY_LABELS.ACCEPTED]: Object.freeze({
    color: '0e8a16',
    description: 'AI advisory found no blocking findings on the current head (auto-managed)',
  }),
  [ADVISORY_LABELS.CHANGES]: Object.freeze({
    color: 'd73a4a',
    description: 'AI advisory found blocking findings on the current head (auto-managed)',
  }),
});

/** The advisory outcomes a comment can carry. */
export const ADVISORY_OUTCOMES = Object.freeze({ ACCEPT: 'accept', CHANGES: 'changes' });

/** The label an outcome maps to. */
export function labelForOutcome(outcome) {
  if (outcome === ADVISORY_OUTCOMES.ACCEPT) return ADVISORY_LABELS.ACCEPTED;
  if (outcome === ADVISORY_OUTCOMES.CHANGES) return ADVISORY_LABELS.CHANGES;
  return null;
}

const REVIEW_HUMAN = 'review:human';
const REVIEW_PENDING = 'review:pending';

/** Normalise a `labels` array (`[{name}]` from `gh --json`, or bare strings) to plain names. */
export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string' && n !== '');
}

/**
 * PURE: the label change that records `outcome` on a PR carrying `currentLabels`.
 *   - adds the outcome's label and removes the OPPOSITE advisory label;
 *   - on a `review:human` PR also drops `review:pending`, since the advisory has now run;
 *   - NEVER touches `review:human`, NEVER adds anything but an `advisory:*` label (in particular never
 *     `review:accepted`) — asserted by the tests, and structural here: `add` can only be one of the two constants.
 * Idempotent: a PR already showing exactly the desired state yields `{ add: null, remove: [] }`.
 *
 * @param {{outcome: 'accept'|'changes', currentLabels?: Array<string|{name?: string}>}} o
 * @returns {{add: string|null, remove: string[], reason?: string}}
 */
export function planAdvisoryLabels({ outcome, currentLabels = [] } = {}) {
  const desired = labelForOutcome(outcome);
  if (!desired) return { add: null, remove: [], reason: `unknown advisory outcome: ${String(outcome)}` };
  const names = new Set(labelNames(currentLabels));
  const opposite = desired === ADVISORY_LABELS.ACCEPTED ? ADVISORY_LABELS.CHANGES : ADVISORY_LABELS.ACCEPTED;
  const remove = [];
  if (names.has(opposite)) remove.push(opposite);
  if (names.has(REVIEW_HUMAN) && names.has(REVIEW_PENDING)) remove.push(REVIEW_PENDING);
  return { add: names.has(desired) ? null : desired, remove };
}

/**
 * PURE: every advisory comment on a PR, newest first, as `{ outcome, verdictLine, head, time, index }`.
 * A comment counts only when it carries BOTH a `**Verdict:**` line and a `Net basis: <base>..<head>` line — the
 * shape `renderAdvisoryNote` emits. `outcome` is the `**Advisory outcome:**` line when present; on a comment
 * that predates that line it falls back to the legacy reading (a `changes` mention in the verdict line).
 *
 * @param {Array<{body?: string, createdAt?: string}>} comments as `gh pr view --json comments` returns them.
 * @returns {Array<{outcome: string, verdictLine: string, head: string, time: number, index: number}>} `outcome`
 *   is `accept`/`changes`, or any other stated value verbatim (lowercased) — a caller treats those as neither.
 */
export function parseAdvisories(comments) {
  const advisories = (Array.isArray(comments) ? comments : []).flatMap((comment, index) => {
    const body = comment?.body ?? '';
    const verdictLine = body.match(/^\*\*Verdict:\*\*[^\r\n]*/m)?.[0];
    const basis = body.match(/^Net basis: `([a-f0-9]+)\.\.([a-f0-9]+)`/im);
    if (!verdictLine || !basis) return [];
    // Any stated word is returned AS STATED (e.g. a converted note's `inconclusive`) — only a comment with NO
    // outcome line falls back to the verdict line. A new outcome value is never misread as a clearing `accept`
    // (PR #2781 review, round 4).
    const stated = body.match(/^\*\*Advisory outcome:\*\*\s*`?([a-z-]+)`?/im)?.[1]?.toLowerCase();
    const outcome = stated ?? (/changes/i.test(verdictLine) ? ADVISORY_OUTCOMES.CHANGES : ADVISORY_OUTCOMES.ACCEPT);
    return [{ outcome, verdictLine, head: basis[2], time: Date.parse(comment?.createdAt) || 0, index }];
  });
  advisories.sort((a, b) => b.time - a.time || b.index - a.index);
  return advisories;
}

/** PURE: the newest advisory comment, or `undefined`. */
export function latestAdvisory(comments) {
  return parseAdvisories(comments)[0];
}

/** PURE: does an advisory's reviewed head (a sha or sha prefix) name the PR's current head? False when either is blank. */
export function advisoryCoversHead(advisory, headRefOid) {
  const head = String(headRefOid ?? '').toLowerCase();
  const reviewed = String(advisory?.head ?? '').toLowerCase();
  return head !== '' && reviewed !== '' && (head.startsWith(reviewed) || reviewed.startsWith(head));
}

/**
 * PURE: which advisory labels must come off because they no longer describe the PR's head.
 *
 * A label is STALE when the newest advisory comment does not cover the live head (a commit landed after the
 * review) or when there is no advisory comment at all (the label was applied by hand, or its comment was
 * deleted). An UNKNOWN head (blank `headRefOid`) drops nothing — never strip a label on missing data.
 *
 * @param {{currentLabels?: Array, comments?: Array, headRefOid?: string}} o
 * @returns {{remove: string[]}}
 */
export function planAdvisoryStaleLabels({ currentLabels = [], comments = [], headRefOid = '' } = {}) {
  const present = labelNames(currentLabels).filter((n) => Object.values(ADVISORY_LABELS).includes(n));
  if (present.length === 0 || !String(headRefOid ?? '')) return { remove: [] };
  const latest = latestAdvisory(comments);
  return { remove: latest && advisoryCoversHead(latest, headRefOid) ? [] : present };
}

/**
 * PURE: the label REPAIR for a human-gated PR whose newest advisory covers the live head but whose labels do not
 * show that advisory's outcome. This is the backstop for a missed label write: the `advise` step posts its note
 * and THEN writes the label as a separate effect, and that second write can fail (live 2026-10-05, PR #4015: a
 * GitHub rate-limit left the effect pending while the note already said "`advisory:accepted` is applied", so an
 * older `advisory:changes` sat under an accept note). The comment is the truth; the label is a derived view, so
 * the sweep re-derives it. Refuses (empty plan) unless the PR still carries `review:human`, the head is known,
 * and the newest advisory both covers the head and states a clearing/blocking outcome.
 *
 * @param {{currentLabels?: Array, comments?: Array, headRefOid?: string}} o
 * @returns {{add: string|null, remove: string[]}}
 */
export function planAdvisoryRepairLabels({ currentLabels = [], comments = [], headRefOid = '' } = {}) {
  const none = { add: null, remove: [] };
  const names = labelNames(currentLabels);
  if (!names.includes(REVIEW_HUMAN) || !String(headRefOid ?? '')) return none;
  const latest = latestAdvisory(comments);
  if (!latest || !advisoryCoversHead(latest, headRefOid)) return none;
  const plan = planAdvisoryLabels({ outcome: latest.outcome, currentLabels: names });
  if (plan.reason) return none;
  return { add: plan.add, remove: plan.remove };
}
