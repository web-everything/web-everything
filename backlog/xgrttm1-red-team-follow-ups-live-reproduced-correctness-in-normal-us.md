---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-gate-hold-class.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7531 (head 5dc85b3dd)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7531 (reviewed head `5dc85b3ddbd5659be3fa2a40ee5bd46fc9a2c7fe`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-gate-hold-class.mjs:255` — (failing-input, degraded) Missing red-team evidence bypasses the main-red admission refusal
   - Scenario: A review:pending PR has only merge-gate failing, with readable head-bound holds for red-main-freeze, review-acceptance, and red-team with reason 'no red-team check run on head'. Main has an open red window and workflowEditProtection is absent. With excusal enabled, enrichment preserves the failure, then incorrectly classifies it as real because isRedTeamMissing is conditional on workflow protection. planReconcile dispatches ci-heal with basis real. Removing only the missing-red-team hold produces the correct main-red refusal. Missing red-team evidence is review-owned regardless of workflow edi
   - Class: live-reproduced (basis: A Node probe parsed a complete gate-inventory job log through readMergeGateVerdict, applied excusePrMergeGateHolds and annotateMergeGateAdmission, then called planReconcile. It observed no dispatch and main-red without the red-team hold, but an admitted ci-heal when that hold was added. Only external evidence readers were injected.)
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
