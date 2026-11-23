---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-mq-failure-recovery-io.mjs", "we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7343 (head 31bd1dc43)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7343 (reviewed head `31bd1dc439974b8633cb92f406b4b4fdc2362c1f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-mq-failure-recovery-io.mjs:131` — (edge-case, degraded) Exhausted UNSTABLE heads cannot reach fixer routing
   - Scenario: Use a current main-based head with a bound failed_checks removal and a spent refresh ledger entry. Required checks pass, but a completed optional review-gate failure leaves mergeStateStatus='UNSTABLE', a state explicitly supported by the refresh path. The guard selects fixer with retriesExhausted=true, but routeMqFailureOnHold rejects the live state because it requires CLEAN. Even with the missing caller wired, this supported state never publishes fixer evidence. It should permit safe fixer routing while retaining the admission hold.
   - Class: live-reproduced (basis: Executed the checked-out guard and adapter source in a VM with stubbed remote I/O. The guard returned fixer with retriesExhausted=true; the adapter returned routed=false with the CLEAN-state refusal and published nothing.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/drain-queue-safety.mjs:365` — (failing-input, degraded) Passing-test stdout is mistaken for a real assertion failure
   - Scenario: Provide a failed job log containing a Vitest 'stdout | we:tests/logger.test.mjs &gt; logs expected errors' block, an echoed 'AssertionError: expected false', a blank line, then 'The runner has lost communication with the server.' With an unspent ledger and otherwise eligible PR, the new whole-log regex selects fixer and issues zero refreshes. The existing evidence collector correctly excludes the captured stdout and classifies this same transcript as infrastructure failure. The echoed assertion should not suppress the single infrastructure refresh.
   - Class: live-reproduced (basis: Executed the checked-out guard source with mocked transport and the actual normalizer, then passed the identical timestamped transcript to collectMqFailureEvidence. Observed guardAction='fixer', zero refresh requests, and collectorClassification='infra'.)
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
