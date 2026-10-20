---
bornAs: x9p23rk
kind: story
size: 5
parent: "6268"
status: open
blockedBy: ["6266", "6269", "6265"]
scope: ["we:scripts/lib/policy-cascade.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/lib/__tests__/policy-cascade.test.mjs", "we:scripts/lib/__tests__/review-settings.test.mjs", "we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 2 - cascade layer above env with source logging

Add the operator-override layer to the resolvers that read the settable keys, per decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer): order standard < platform < tool < env < operator-override, every value from it logs source operator-db.

Activation waits for both the guard floor (6269) and the needs-you producer (6265), so the first effective loosening override already requires confirmation and has a visible feed path. The dependency order is store → floor → feed → resolver activation; the slice numbers are labels, not shipping order.

The settable keys and the resolver that reads each one:

- **Cascade keys** — `resolveCascade` (we:scripts/lib/policy-cascade.mjs) is pure. It takes the layer as an `operatorOverride` input, above env. `cascadePolicy` reads the layer through `readOperatorOverrides` on each call and passes it in for `.value`. It takes an `operatorOverride` option as a test seam, so unit tests never read the real host store. A key is settable only if its reader uses `cascadePolicy(...).value`. Readers that take `.layered` and apply env themselves (for example we:scripts/lib/drain-facts-source.mjs and we:scripts/lib/verify-settings.mjs) would let env beat the override, so their keys are not settable.
- **Referral safety keys** (`REFERRAL_SAFETY_KEYS`) — `resolveReferralSafetySettings` in we:scripts/lib/review-settings.mjs already resolves through `cascadePolicy`, with its env inside `envValues`, so it gets the layer from the cascade change. `resolveReviewSettingSource` must then report `operator-db` for a value taken from it.
- **Merge-queue switches** (exactly `refreshOnUnsatisfiedWorkflows` and `refreshOnStaleMergeGate`, the decision's own example) — the private `resolveRefreshSetting` in we:scripts/lib/merge-queue-enqueue.mjs reads the layer above its env variable. Tests go through its exported wrappers `resolveRefreshOnUnsatisfiedWorkflows` and `resolveRefreshOnStaleMergeGate`.

A key resolved anywhere else (a `.layered` reader, a direct `resolveCascade` caller that does not go through `cascadePolicy`, or another resolver such as the merge-gate readers) is not settable. Slice 1's write refuses it, so an override is never stored where env or nothing would beat it.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/policy-cascade.test.mjs, we:scripts/lib/__tests__/review-settings.test.mjs and we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs. Source-log tests set `WE_POLICY_CASCADE_LOG=1`, since the cascade log is silent under test without it. Named tests, one per guarantee:
  - `operator-override wins over env: order is standard < platform < tool < env < operator-override`
  - `a value taken from the layer logs source operator-db in the source line`
  - `cascadePolicy takes an injected operatorOverride layer and never reads the host store under test`
  - `resolveReferralSafetySettings gets the layer through cascadePolicy and resolveReviewSettingSource reports operator-db`
  - `resolveRefreshOnStaleMergeGate and resolveRefreshOnUnsatisfiedWorkflows read the layer above env and report operator-db`
  - `every settable key resolves through a resolver that reads the layer above env`
  - `no settable key is read through .layered by a reader that applies env itself`
  - `no operator layer present leaves every existing resolution unchanged`
  - `an unreadable layer is skipped and the lower layers still resolve`
  - `an invalid operator override is rejected by valid and lower layers still resolve` (numeric, enum, scalar and nested values; assert effective value and source in the cascade, referral-safety and merge-queue readers)
  - `a partial layer error applies no override, while an invalid value in a readable layer falls back only for that key`
  - `the layer is read each call, not cached across ticks`
  - `an expired or superseded override stops applying on the next resolve without reviving an older value`

## Non-goals

- [N1] Does not build the store or the write CLI (slice 1), the guard floor (slice 3) or the needs-you flag (slice 4).
- [N2] Does not wire the `.layered` readers, the direct `resolveCascade` callers or other resolvers; their keys stay unsettable.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — override values are data merged by key and checked by the same `valid` rule as every other layer, never evaluated.
2. **Truncated reads** — an unreadable or partial layer (`readable: false` from slice 1) is skipped whole and each resolver falls back to lower layers.
3. **Shared state files** — n/a: this slice only reads the store owned by slice 1.
4. **Fail closed** — any layer error resolves to the lower layers, never to a half-applied override.
5. **Identity scoping** — n/a: no identity decision is made here; slice 1 owns the actor.
6. **State over time** — the layer is re-read on every resolve, so an expired entry stops applying on the next tick.
7. **Who wrote it** — the source log names operator-db for every value that came from the layer.
