---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/lib/verify-lane-gate.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, live-reproduced, attacker-same-user] from web-everything/web-everything#7323 (head 93d09c0f1)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7323 (reviewed head `93d09c0f1951944b19e16d8d828a7e802da1c98c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/verify-dispatch.mjs:452` — (edge-case, degraded) Ceiling retries discard the configured test and hook timeouts
   - Scenario: With the default timeout factor of 3, an original gate carries --testTimeout=15000 --hookTimeout=30000. After a gate ceiling, the fallback command omits both flags. A selected test taking six seconds without its own timeout consequently fails under Vitest's five-second default, although it satisfies the configured policy. The retry should retain the configured timeout limits.
   - Class: correctness-in-normal-use (basis: An in-memory execution of the production requeue function returned success and emitted a retry command without either timeout flag despite settings.testTimeoutFactor being 3. The six-second test outcome follows from the documented Vitest timeout defaults; a full Vitest execution was unavailable because dependencies are absent.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/verify-lane-gate.mjs:595` — (failing-input, degraded) Leading whitespace bypasses explicit related-test capping
   - Scenario: Supply --gate=" npx vitest related we:scripts/lib/hub.mjs --run" with a leading space. The anchored expression fails to recognize this valid shell command, so it returns the unbounded related command unchanged, without selection metadata or gateUncapped audit. A hub can therefore trigger the same oversized walk without requesting --gate-uncapped. Leading whitespace should preserve normal capped behavior.
   - Class: live-reproduced (basis: Executing the production capExplicitRelatedGate function in memory with leading-space and leading-tab inputs returned each original unbounded command unchanged and no exemption metadata.)
   - Also class: attacker-same-user
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
