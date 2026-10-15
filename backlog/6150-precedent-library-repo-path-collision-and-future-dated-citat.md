---
bornAs: xy7lj0j
kind: task
status: open
scope: ["we:scripts/lib/review-precedents-io.mjs", "we:scripts/lib/review-precedents.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-15"
tags: []
---

# Precedent library: repo-path collision and future-dated citation edge cases

Operator ruling 'card' on PR #5243 red-team findings (2026-10-15 ~08:50 ET). (1) we:scripts/lib/review-precedents-io.mjs ~38/85/98: distinct repos (acme/widgets-ui vs acme-widgets/ui) map to one precedent file; use an injective path encoding and filter events by source repo on read. (2) we:scripts/lib/review-precedents-io.mjs ~188 and we:scripts/lib/review-precedents.mjs ~158: a future-dated citation outranks later corrections; clamp event time to append time when folding. Tests for both.

Also covers the three citation-attribution findings the operator ruled card on PR #5243 at a071fa330:
- we:scripts/lib/review-precedents-io.mjs:85: backfilling an edited historical comment can replace a newer verdict with stale evidence.
- we:scripts/lib/review-precedents-io.mjs:188: removing a comment's last precedent citation leaves its previous attribution current.
- we:scripts/lib/review-precedents-io.mjs:98: a stale citation snapshot can restore an attribution that a newer snapshot withdrew.

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
