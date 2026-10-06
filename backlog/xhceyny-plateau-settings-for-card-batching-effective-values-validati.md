---
kind: story
size: 5
parent: "4703"
status: open
blockedBy: ["xk15cr3"]
scope: ["plateau:src/wip/card-batch-config.ts", "plateau:src/wip/card-batch-config.test.ts", "plateau:src/wip/glance/glance-card-batch.ts", "plateau:src/wip/glance/glance-card-batch.test.ts", "plateau:tests/e2e/card-batch-settings.spec.ts", "we:scripts/lib/card-batch-policy.mjs", "we:scripts/lib/__tests__/card-batch-policy.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Plateau settings for card batching: effective values, validation, live batches, save and read-back

Product settings for #4703 per the parent split (#4376: WE standard, Plateau settings UI). Follow the existing Plateau settings pattern in plateau:src/wip/ci-queue-config.ts (platform default plus a project override file under .operations that overrides named dimensions only): the WE policy reader layers an operator override file over the committed defaults, and Plateau shows per delivery kind the effective enabled flag, maxCards and maxAgeMinutes, field validation errors (the same refusal reasons as the WE validator), open batches with members and seal deadline, and save then read-back. An edit governs later admissions and never extends an existing batch deadline. Consume the #4376 shared policy contract if it exists when this is built; do not add a competing policy engine. Browser test covers save, reload, invalid value and keyboard access.

## Done when

1. **Executable** — in plateau-app, `npx vitest run` over plateau:src/wip/card-batch-config.test.ts and plateau:src/wip/glance/glance-card-batch.test.ts passes, and `npx playwright test` over plateau:tests/e2e/card-batch-settings.spec.ts passes against the running dev server (strip the `plateau:` prefix to execute).
2. **Executable** — in WE, `npx vitest run` over we:scripts/lib/__tests__/card-batch-policy.test.mjs passes with new override-layering cases.
3. **Must (refuse on error)** — an invalid value (zero, negative, non-integer, unknown kind) is shown as a field error with the WE validator reason and is never saved; an unreadable override file shows the error and the committed defaults as effective.
4. **Must** — save then reload shows the saved values; an edit applies to later admissions only and never extends an open batch deadline; the panel works with keyboard only.
5. **Must** — open batches show members and seal deadline from the coordinator state.

## Build checklist

- [ ] Mirror plateau:src/wip/ci-queue-config.ts (platform default plus a project override file of named dimensions only).
- [ ] WE reader: layer the override over we:scripts/lib/card-batch-policy.json inside we:scripts/lib/card-batch-policy.mjs; validation stays the single WE validator.
- [ ] Check #4376 for a shared policy contract before building; consume it if present.
