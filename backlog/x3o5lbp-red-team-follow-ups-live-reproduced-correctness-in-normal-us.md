---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7517 (head 129442a92)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7517 (reviewed head `129442a926e8eebf7ec7ce4c531000081fdc7c88`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-loop-cli.mjs:904` — (failing-input, degraded) An explicit CLI model silently overrides the selected retry model.
   - Scenario: Enable retries and resume a parked Sonnet seat with an allowed Opus fallback using --model=sonnet. The loop selects and saves the Opus retry, but createDefaultJudge's factory model overrides it: the provider receives Sonnet with the extended timeout. The selected fallback should reach the provider, or the conflicting override should be rejected before consuming the retry.
   - Class: live-reproduced (basis: A createDefaultJudge probe with factory model sonnet and a retry request naming claude-opus-5-5-high observed the injected provider receiving model sonnet and timeoutMs 1800000. Missing unrelated parsing dependencies were stubbed in memory.)
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
