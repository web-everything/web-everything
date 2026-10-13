---
bornAs: xw2vzzs
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/prepare-failure-policy.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/lib/probation-launcher.mjs", "we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — A review-lens checklist item: every changed branch in a policy file needs a named test that fails… (from web-everything/web-everything#5024 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/prepare-failure-policy.mjs:322` — A review-lens checklist item: every changed branch in a policy file needs a named test that fails when the branch is reverted.
2. `we:scripts/conveyor/prepare-failure-policy.mjs:78` — Extract the 'hold kinds that reset the budget on release' list into one constant and add a test that iterates every holdReason-bearing cause through the release path.
3. `we:scripts/conveyor/tick-core.mjs:1278` — Have the daemon (the IO shell) resolve the policy and pass config.prepareAutoSize. Add a tick-core test that fails if planTick imports a settings reader.
4. `we:scripts/lib/probation-launcher.mjs:216` — In the prepare tamper check, allow `estimatedLoc` to change only when it was absent or invalid before the worker ran, and add a probation-build-run test where lowering a valid `estimatedLoc` is rejected.
5. `we:scripts/lib/probation-launcher.mjs:216` — Add a deterministic runner test that supplies a sized story with worker-added estimatedLoc and asserts rejection before stamping; enforce kind-sensitive ownership validation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5024@6117ef71a00d1359f05977860bae9c6ff37b81f8

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
