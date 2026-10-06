---
kind: story
size: 3
parent: "4703"
status: open
scope: ["we:scripts/lib/card-batch-policy.mjs", "we:scripts/lib/card-batch-policy.json", "we:scripts/lib/__tests__/card-batch-policy.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Card batching policy and card-only eligibility core (prevention MVP)

Pure core for #4703 MVP. A committed policy file (precedent: we:scripts/lib/dispatch-routing-policy.json) with per-delivery-kind settings: prevention enabled, maxCards 10, maxAgeMinutes 120; filing and prepare disabled. A validator that REFUSES (returns a reason) on an unknown kind or key or a non-positive limit, never a silent default. A seal decision (count or age reached). A card-only eligibility check over the real changed-path list: only newly added regular backlog card files qualify; a modify, delete, rename, symlink, any path outside backlog (docs, config, tests, look-alike prefixes) or two versions of one card id disqualifies the whole change.

## Done when

1. **Executable** — `npx vitest run` over we:scripts/lib/__tests__/card-batch-policy.test.mjs passes (strip the `we:` prefix to execute; the file does not exist before this lands), covering every line below.
2. **Must (defaults)** — loading the committed policy yields prevention `{enabled:true, maxCards:10, maxAgeMinutes:120}`, filing and prepare `enabled:false`.
3. **Must (refuse on error)** — an unknown delivery kind, an unknown key, a missing file, unparseable JSON, a zero, negative or non-integer limit each return `{ok:false, reason}`; no case falls back to a default silently.
4. **Must (seal boundaries)** — 9 cards at 119 min does not seal; 10 cards seals (`count`); 1 card at 120 min seals (`age`).
5. **Must (every non-card input kind disqualifies)** — the eligibility check over a `git diff --name-status`-shaped list accepts only `A` of a regular backlog card file; it refuses `M`, `D`, `R*`, `T`, mode `120000` (symlink), and any path outside the backlog directory whatever its extension (docs, config, data, tests, source, a look-alike prefix such as `backlog-tools/`, `..` tricks), and two files for the same card id.
6. **Executable** — `npm run check:standards` green.

## Build checklist

- [ ] New we:scripts/lib/card-batch-policy.json (committed defaults; precedent we:scripts/lib/dispatch-routing-policy.json).
- [ ] New we:scripts/lib/card-batch-policy.mjs: `loadCardBatchPolicy`, `validateCardBatchPolicy` (refusing, unlike the per-key fallback in we:scripts/lib/verify-settings.mjs:44), `shouldSeal({count, openedAt, now}, policy)`, `cardOnlyEligibility(nameStatusRows)`.
- [ ] Reuse `CARD_ONLY_PREFIXES` from we:scripts/ci-card-only.mjs:17; do not fork the prefix list.
- [ ] Tests first; make them fail on the missing module, then pass.
