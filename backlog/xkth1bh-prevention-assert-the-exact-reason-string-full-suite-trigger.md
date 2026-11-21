---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/test-selection.mjs", "we:scripts/lib/static-selection-edges.mjs", "we:scripts/lib/__tests__/static-selection-edges.test.mjs", "we:scripts/readiness/__tests__/test-selection.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Assert the exact reason string (full-suite trigger: we:package.json) with we:package.json tracked… (from web-everything/web-everything#7275 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/test-selection.mjs:727` — Assert the exact reason string (`full-suite trigger: we:package.json`) with we:package.json tracked in the fixture. A lint or review lens could flag `expect.any(String)` on a reasons array.
2. `we:scripts/lib/static-selection-edges.mjs:225` — Add a negative test per disjunct of each escalation condition. A review lens could ask for one test per clause of a compound guard.
3. `we:scripts/lib/__tests__/static-selection-edges.test.mjs:498` — For any guard that walks path components, add a table-driven test fixture with a symlink at each position (leaf, parent, grandparent). A write-gate listing the prose guarantees against test names would catch the gap.
4. `we:scripts/lib/static-selection-edges.mjs` — Remove the obsolete state and add deterministic unused-collection/dead-store analysis for scanner helpers.
5. `we:scripts/lib/__tests__/static-selection-edges.test.mjs` — Extend the named test in we:scripts/lib/__tests__/static-selection-edges.test.mjs to assert that maxTests: 1 returns all three tests, making truncation a deterministic test failure.
6. `we:scripts/lib/static-selection-edges.mjs:51` — Add a deterministic scanner regression matrix covering regex literals after ASI-terminated statements and asserting both retained edges and unknown status.
7. `we:scripts/lib/__tests__/static-selection-edges.test.mjs` — Add named tracked-package, tracked-lockfile and tracked-config tests, including a CLI wiring case, and require classifier-removal mutations to fail their full-mode assertions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7275@a7152dcbf8ced0afff77439458048d8552e7cfa9

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
