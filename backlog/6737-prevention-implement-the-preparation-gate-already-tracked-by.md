---
bornAs: xjym1cr
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6495-prevention-add-a-drain-test-that-asserts-a-bounded-gh-graphq.md"]
dateOpened: "2026-10-19"
tags: []
---

# Prevention — Implement the preparation gate already tracked by cards 5360, 5473 and 5668: require structured o… (from web-everything/web-everything#5680 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6495-prevention-add-a-drain-test-that-asserts-a-bounded-gh-graphq.md:25` — Implement the preparation gate already tracked by cards 5360, 5473 and 5668: require structured obligation-to-test mappings before implementation readiness, permitting explicitly planned cases. Add a planned gate regression named rejectsBehavioralCardsWithoutNamedTestMappings in we:scripts/__tests__/check-standards-rules.test.mjs, asserting rejection when a case name or observable assertion is missing. The diff shows this prevention is filed, but does not demonstrate an existing executable gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5680@f74408693e3e4f42989fbefd57b5cebe711a6340

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
