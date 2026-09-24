---
bornAs: x9s10dt
kind: story
size: 3
parent: "3383"
status: open
blockedBy: ["3949"]
relatedTo: ["4029", "3690", "4035"]
scope: ["we:scripts/lib/provider-routing.mjs", "we:scripts/lib/__tests__/provider-routing.test.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# Wire the delegation-trial 'critical miss' test to the existing deriveRisk / never-spot-check / humanRequired proxy

Fork 4 of decision #4029 (ratified 2026-09-24, codified in we:docs/agent/platform-decisions.md#delegation-trial-record-graduation rule 5) rules that 'critical' for the post-miss step-back test reuses the existing code-grounded escalation-severity proxy, never a new bespoke scale: build isCriticalMiss(record) in we:scripts/lib/provider-routing.mjs true iff deriveRisk(...) === 'high' (we:scripts/lib/dispatch-contracts.mjs, reading isHighStakesTask at we:scripts/lib/provider-routing.mjs) OR the touched files match any NEVER_SPOT_CHECK_PATH_PREFIXES group (we:scripts/lib/dispatch-thresholds.mjs: statute, gateSelf, irreversible) OR humanRequired is true for the diff (we:scripts/lib/review-escalation.mjs, the declarative-leash/statute layer). This predicate feeds the sibling selectSupervisionLevel item's cause-aware step-back test (critical AND cannot-be-improved-by-tooling). No live effect until #3949 lands.

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/provider-routing.test.mjs` gets cases showing
   `isCriticalMiss` returns true for a record whose task scores `deriveRisk(...) === 'high'`, for a record
   whose touched files match any `NEVER_SPOT_CHECK_PATH_PREFIXES` group (`statute`, `gateSelf`,
   `irreversible`), and for a record with `humanRequired: true`; and returns false for a record matching
   none of the three, reading the shared `deriveRisk`/`NEVER_SPOT_CHECK_PATH_PREFIXES`/`humanRequired`
   sources directly rather than a local re-implementation.
