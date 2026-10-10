---
bornAs: x986p45
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-gate.mjs", "we:scripts/lib/daemon-live-smoke.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4788 (head f8f76322f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4788 (reviewed head `f8f76322f66162e67f4b1c4eb52f097aea8465f9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-gate.mjs:217` — (failing-input, degraded) The dynamic cap ignores the coordination root supplied through env.
   - Scenario: Call createResourceFixThrottle with env.WE_COORDINATION_ROOT pointing to a fresh healthy snapshot, WE_FIX_DISPATCH_MAX_CONCURRENT=2, two live fix claims, and queueLength=8; leave root unspecified and the process-default coordination directory without a snapshot. A read-only probe observed the cap reading the process-default directory and refusing at cap 2 with snapshot-missing. gateLaunch with the identical env read the configured directory and admitted. The cap should resolve its snapshot root from the supplied env too, producing cap 4 for this input.
   - Claude's re-check: createResourceFixThrottle defaults readSnap to readSnapshot(root ? {root} : {}) and never uses env. gateLaunch passes env to the shared admit/shadow call, so the two can read different snapshots. A root supplied only through env.WE_COORDINATION_ROOT is ignored by the cap, which stays at the floor.
2. `we:scripts/lib/daemon-live-smoke.mjs:163` — (edge-case, degraded) A fractional scale maximum now shortens timeouts when the host is busy.
   - Scenario: [withheld: failed the secret scrub]
   - Claude's re-check: admissionLoadFactor returns envMs(env, SMOKE_LOAD_SCALE_MAX_ENV, ...) directly, with no Math.max(1, ...) lower bound in the shown code. A fractional max, if envMs accepts it, scales budgets below 1× on wait/hold. This rests on smokeLoadFactor's clamp, which the diff doesn't show.

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
