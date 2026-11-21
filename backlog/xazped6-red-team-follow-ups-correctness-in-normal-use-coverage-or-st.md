---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/soak/breaks/builder-only-mode-prepare.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7247 (head 305f41eaa)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7247 (reviewed head `305f41eaab15616007d8e9121a139202b93de63d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/soak/breaks/builder-only-mode-prepare.mjs:20` — (failing-input, degraded) The new soak fixture cannot launch its expected prepare
   - Scenario: Run the new soak replay with its ordinary unexpired list. Its injected effects omit listPreparePrs, so refusePrepareLaunch refuses card '2' with 'prepare PR listing unavailable'. Consequently launched returns an empty array, replay reports a violation, the soak assertion fails, and fixPresent returns false. Supply the successful empty PR-list reader so the expected listed prepare can launch.
   - Class: correctness-in-normal-use (basis: The fixture demonstrably omits the required reader. A read-only execution of the source-extracted launch guard confirmed that omission produces the refusal. Full daemon execution was unavailable because dependencies are missing in this checkout.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

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
