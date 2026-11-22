---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7313 (head 2dcdb85fe)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7313 (reviewed head `2dcdb85fe126eb217cddcbbdb29bba78b81f82d9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-pass.mjs:1928` — (edge-case, degraded) Sibling-repository intake reads Git evidence from the WE checkout
   - Scenario: Run reconciliation from the WE checkout with repo='frontierui' and a Frontier UI PR whose head exists only in its own checkout. The new intakeReader call supplies neither a repository-specific Git reader nor cwd; readIntake defaults to process.cwd() and WE's origin/main. The head lookup therefore returns unknown, suppressing shadow observations and, with enforcement on, refusing an otherwise measurable PR as intake-unmeasurable. Resolve the target repository's checkout and measure against its own base.
   - Class: correctness-in-normal-use (basis: The existing reconciliation API supports sibling repositories. A read-only probe intercepting the default Git executor confirmed that a frontierui subject still runs both merge-base and diff in the WE working directory. No live sibling-repository run was performed.)
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
