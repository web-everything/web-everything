---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7438 (head 977b7f4ce)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7438 (reviewed head `977b7f4cef8e4133438aadb1a5693480e5011963`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/verify-lane-gate.mjs:501` — (failing-input, degraded) The full fallback drops the configured test timeout multiplier
   - Scenario: With WE_VERIFY_TEST_TIMEOUT_FACTOR=3, a we:package.json change on a known idle host selects plain 'npx vitest run' without timeout flags. A passing asynchronous test taking six seconds consequently fails at Vitest's five-second default instead of receiving the configured fifteen seconds. The fallback also omits decision.testTimeoutFactor, so its guard phase loses the multiplier too. Both phases should preserve the resolved timeout setting.
   - Class: correctness-in-normal-use (basis: An isolated read-only execution of the source confirmed that factor 3 produces neither timeout flags nor decision.testTimeoutFactor, and the resulting guard command also lacks timeout flags. The full suite could not run because markdown-it is unavailable; the failing scenario follows the documented Vitest timeout defaults.)
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
