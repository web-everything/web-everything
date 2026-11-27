---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7562 (head b6964d93e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7562 (reviewed head `b6964d93ed85614f489a21cbec603e319884f101`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-loop-cli.mjs:673` — (failing-input, degraded) Thrown juror errors still bypass JSON rendering under --json.
   - Scenario: Invoke with --json and have the juror reject with Error('401 Unauthorized'). The executable boundary returns plain-text lines beginning 'error: error-class:auth' and 'correlation-id:', so JSON.parse of stdout fails. It should return a classified JSON diagnostic, as the returned-drive-error path does. The new parameterized tests exercise this sequence but only check substrings, missing the malformed JSON output.
   - Class: live-reproduced (basis: Executed the checked-in diagnostic and executable-boundary function bodies in memory with an injected throwing driver and private logger. With argv containing --json, the result had code 1 and failed JSON.parse. Full-module execution was unavailable because the checkout lacks js-yaml.)
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
