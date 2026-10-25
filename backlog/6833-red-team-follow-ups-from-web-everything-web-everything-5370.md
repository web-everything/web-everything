---
bornAs: xhowd5m
kind: story
size: 2
status: open
scope: ["we:scripts/lib/dispatch-routing-policy.json"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5370 (head c39543882)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5370 (reviewed head `c39543882e4c82ef7914efd1e9af97884fe2305a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/dispatch-routing-policy.json:77` — (edge-case, degraded) The inherited feature route silently ignores explicit model pins.
   - Scenario: Dispatch the same non-critical feature with extraArgs=['--model=opus'] and modelReason='operator requires Opus'. Production routing now supplies a probation worker without policyRoute. The launch-boundary probe invokes probation with Codex or Argon instead of honoring the Opus pin: pinnedModel is checked only inside the policyRoute branch. Feature dispatch should preserve the existing reasoned model override.
   - Claude's re-check: The diff makes build-new-feature 'inherit', so there is no policyRoute. The pinnedModel check sits next to workerFor in routeDispatchProvider, which the diff context shows is only reached with a policyRoute. The new 'default' test launches Argon through the probation provider with no policyRoute, so a '--model' pin plus modelReason would be ignored. Before the PR, the explicit codex policy route honoured the pin.

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
