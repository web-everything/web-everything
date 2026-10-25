---
bornAs: xozlo9c
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xg34dyx-review-stringency-hardening-before-preview.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — When a card moves acceptance items out of a slice, require a one-line justification per item tied… (from web-everything/web-everything#5541 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6246-review-stringency-hardening-before-preview.md:12` — When a card moves acceptance items out of a slice, require a one-line justification per item tied to the stated category. Add this as a review-lens checklist item for acceptance-moving cards.
2. `we:backlog/6246-review-stringency-hardening-before-preview.md:38` — Add a rule to the acceptance-move process: items asserting fail-closed or no-silent-empty behaviour must keep a base-level test in the original slice. Gate it with a check:standards rule that flags moved items containing 'unreadable', 'fail closed' or 'blocked'.
3. `we:backlog/6246-review-stringency-hardening-before-preview.md:22` — When a card copies items verbatim, qualify bare cross-references with the source card id (for example 'x77cl1h A9'). A lint over backlog cards for bare `A\d+` references outside their own card would catch this.
4. `we:backlog/6246-review-stringency-hardening-before-preview.md:9` — File a follow-up card or a land-time check that fails when backlog cards share verbatim acceptance ids across cards. Alternatively, make the drain auto-set the parent link.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5541@5ba5f21ae30f08f25e4f6c87443bcb907e4b7304

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
