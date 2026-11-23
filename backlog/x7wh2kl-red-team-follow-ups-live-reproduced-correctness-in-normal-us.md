---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7313 (head 95f1f8c75)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7313 (reviewed head `95f1f8c75a8a278a0f2bdefd819c678ff4be787d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-pass.mjs:1943` — (failing-input, degraded) Intake measures sibling-repository PRs in the WE checkout
   - Scenario: Reconcile a FrontierUI PR from the WE dispatcher checkout. This call supplies no repository-specific git reader, so readIntake uses process.cwd(). Reproduced with FrontierUI head d1371053c51b41b0bb3f4686eb03bee8cc43c1ec, base 5030f3c7bb725617bef48c38b83abde471c1ac9f, and round 1: the default reader returned unknown because WE lacks that commit; the same input using FrontierUI's checkout returned split-required with 1640 lines. Shadow mode therefore loses the split observation; enforcement produces intake-unmeasurable instead of filing the split. Resolve the target repository's checkout for int
   - Class: live-reproduced (basis: Observed both results using the production readIntake and createGitReader functions against existing local commits, without network calls or filesystem writes.)
   - Also class: correctness-in-normal-use
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
