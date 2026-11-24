---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7427 (head 3b588a10e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7427 (reviewed head `3b588a10e64e041566598d4bd6d70050ee914ee3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/heavy-admission.mjs:1329` — (edge-case, degraded) Automatic host switching strands previous-host markers in the shared slot pool
   - Scenario: Configure hosts as Mesa then Forge and maxConcurrent=2. While Mesa is unavailable, two Forge clients die, leaving unconfirmed markers; their remote jobs subsequently finish. When Mesa recovers, discovery selects it. Both hosts share the same remote slot directory, but the reaper only examines markers matching the selected host. The Forge markers therefore keep both slots blocked indefinitely while Mesa remains preferred, causing remote-full waits and local fallback despite available remote capacity. Cleanup must examine each marker using its original host's evidence, or isolate slot pools by h
   - Class: live-reproduced (basis: A read-only probe exercised production discovery, createMarkerReaper, and blockedSlots with an in-memory filesystem containing two dead-owner Forge markers. Mesa selection reaped nothing, performed zero telemetry reads, and retained blocked slots 0 and 1. A Forge reaper control cleared both markers after qualifying telemetry samples. No filesystem files were created or modified.)
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
