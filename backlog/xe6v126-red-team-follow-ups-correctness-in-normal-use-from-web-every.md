---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/verify-dispatch.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7323 (head 9b021adba)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7323 (reviewed head `9b021adba6ccd18d77bef4edcf8609087c8013ab`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/verify-dispatch.mjs:452` — (edge-case, degraded) The ceiling retry discards configured test and hook timeouts.
   - Scenario: Start a default gate with this checkout’s testTimeoutFactor=3, so it carries --testTimeout=15000 --hookTimeout=30000. Let a transitive test hang until the gate ceiling, while a retained direct test normally takes eight seconds. The retry command omits both timeout flags, reverting to Vitest’s five-second test timeout and falsely failing the healthy direct test. The capped retry should retain the original timeout settings.
   - Class: correctness-in-normal-use (basis: Executing the actual requeue source with injected I/O returned true and generated a retry command without either timeout flag from a marker containing both. The production settings specify factor 3. A full Vitest run was unavailable because dependencies are absent; the false-red consequence follows from the generated command and Vitest’s default timeouts.)
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
