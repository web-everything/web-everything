---
bornAs: xx5q05j
kind: story
size: 3
parent: "4075"
status: open

dateOpened: "2026-10-11"
tags: []
---

# Prevention — Add a test that asserts the gate's carry decision honours the drain's resolveHumanClearanceCarryS… (from web-everything/web-everything#4956 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/merge-gate-ci.mjs:98` — Add a test that asserts the gate's carry decision honours the drain's resolveHumanClearanceCarrySetting. Alternatively, document mergeGate.carryApproval as the gate's sole switch and note in the drain setting's $comment that it does not govern CI.
2. `we:scripts/lib/merge-gate-ci.mjs:98` — Have `defaultProveCarry` also honour `resolveHumanClearanceCarrySetting()` (carry only if both are on). Add a test that sets the drain env to off and expects the gate to hold. The cheapest durable guard is a standards check that one capability has one setting key.
3. `we:scripts/lib/__tests__/merge-gate-carried-approval.test.mjs:69` — Add one integration test running `evaluatePrGates` with the default prover in a temp-repo cwd. As a durable guard, require that every injectable IO default in a gate module has at least one test that uses it.
4. `we:scripts/lib/__tests__/merge-gate-carried-approval.test.mjs:133` — Add a deterministic loader regression test with platform carryApproval='off', empty repo settings, and empty environment; assert both the disabled value and platform source.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4956@64586adc1f6bef4b2fcc599d3712b17a866e4505

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

## Findings (standalone worker, 2026-10-13)

The build-dispatch daemon held #5895 with:

> worker-declined: **could-not-prepare** — unresolved setting-policy choice: - Require both the gate and drain carry settings to permit CI carry. - Keep 'mergeGate.carryApproval' as CI’s sole switch and document the drain setting’s limited scope. The card explicitly offers both. Current 'we:scripts/lib/merge-gate-ci.mjs:100' hardcodes 'enabled: true'; the drain resolves its separate setting at 'we:scripts/lib/human-clearance-carry.mjs:286'. Research found no ruling settling their relationship. No files changed, stamps added, or tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
