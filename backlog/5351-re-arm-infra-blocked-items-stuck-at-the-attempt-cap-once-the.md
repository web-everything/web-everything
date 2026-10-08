---
bornAs: xg44s2t
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/infra-blocked.mjs", "we:scripts/conveyor/__tests__/infra-auto-rearm.test.mjs", "we:scripts/conveyor/__tests__/infra-blocked.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Re-arm infra-blocked items stuck at the attempt cap once the GitHub outage has passed

Coroner 2026-10-07 F5: seven items (#4381, #4537, #4669, 4603, 4605, 4826, 4765) sit at attempt 6 'GitHub outage (transient)' after the outage ended. The retry pass re-arms them through the rearm path when status is operational or after a cool-off, bounded by a max-auto-rearms knob.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
