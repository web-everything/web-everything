---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:agent-memory-src/story-preparation-checklist.md", "we:scripts/conveyor/__tests__/run-rating.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a fixture test that feeds the exact example snippet from the checklist (or the 4385 card's ow… (from web-everything/web-everything#5138 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:agent-memory-src/story-preparation-checklist.md:113` — Add a fixture test that feeds the exact example snippet from the checklist (or the 4385 card's own MVP section) through findMustWithoutDoneWhen and asserts musts.length > 0. Do not let the lint return [] silently when a Must-like header has no numbered items.
2. `we:scripts/conveyor/__tests__/run-rating.test.mjs:1090` — Extend the deterministic unit test to assert that Number.MAX_SAFE_INTEGER is preserved and Number.MAX_SAFE_INTEGER + 1 becomes null for both fields.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5138@73c4695606083ec680af1d3702cbacf4bec2b771

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
