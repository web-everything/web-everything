---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/judge-sweep-exit-rulings.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7327 (head d9e75efd6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7327 (reviewed head `d9e75efd6552ce887f5743438e152136d802e152`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/judge-sweep-exit-rulings.mjs:19` — (failing-input, degraded) Threshold-only settings disable exit-ruling selection
   - Scenario: Set we:scripts/settings/judge-sweep-stall.json to {"judgeSweepStall":{"waitingFixerMinutes":90}} and place {"key":"review.loop.exit.pr1"} in the default rulings history. The reader returns no PRs and 'exit rulings settings invalid' without reading history. A round-one exit-ruled PR consequently skips detail, and every listed PR receives the settings error. This is a valid existing threshold configuration; an omitted exitRulingsPath should use the default history path, while an explicitly invalid override can remain an error.
   - Class: live-reproduced (basis: A direct Node probe of readExitRulingPrs with injected file reads reproduced the rejection and confirmed only settings were read. The control with settings absent read the same history and returned PR 1. The existing resolveStallThresholds implementation and tests support threshold-only settings.)
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
