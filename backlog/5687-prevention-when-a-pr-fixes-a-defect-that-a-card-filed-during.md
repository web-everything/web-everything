---
bornAs: xvxua8e
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5695-review-ledger-check-scores-a-pr-whose-github-facts-were-only.md", "we:scripts/review-ledger-check.mjs", "we:scripts/__tests__/review-ledger-check.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — When a PR fixes a defect that a card filed during that PR's self-review describes, close the card… (from web-everything/web-everything#4688 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5695-review-ledger-check-scores-a-pr-whose-github-facts-were-only.md:15` — When a PR fixes a defect that a card filed during that PR's self-review describes, close the card in the same PR. A backlog check could flag active cards whose title matches a code change in the same diff.
2. `we:scripts/review-ledger-check.mjs:426` — Add a deterministic CLI regression test asserting that an oversized --days produces windows of at most 366 entries, with a timeout to catch removal of the clamp.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4688@448ee7a76b2cc4f3747ee7c953012436c78a3b8c

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
