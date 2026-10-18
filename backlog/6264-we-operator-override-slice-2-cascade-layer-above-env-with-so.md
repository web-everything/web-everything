---
bornAs: x9p23rk
kind: story
size: 5
parent: "6268"
status: open
scope: ["we:scripts/lib/policy-cascade.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/lib/__tests__/policy-cascade.test.mjs", "we:scripts/lib/__tests__/review-settings.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 2 - cascade layer above env with source logging

Add the operator-override layer to resolveCascade and resolveReviewSettings per decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer): order standard < platform < tool < env < operator-override, every value from it logs source operator-db.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` (vitest) on we:scripts/lib/__tests__/policy-cascade.test.mjs and we:scripts/lib/__tests__/review-settings.test.mjs. Named tests, one per guarantee:
  - `operator-override wins over env: order is standard < platform < tool < env < operator-override`
  - `a value taken from the layer logs source operator-db in the source line`
  - `resolveReviewSettings reads the layer and logs operator-db, separately from its own env path`
  - `no operator layer present leaves every existing resolution unchanged`
  - `an unreadable layer is skipped and the lower layers still resolve`
  - `the layer is read each call, not cached across ticks`

## Non-goals

- [N1] Does not build the store or the write CLI (slice 1), the guard floor (slice 3) or the needs-you flag (slice 4).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — override values are data merged by key, never evaluated.
2. **Truncated reads** — an unreadable or partial layer is skipped whole and the cascade falls back to lower layers.
3. **Shared state files** — n/a: this slice only reads the store owned by slice 1.
4. **Fail closed** — any layer error resolves to the lower layers, never to a half-applied override.
5. **Identity scoping** — n/a: no identity decision is made here; slice 1 owns the actor.
6. **State over time** — the layer is re-read on every resolve, so an expired entry stops applying on the next tick.
7. **Who wrote it** — the source log names operator-db for every value that came from the layer.
