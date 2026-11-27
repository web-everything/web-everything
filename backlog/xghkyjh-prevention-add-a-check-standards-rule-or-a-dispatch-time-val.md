---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/fix-agent-brief.md", "we:scripts/conveyor/__tests__/stand-down.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a check:standards rule or a dispatch-time validator that rejects LANE_REF values outside [A-Z… (from web-everything/web-everything#7602 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/fix-agent-brief.md:183` — Add a `check:standards` rule or a dispatch-time validator that rejects `LANE_REF` values outside `[A-Za-z0-9._/-]`, since outside-attacker hardening is filed as debt at this release level.
2. `we:scripts/conveyor/__tests__/stand-down.test.mjs:905` — Run the zsh legs on a macOS CI job, or assert the production loop count through the same execution path.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7602@75fe58a3adc98bd5994e1666ba44d14c65d8ed95

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
