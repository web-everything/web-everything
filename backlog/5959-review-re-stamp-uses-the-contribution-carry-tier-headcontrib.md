---
bornAs: xni2w15
kind: story
size: 1
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Review re-stamp uses the contribution carry tier (headContribution)

Held finding 247 (2026-10-11). #4962 carry-equivalence is used by the drain carry and the merge-gate carry; the review re-stamp still does not use it: we:scripts/merge-ai-prs.mjs + we:scripts/review-set-label.mjs must pass headContribution. Not queued: wire after #4879/#4958/#4857 (which held these files) land.

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
