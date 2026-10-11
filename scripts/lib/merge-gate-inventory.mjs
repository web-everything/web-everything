/**
 * @file scripts/lib/merge-gate-inventory.mjs
 * @description THE inventory of every gate the drain (`we:scripts/merge-ai-prs.mjs`) applies before its merge
 *   write, and where each one lives once GitHub's merge queue does the merging (strategy `github-merge-queue`,
 *   `./merge-delivery-policy.mjs`). Pure data + two pure helpers. Read off the drain's code, not guessed:
 *   `__tests__/merge-gate-inventory.test.mjs` scans the drain's source for every gate-shaped call
 *   (`DRAIN_GATE_CALL_RE`) and every skip kind (`drain-skip-reasons.mjs` SKIP_KINDS) and fails when one is not
 *   classified here — so a new drain gate without a CI counterpart (or an explicit reason it needs none) is red.
 *
 *   `where`:
 *     - 'merge-gate' — evaluated by the required `merge-gate` CI check (`./merge-gate-ci.mjs`) on `pull_request`
 *                      AND on `merge_group` (each PR in the group). The check is the merger's gate.
 *     - 'queue'      — guaranteed by GitHub's merge queue + the ruleset itself: required checks re-run on the
 *                      group commit (freshness against the latest main + the entries ahead), the exact tested
 *                      commit is what merges (head pin), mergeability is computed by GitHub, a push dequeues.
 *     - 'enqueue'    — scheduling the drain keeps deciding BEFORE it enqueues (order, caps, yields). These never
 *                      make a merge unsafe; they decide when, not whether.
 *   `input`: where the CI check reads the gate's facts — 'github' (API), 'git' (the checkout), 'ledger' (the
 *     shared `ops/review-requests` verdict ledger), or 'local-only' (only on the operator's Mac today → the CI
 *     check FAILS CLOSED for that gate and `card` names the backlog item that publishes it to a shared source).
 */

