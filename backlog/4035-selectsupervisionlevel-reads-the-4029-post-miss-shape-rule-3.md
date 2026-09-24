---
bornAs: xqwoy0a
kind: story
size: 5
parent: "3383"
status: open
blockedBy: ["3949"]
relatedTo: ["4029", "3690", "3867", "3889"]
scope: ["we:scripts/lib/provider-routing.mjs", "we:scripts/lib/__tests__/provider-routing.test.mjs"]
dateOpened: "2026-09-24"
tags: []
---

# selectSupervisionLevel reads the #4029 post-miss shape: rule-3 carve-out, cause-aware step-back, toolingMissCap lever

Build the code side of ratified decision #4029 (we:docs/agent/platform-decisions.md#delegation-trial-record-graduation rules 3/5/6, ratified 2026-09-24) into we:scripts/lib/provider-routing.mjs's selectSupervisionLevel and its shared config: a rule-3 carve-out on the hard-veto reset, a cause-aware post-miss step-back test, and a new toolingMissCap lever. No live effect until #3949 lands (trial logging currently stops once a triple graduates).

## Details

1. **Rule-3 carve-out** — a confirmed miss still resets the triple at once EXCEPT when rule 5's
   tooling-caused-and-fixed path applies, in which case the reset is superseded and the triple keeps its
   graduated level.
2. **Cause-aware post-miss path** — the step-back to `full` fires only when a miss is both critical AND
   cannot be improved by tooling (no fix nameable, or the same failure class recurred per
   `recurrenceOfRootCause`), or a `toolingMissCap` has been reached. A tooling-classified miss with a landed
   `rootCauseFixRef` keeps the triple's graduated level — no demotion.
3. **`toolingMissCap` config lever** — a new field on `DEFAULT_BACKDOWN_THRESHOLDS` shaped
   `{ count: N, windowDays: null }`, defaulting to a LIFETIME non-decaying count per Fork 6's ratified
   default. The numeric `count` is a placeholder, tunable only by a future ordinary batched finding.
4. Restoring a stepped-back triple still requires an explicit ratified promotion act (rule 6, unchanged in
   mechanism) — this item does not build new restoration machinery.

## Done when

1. **Executable** — `npx vitest run we:scripts/lib/__tests__/provider-routing.test.mjs` gets cases (all
   reading the shared `DEFAULT_BACKDOWN_THRESHOLDS`/cap config, never a local constant) showing: a triple
   with a `rootCauseClass: 'tooling'`, a `rootCauseFixRef`, and a `rootCauseClassifiedBy` distinct from the
   builder triple keeps `spot-check` with no demotion; a triple whose miss is critical (by the sibling
   `isCriticalMiss` item) and whose class is `vendor` (or missing/invalid) steps back to `full`; a triple
   whose tooling fix recurred (`recurrenceOfRootCause` set) on a critical miss also steps back even though it
   was tooling-classified; and a triple that crosses `toolingMissCap` steps back regardless of any single
   incident's criticality.
