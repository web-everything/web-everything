---
bornAs: xcwn3oy
kind: story
size: 3
status: active
scaffoldedBy: "fix-5233"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/conveyor/advisory-label-sweep.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Review-hold sweep: key the stranded numbering-record check on review state, not a 30-minute expiry

PR #5233 made the review-hold sweep re-check a listed numbering re-stamp record every 30 minutes, because the open-PR listing carries no formal reviews and only the first 100 comments. A record stranded by a later approval or dismissal, or posted past the first page, can stand up to 30 minutes. Add latestReviews (or updatedAt) to the listing fields and fold it into the check key, so a review change re-checks at once; add jitter or a per-pass cap on live reads.

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
