---
bornAs: xlc1ctk
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6216-prevention-a-pr-description-vs-diff-claim-check-on-behaviour.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a check in the prevention filer (#4317) so it only dedupes onto an existing card when the pro… (from web-everything/web-everything#5581 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6216-prevention-a-pr-description-vs-diff-claim-check-on-behaviour.md:56` — Add a check in the prevention filer (#4317) so it only dedupes onto an existing card when the proposed guard's target file or rule name appears in that card's scope or Acceptance. Otherwise it files a new card. Add a test with a non-matching card to confirm it files rather than dedupes.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5581@cd61e54db45b52079b25f13a9bca498fb17dec16

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
