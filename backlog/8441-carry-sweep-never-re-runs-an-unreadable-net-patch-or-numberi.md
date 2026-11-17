---
bornAs: x7gnjwk
kind: story
size: 3
status: active
scaffoldedBy: "fix-5463"
dateScaffolded: "2026-10-16"
scope: ["we:scripts/review-set-label.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/lib/human-clearance-carry.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Carry sweep never re-runs an unreadable net-patch or numbering proof for a held-mechanical PR

Found fixing PR #5463 (repeated retryable-proof class). In the drain tamper park, an unreadable (retryable) net-patch or numbering proof in proveHumanClearanceCarry is dropped and the PR parks review:human. Routing it to review:held-mechanical does not help: the carry sweep's restamp path (review-set-label deriveHumanCarry) decides with a strict fingerprint compare only, and review-hold-reconcile skips held-mechanical PRs for the numbering restamp, so the proof is never re-run and the hold is handed to a person one hop later. Fix: let the held-mechanical sweep re-run proveHumanClearanceCarry (net-patch + numbering tiers) and keep a retryable result retryable, then have the tamper-park callback defer on a retryable proof. Prove end to end: tamper-park defer, then sweep re-runs the proof and lifts the hold. Also consider: identical-net-patch marks deterministic errors (lossy decoding, empty net patch) retryable.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
