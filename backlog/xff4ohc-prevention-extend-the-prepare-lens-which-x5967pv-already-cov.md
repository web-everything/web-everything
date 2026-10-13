---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5967-decide-needs-a-human-before-review-and-reuse-a-same-head-rev.md", "we:backlog/x5967pv-prevention-check-prepare-wiring-renderer-fixtures-and-test-selection.md"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Extend the prepare lens, which x5967pv already covers, to require a per-call-site test list whene… (from web-everything/web-everything#5156 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5967-decide-needs-a-human-before-review-and-reuse-a-same-head-rev.md:16` — Extend the prepare lens, which x5967pv already covers, to require a per-call-site test list whenever a design says 'at the X site' and grep shows more than one site. A card-lint rule that counts call sites of the touched label constant would make this deterministic.
2. `we:backlog/5967-decide-needs-a-human-before-review-and-reuse-a-same-head-rev.md:43` — Have the prepare lens require a repo-wide caller grep of each changed seam and a wiring test or an explicit 'covered by seam X' note for each caller, as the x5967pv A2 check already intends.
3. `we:backlog/x5967pv-prevention-check-prepare-wiring-renderer-fixtures-and-test-selection.md:29` — Add a card-lint rule that every Must or acceptance line maps to a named test in a file in scope, or is marked deferred. This is the same rule the card describes, tracked with #5739 and #5986.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5156@3e3ca7749078cc19f75d095d960d94a5fb0513c2

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
