---
bornAs: xuh8t7q
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5958-every-github-call-carries-a-caller-name-40-are-unattributed.md"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a card lint in check:standards that requires each numbered edge case with a handling (not n/a… (from web-everything/web-everything#5136 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5958-every-github-call-carries-a-caller-name-40-are-unattributed.md:62` — Add a card lint in check:standards that requires each numbered edge case with a handling (not n/a) to be referenced by a test-plan bullet or an explicit test-case name.
2. `we:backlog/5958-every-github-call-carries-a-caller-name-40-are-unattributed.md:57` — Add the named generated-shim regression test using shell eval text containing a plausible script path, and run it in the focused test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5136@7af849a4e01cedaf8ca3fb34505e47514c8bfb5a

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

## Also raised by

- Also raised by web-everything/web-everything#5549 (finding 2: `we:backlog/6269-we-operator-override-slice-3-guard-floor-confirm-and-flag-on.md:15` — Card-lint: each numbered edge-case line that claims handling not 'n/a' must map to a test name in A1.)
- Also raised by web-everything/web-everything#5525 (finding 1: `we:backlog/6240-overlap-yield-known-holds.md:38` — Add a card-lint rule in check:standards: every numbered 'Edge cases' item must be referenced by an Acceptance ID or marked n/a.)
