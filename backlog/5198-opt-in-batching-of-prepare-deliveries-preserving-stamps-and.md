---
bornAs: xqrggm7
kind: story
size: 5
parent: "4703"
status: open
blockedBy: ["5195"]
scope: ["we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/lib/card-batch-policy.mjs", "we:scripts/lib/card-batch-policy.json", "we:scripts/lib/__tests__/card-batch-policy.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Opt-in batching of prepare deliveries, preserving stamps and a priority bypass

Third #4703 delivery kind, disabled by default because prepares unblock builds. Today a prepare opens its own parked PR (we:scripts/operations/probation-build-run.mjs:666-672, park review:pending, draft first). When the prepare kind is enabled, route that delivery into a prepare batch instead. Eligibility for this kind allows a modification only to the one card being prepared (stamps preparedDate and preparedAgainstSha must survive), never any other path. A trusted frontmatter priority (never prose) bypasses batching and takes the existing per-item path. Default stays off: with the kind disabled, behaviour and argv are byte-identical to today. Measure prepare-to-build latency with batching on versus off before recommending it.

## Done when

1. **Executable** — `npx vitest run` over we:scripts/operations/__tests__/probation-build-run.test.mjs and we:scripts/lib/__tests__/card-batch-policy.test.mjs passes (strip the `we:` prefix to execute) with new cases below.
2. **Must** — with the prepare kind disabled (the default), the prepare open-pr argv is byte-identical to today (assert the existing `openPrArgv` output unchanged).
3. **Must** — with it enabled, a prepare is admitted to a prepare batch and its `preparedDate` / `preparedAgainstSha` stamps are present in the batched commit.
4. **Must (refuse on error)** — a prepare change touching any path other than the one card being prepared (docs, config, data, tests, source, another card) is refused admission and takes the per-item park path; an unknown or invalid prepare policy does the same.
5. **Must** — a card with the trusted frontmatter priority flag bypasses batching; priority words in prose never do.
6. **Live proof** — record prepare-to-build latency for equal windows with prepare batching off and on before recommending it on.

## Build checklist

- [ ] Branch at the prepare open in we:scripts/operations/probation-build-run.mjs:666-672 (`openPrArgv`, called at :618).
- [ ] Add the prepare eligibility variant (single modified card, same id) to we:scripts/lib/card-batch-policy.mjs.
- [ ] Keep `prepare.enabled:false` in we:scripts/lib/card-batch-policy.json.
