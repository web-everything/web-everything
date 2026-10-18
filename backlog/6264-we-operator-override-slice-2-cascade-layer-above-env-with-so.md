---
bornAs: x9p23rk
kind: story
size: 5
parent: "6268"
status: open
blockedBy: ["6266"]
scope: ["we:scripts/lib/policy-cascade.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/lib/merge-queue-enqueue.mjs", "we:scripts/lib/__tests__/policy-cascade.test.mjs", "we:scripts/lib/__tests__/review-settings.test.mjs", "we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 2 - cascade layer above env with source logging

Add the operator-override layer to the resolvers that read the settable keys, per decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer): order standard < platform < tool < env < operator-override, every value from it logs source operator-db.

The settable keys and the resolver that reads each one:

- **Cascade keys** — `resolveCascade` (we:scripts/lib/policy-cascade.mjs) is pure. It takes the layer as an `operatorOverride` input, above env. `cascadePolicy` reads the layer through `readOperatorOverrides` on each call and passes it in, both for `.value` and for `.layered`, so a reader that applies env on top of `.layered` still loses to the override.
- **Referral safety keys** (`REFERRAL_SAFETY_KEYS`) — `resolveReferralSafetySettings` in we:scripts/lib/review-settings.mjs reads the layer above its own env path. `resolveReviewSettingSource` reports `operator-db` for a value taken from it.
- **Merge-queue switches** (for example `mergeQueue.refreshOnStaleMergeGate`, the decision's own example) — `resolveRefreshSetting` in we:scripts/lib/merge-queue-enqueue.mjs reads the layer above its env variable.

A key resolved anywhere else (a direct `resolveCascade` caller that does not go through `cascadePolicy`, or another resolver such as the merge-gate readers) is not settable. Slice 1's write refuses it, so an override is never stored where no resolver reads it.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/policy-cascade.test.mjs, we:scripts/lib/__tests__/review-settings.test.mjs and we:scripts/lib/__tests__/merge-queue-enqueue.test.mjs. Source-log tests set `WE_POLICY_CASCADE_LOG=1`, since the cascade log is silent under test without it. Named tests, one per guarantee:
  - `operator-override wins over env: order is standard < platform < tool < env < operator-override`
  - `a value taken from the layer logs source operator-db in the source line`
  - `cascadePolicy applies the layer to .layered, so a reader that applies env on top still loses to the override`
  - `resolveReferralSafetySettings reads the layer and resolveReviewSettingSource reports operator-db, separately from its own env path`
  - `resolveRefreshSetting reads the layer for a merge-queue switch and reports operator-db`
  - `every settable key resolves through a resolver that reads the layer`
  - `no operator layer present leaves every existing resolution unchanged`
  - `an unreadable layer is skipped and the lower layers still resolve`
  - `the layer is read each call, not cached across ticks`

## Non-goals

- [N1] Does not build the store or the write CLI (slice 1), the guard floor (slice 3) or the needs-you flag (slice 4).
- [N2] Does not wire the direct `resolveCascade` callers or other resolvers; their keys stay unsettable.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — override values are data merged by key and checked by the same `valid` rule as every other layer, never evaluated.
2. **Truncated reads** — an unreadable or partial layer (`readable: false` from slice 1) is skipped whole and each resolver falls back to lower layers.
3. **Shared state files** — n/a: this slice only reads the store owned by slice 1.
4. **Fail closed** — any layer error resolves to the lower layers, never to a half-applied override.
5. **Identity scoping** — n/a: no identity decision is made here; slice 1 owns the actor.
6. **State over time** — the layer is re-read on every resolve, so an expired entry stops applying on the next tick.
7. **Who wrote it** — the source log names operator-db for every value that came from the layer.