/** Gate-shaped calls in the drain. Every name this matches in merge-ai-prs.mjs must be classified below. */
export const DRAIN_GATE_CALL_RE = /\b(decide[A-Z]\w*|scan[A-Z]\w*|should[A-Z]\w*|is[A-Z]\w*(?:Frozen|Failed|Green|Merged|Pending)|diffBaseline|carrierPreflight|planCoupleCascadeStep|findDuplicateIds|revalidate\w*|classifyPr|hasNonEmptyBody|hasUnclearedReviewLabel|couplePinExcuses|planLabelDrain|computeOverlapContext|coupleImplOpen|applyEscalationRelief|acceptanceCoversHead)\s*\(/g;

/** Card that publishes the red-main freeze marker to a shared source (filed with this change). */
export const RED_MAIN_SHARED_SOURCE_CARD = '5805';
/** Card that wires strategy github-merge-queue into the drain + its enqueue-clearance marker. */
export const DRAIN_ENQUEUE_WIRING_CARD = '5803';

export const DRAIN_GATES = Object.freeze([
  { id: 'required-check-read', where: 'queue', input: 'github', signals: [], skipKinds: [],
    note: 'drain: a required-check read error skips; queue: the ruleset reads required checks itself' },
  { id: 'candidate-label', where: 'merge-gate', input: 'github', signals: ['planLabelDrain'], skipKinds: [],
    note: 'the drain only considers --label=ready-to-merge PRs; merge-gate requires the label too' },
  { id: 'producer-certified', where: 'merge-gate', input: 'github', signals: ['classifyPr'], skipKinds: ['not-certified'] },
  { id: 'default-base', where: 'merge-gate', input: 'github', signals: [], skipKinds: ['off-base'] },
  { id: 'required-check-green', where: 'queue', input: 'github', signals: ['isRequiredCheckGreen'], skipKinds: ['checks-pending'],
    note: 'ruleset required checks (test, smoke, daemon-soak, soak-replay-gate, merge-gate) on the group commit' },
  { id: 'codeql', where: 'merge-gate', input: 'github', signals: ['isCodeQLFailed'], skipKinds: ['codeql-failed'] },
  { id: 'mergeable', where: 'queue', input: 'github', signals: [], skipKinds: ['unknown-mergeability', 'conflicting'] },
  { id: 'landable-state', where: 'queue', input: 'github', signals: [], skipKinds: ['behind'] },
  { id: 'non-empty-body', where: 'merge-gate', input: 'github', signals: ['hasNonEmptyBody'], skipKinds: ['empty-body'] },
  { id: 'review-hold-labels', where: 'merge-gate', input: 'github', signals: ['hasUnclearedReviewLabel'], skipKinds: ['review-hold'] },
  { id: 'review-acceptance', where: 'merge-gate', input: 'git', signals: ['decideDrainReviewGate', 'decideReviewGate', 'acceptanceCoversHead'], skipKinds: ['review-hold'],
    note: 'acceptance covers the live head (reviewed-sha / reviewed-diff / contribution markers), escalation score, human-required, permission change, deviation' },
  { id: 'manifest-baseline', where: 'merge-gate', input: 'github', signals: ['diffBaseline'], skipKinds: ['escalated', 'parked'],
    note: 'drain baseline = first local sighting; CI baseline = every historical PR body (userContentEdits) — at least as strict' },
  { id: 'test-gaming', where: 'merge-gate', input: 'git', signals: ['scanTestTampering', 'shouldReparkForTestTampering'], skipKinds: ['escalated', 'parked'] },
  { id: 'head-pin', where: 'queue', input: 'github', signals: ['revalidateForMerge', 'revalidateFresh', 'revalidateWithUnknownRetry'], skipKinds: ['head-moved', 'stale-read'],
    note: 'the queue merges exactly the tested group commit; a push removes the PR from the queue' },
  { id: 'freshness', where: 'queue', input: 'github', signals: ['decideMergeQueueAction', 'couplePinExcuses'], skipKinds: ['unrecognized-reason', 'rebuilt-pending-ci'],
    note: 'the queue re-tests every PR against main + the entries ahead of it' },
  { id: 'red-main-freeze', where: 'merge-gate', input: 'local-only', signals: ['isDispatchFrozen', 'decideRedMainHold', 'decideQuarantineHold'], skipKinds: ['red-main-hold'], card: RED_MAIN_SHARED_SOURCE_CARD,
    note: 'marker lives in the drain checkout (.conveyor/red-main-freeze.json); no shared source yet → fail closed. red-main-hold (stop and quarantine modes) reads the same locally published red-main state, so it shares this gate' },
  { id: 'duplicate-id-on-main', where: 'merge-gate', input: 'git', signals: ['findDuplicateIds'], skipKinds: [],
    note: 'CI checks main and, on merge_group, the group tree (stricter)' },
  { id: 'couple-whole', where: 'merge-gate', input: 'github', signals: ['planCoupleCascadeStep', 'carrierPreflight', 'coupleImplOpen'], skipKinds: ['couple-held', 'partner-pending'], card: DRAIN_ENQUEUE_WIRING_CARD,
    note: 'manifest-less PR: vacuous (same as the drain); a manifest couple/blockedBy PR needs the drain enqueue clearance → fail closed until wired' },
  { id: 'blocked-by', where: 'merge-gate', input: 'github', signals: [], skipKinds: ['blocked-by'], card: DRAIN_ENQUEUE_WIRING_CARD },
  { id: 'overlap-yield', where: 'enqueue', input: 'github', signals: ['computeOverlapContext'], skipKinds: ['overlap-yield'] },
  { id: 'pass-cap', where: 'enqueue', input: 'github', signals: [], skipKinds: ['cap', 'ready-not-reached'] },
  { id: 'ledger', where: 'merge-gate', input: 'ledger', signals: [], skipKinds: [], extra: true,
    note: 'decideLedgerGate (pr-merge-gate.mjs), mode mergeGate.reviewAuthority; `labels` (default) = ledger not consulted, as in the drain' },
]);

/** Gate-shaped drain calls that are NOT merge gates, each with why. */
export const NON_GATE_CALLS = Object.freeze({
  shouldApplyReviewLabel: 'label-write idempotence',
  shouldRepollForLabelLag: 'listing re-poll',
  shouldPostParkReasonComment: 'comment routing',
  shouldLabelOnGreen: 'ci-lifecycle labelling',
  isRequiredCheckFailed: 'ci-lifecycle labelling',
  isRequiredCheckPending: 'ci-lifecycle labelling',
  decideParkToHuman: 'park label swap (the hold itself is review-hold-labels)',
  decideDrainLeaseGate: 'process lease (the queue serialises merges)',
  decideBatchesIdleExit: 'watch-loop exit',
  decideDurableEscalationRecord: 'durable comment',
  decideParkReadyStrip: 'label strip on park',
  isPrAlreadyMerged: 'idempotent merge write',
  applyEscalationRelief: 'operator LOOSENING (--no-review-escalation); merge-gate never applies it',
});

/** Skip kinds that are not a gate. */
export const NON_GATE_SKIP_KINDS = Object.freeze({
  'merge-failed': 'the merge write itself failed (GitHub reports a failed queue merge)',
});

export const GATE_IDS = Object.freeze(DRAIN_GATES.map((g) => g.id));

/** The names a source text calls that match DRAIN_GATE_CALL_RE. Pure. */
export function gateShapedCalls(sourceText) {
  const found = new Set();
  for (const m of String(sourceText || '').matchAll(DRAIN_GATE_CALL_RE)) found.add(m[1]);
  return [...found].sort();
}

/** Every gate-shaped name the inventory classifies (gate signals + non-gate calls). */
export function classifiedCalls() {
  return [...new Set([...DRAIN_GATES.flatMap((g) => g.signals), ...Object.keys(NON_GATE_CALLS)])].sort();
}

/** Every skip kind the inventory classifies. */
export function classifiedSkipKinds() {
  return [...new Set([...DRAIN_GATES.flatMap((g) => g.skipKinds), ...Object.keys(NON_GATE_SKIP_KINDS)])].sort();
}
