---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7305 (head 9118cfc61)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7305 (reviewed head `9118cfc61d2b223303ac497b49b4acf9ab0b7b1f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-queue-safety.mjs:968` — (failing-input, degraded) Assertion evidence in output.text does not prevent an unreadable-log retry
   - Scenario: Supply one validated failed soak-shard check with output.title and output.summary empty, output.text equal to 'AssertionError: expected true to be false', and its job-log request failing with HTTP 404. With fresh green main and a CLEAN PR, the reader returns infra:'unreadable-log' and the decision grants retry 1/1. The new veto inspects only title and summary, ignoring readable assertion evidence in text. It should retain the ordinary failure classification and hold automatic enqueueing.
   - Class: live-reproduced (basis: Executed the actual evidence reader and decision function in memory with this check payload and injected GitHub responses. Observed hold:false despite the explicit assertion in output.text; unrelated imports were stubbed.)
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
