---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6446-prevention-add-a-deterministic-default-path-test-with-an-obs.md", "we:backlog/6448-red-team-follow-ups-from-web-everything-web-everything-5277.md", "we:backlog/6451-prevention-return-an-explicit-unknown-marker-so-the-smell-ca.md", "we:backlog/6453-prevention-make-the-fake-gh-in-the-cli-fixture-apply-label-a.md"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Implement the mapping gate filed in cards 5360/5473/5668, requiring explicit omitted-setting case… (from web-everything/web-everything#5676 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6446-prevention-add-a-deterministic-default-path-test-with-an-obs.md:22` — Implement the mapping gate filed in cards 5360/5473/5668, requiring explicit omitted-setting cases for default behavior.
2. `we:backlog/6448-red-team-follow-ups-from-web-everything-web-everything-5277.md:24` — Implement the preparation gate filed in cards 5360/5473/5668 and require each recorded reproduction to map to a named test with its observable outcome.
3. `we:backlog/6451-prevention-return-an-explicit-unknown-marker-so-the-smell-ca.md:22` — Implement the named-case preparation gate filed in cards 5360/5473/5668, including persistent-state assertions for state-over-time obligations.
4. `we:backlog/6453-prevention-make-the-fake-gh-in-the-cli-fixture-apply-label-a.md:25` — Implement the preparation mapping gate filed in cards 5360/5473/5668, requiring separate named cases for disablement, controls, and shortcut-path guards.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5473, finding 2 → #5473, finding 4 → #5473, finding 6 → #5473, finding 7 → #5473, finding 10 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5676@7c4e64e8c74cdca6f538e2baa88abb7500c69259

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
