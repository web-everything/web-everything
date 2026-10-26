---
bornAs: xg637ec
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md", "we:backlog/7199-prevention-decision-preparation-coverage-and-citation-checks.md"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Extend the preparation gate (see #7199 item 2) so any status vocabulary term used in a test asser… (from web-everything/web-everything#5932 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md:166` — Extend the preparation gate (see #7199 item 2) so any status vocabulary term used in a test assertion is declared once in a state table, with each state's trigger given exactly once.
2. `we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md:150` — Add a preparation-gate rule: the Done-when command must name every test file that holds a planned case, and every 'uses the shared X' or 'registered in Y' sentence needs a named case. This belongs in #7199 item 2.
3. `we:backlog/7199-prevention-decision-preparation-coverage-and-citation-checks.md:38` — Apply the card's own item 2 guarantee-manifest rule to card 7199's edge-case section as the first positive and negative fixture.
4. `we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md:157` — Extend the #7199 guarantee-manifest gate so any 'only X can Y' sentence needs a mapped negative test from a non-X actor.
5. `we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md:60` — Add a card-lint or review-lens rule that any feature writing external strings into a backlog card must name an escaping and key-canonicalisation test.
6. `we:backlog/7199-prevention-decision-preparation-coverage-and-citation-checks.md:38` — Apply the same guarantee-manifest gate to edge-case sections and require a named case per never/does-not sentence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5932@398c05fd7581b96a8b42741df989c2680ed23615

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
