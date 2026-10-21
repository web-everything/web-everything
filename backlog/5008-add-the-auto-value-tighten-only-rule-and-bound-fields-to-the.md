---
bornAs: xhbe7xa
kind: story
size: 8
parent: "3383"
status: open
blockedBy: ["5113"]
scope: ["we:webeverything.config.json", "we:config/defineConfig.ts", "we:config/platformDefaults.ts", "we:config/deliveryPolicyDefaults.ts", "we:config/index.ts", "we:config/__tests__/config-contract.test.ts", "we:scripts/lib/delivery-policy.mjs", "we:scripts/lib/__tests__/delivery-policy.test.mjs", "we:scripts/drain-overlap-yield-config.json", "we:scripts/conveyor/land-overlap-yield.mjs", "we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs", "we:scripts/backlog.mjs", "we:scripts/__tests__/backlog-overlap-policy.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Add the auto value, tighten-only rule and bound fields to the delivery-policy loader

Extend the loader from #5113 with explicit auto opt-in, per-field shadow/live promotion and bounded resolution, following we:docs/agent/platform-decisions.md#delivery-decider-under-fixed-settings. Fixed values and invariants retain authority; safety fields can only tighten the platform default. Move overlap-yield configuration into the loader’s committed home, we:webeverything.config.json, and update its CLI writer and history reader together. The loader is still absent here and #5113 remains open, so this extension is blocked on that foundation.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/delivery-policy.test.mjs`: add an auto-resolution matrix that fails on the fixed-only predecessor. Assert invariant > authorized per-item override > fixed setting > bounded decider > platform default; fixed fields never invoke the injected decider. Unknown signals apply defaults and impossible fixed pins report `blocked: fixed-policy-conflict`.
- [A2] Accept auto only for supported strategy fields. Reject it for `prCi.*`, `dispatchGate.overlapOverride`, numeric bounds and promotion settings. For onMainRed, halt is stricter than warn, which is stricter than off; for recheckWhenMainMoved, always is stricter than age-bounded, which is stricter than off, and a shorter age bound is stricter. Refuse any proposed weakening relative to the resolved platform default.
- [A3] Promotion is per field and defaults to shadow. Shadow returns/logs the proposal but applies the platform default; explicit live promotion applies only a valid bounded proposal. Preserve existing numeric bounds including stack depth and repair reservation where supported; reject nonfinite, negative and out-of-cap values rather than raising host capacity. No default becomes auto.
- [A4] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs we:scripts/__tests__/backlog-overlap-policy.test.mjs`: the backlog config subprocess writes the canonical home under its existing lock discipline; the drain-facing adapter reads it, including historical label-time values. Old commits remain readable, current conflicting homes refuse with a migration diagnostic, and uncommitted edits cannot govern auto decisions. Preserve existing enabled/windowMinutes values during migration.
- [A5] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:config/__tests__/config-contract.test.ts` covers typed exports and invalid field shapes. Policy events include point, subject, choice/source, rule and proposal evidence through the predecessor journal; no silent fallback to a looser safety setting.

## Non-goals

- [N1] No decider rule table, automatic promotion or changes to host heavy-slot capacity.
- [N2] No second merge-delivery strategy loader or rewrite of unrelated policy dimensions.

## Edge cases this change must handle

1. **Untrusted text** — Treat config/override strings as data; validate enums and bounds and never execute an override as code.
2. **Truncated reads** — Incomplete git-show/config reads refuse with provenance; do not mistake a truncated committed policy for absent defaults.
3. **Shared state files** — Use the predecessor policy journal and existing locked writer; migrate the overlap file without two independently writable current homes.
4. **Fail closed** — Invalid auto proposals, unsafe overrides and read errors cannot relax invariants for source, docs, data or config changes.
5. **Identity scoping** — Bind overrides to repo/item/head and config reads to the committed ref; promotion for one field cannot enable another.
6. **State over time** — Preserve historical overlap windows and invalidate resolution caches on ref changes; a stale proposal cannot survive a settings change.
7. **Who wrote it** — Only authorized operator overrides and committed policy/promotion settings grant authority; a PR label with matching text alone is insufficient.

## Grounding

- we:docs/agent/platform-decisions.md:6093 defines precedence; line 6102 defines tighten-only safety; line 6105 requires shadow-first per-field promotion.
- we:docs/agent/platform-decisions.md:6120 requires one committed home for policy and overlap settings.
- we:config/defineConfig.ts:164 validates dimension entry shapes; we:config/platformDefaults.ts:43 contains current platform flavor defaults, not the missing delivery loader.
- we:scripts/conveyor/land-overlap-yield.mjs:53 names the separate JSON home; line 281 reads historical label-time windows; line 364 is its writer.
- we:scripts/backlog.mjs:64 imports the overlap reader/writer; line 1114 invokes the writer, so the subprocess caller belongs in the migration.
- we:scripts/lib/merge-delivery-policy.mjs:54 declares the separate mergeDelivery policy; its presence does not implement the #5113 five-dimension loader.

Size 8: typed policy/default/export changes, loader tests and migration of the existing overlap reader/writer and its subprocess caller.
