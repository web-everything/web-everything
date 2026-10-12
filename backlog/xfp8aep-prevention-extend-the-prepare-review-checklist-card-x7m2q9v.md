---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Extend the prepare-review checklist (card x7m2q9v) to require each edge-case line that claims a g… (from web-everything/web-everything#5026 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md` — Extend the prepare-review checklist (card x7m2q9v) to require each edge-case line that claims a guarantee to cite a named Test plan entry.
2. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md` — Add a check to the test-plan template that any start/stop resource (timer, lock, handle) must be tested for the stopped state on every exit path.
3. `we:backlog/5749-drain-remove-the-unlocked-fallback-on-the-numbering-and-land.md:47` — Add table-driven resolver tests and an omitted-waitMs wrapper test to the required unit-test gate, covering default, zero, valid overrides, and invalid input.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5026@5aeea8c79d88924d1192707e0e9969e9efb2d383

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
