---
bornAs: xojyi4c
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4914 (head 8ec12eb1a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4914 (reviewed head `8ec12eb1a8484125e87c7f65d5d06da4d43211b0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:497` — (edge-case, degraded) The first mechanical re-arm charges the original implementation as a fix round.
   - Scenario: Create a feature commit, then perform a drain rebase and mechanical re-arm before any review fix-begin. Follow this with four ordinary fix-begin → fix commit → re-arm cycles. A read-only probe of the unchanged counter returned real:5,total:5, including the original feature commit in the first mechanical round. With no initial fix-begin, start falls back to -Infinity. At the default cap, another bounce therefore exhausts the fixer budget after only four actual fixes. The initial mechanical refresh should consume zero rounds, leaving the fifth fix available.
   - Claude's re-check: With no fix-begin before the first re-arm, start stays at previous=-Infinity. Every single-parent non-drain commit in the range up to that re-arm then counts, including the original feature commit, so the round is charged as real.

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
