---
bornAs: xhpelsc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5823-prevention-store-a-hash-of-the-request-and-compare-hashes-al.md"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — When a card narrows an acceptance predicate, add a review-lens rule: list every downstream branch… (from web-everything/web-everything#5200 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5823-prevention-store-a-hash-of-the-request-and-compare-hashes-al.md:16` — When a card narrows an acceptance predicate, add a review-lens rule: list every downstream branch that consumes the predicate's output and map each to a planned test. Filing this as a lens or doc note is acceptable; a deterministic gate is not feasible.
2. `we:backlog/5823-prevention-store-a-hash-of-the-request-and-compare-hashes-al.md:60` — Add a card-lint check in the prepare gate that flags 'must never'/'cannot'/'never' sentences in Design with no matching Test plan line, or require a Risks-to-Test mapping table. Not yet captured, so file it.
3. `we:backlog/5823-prevention-store-a-hash-of-the-request-and-compare-hashes-al.md:22` — Require preparation reviews to map each fail-closed design guarantee to a named planned regression and observable assertion, including exceptions during identity computation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5200@8cfa1e20800c4f47df7fc94744e4c946ae58cefd

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
