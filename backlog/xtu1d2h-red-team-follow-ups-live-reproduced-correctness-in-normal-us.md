---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/run.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7547 (head c099d3942)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7547 (reviewed head `c099d3942656c3649a72a305061b64ae89568ad0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/run.mjs:379` — (edge-case, degraded) A valid oversized refusal loses exit code 3 and the gate hint.
   - Scenario: Delete 1,000 files named we:src/generated/legacy-adapters/enterprise-integration-component-0000.ts through we:enterprise-integration-component-0999.ts, then verify with default selection on a saturated host. The production resolver produces a blocked refusal whose JSON exceeds 128 KiB. selectionRefusalFromOutput rejects it, so finish returns the generic outcome: both text and JSON modes exit 0, and text says 'complete. 0 effect(s) applied.' The wrapper should preserve exit 3 and a generic supply --gate hint even when diagnostic evidence exceeds its parsing bound.
   - Class: live-reproduced (basis: A read-only probe exercised resolveDefaultGate, selectionRequiredResult, resolveOperation and runOperationCli with injected Git/spawn results and an in-memory store. The generated refusal was 145,093 characters; its subprocess status was 3, but both formatted modes returned 0 and omitted the hint. JSON retained ok:false.)
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
