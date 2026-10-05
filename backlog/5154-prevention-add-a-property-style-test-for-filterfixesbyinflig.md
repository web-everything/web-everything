---
bornAs: xhtpp8y
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:docs/agent/platform-decisions.md", "we:scripts/lib/daemon-rebuild.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a property-style test for filterFixesByInFlightScope asserting that no two accepted entries o… (from web-everything/web-everything#3981 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1671` — Add a property-style test for `filterFixesByInFlightScope` asserting that no two accepted entries overlap in scope, run across normal, aged and urgent inputs. This is a deterministic gate over the whole class of 'bypass admits overlapping fixes in one pass'.
2. `we:docs/agent/platform-decisions.md:5700` — Review lens: for each 'fails closed' claim in a statute, require a test that asserts the outcome (decision is drop) on every failure branch. A cheap gate is a check:standards rule that links statute guarantee phrases to a named test.
3. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1671` — Add a test helper or property test for `filterFixesByInFlightScope` asserting that no two accepted entries overlap in scope unless explicitly exempted. That makes any override widening fail.
4. `we:scripts/lib/daemon-rebuild.mjs:2761` — Add a test asserting that `previewOverlayConflict` and `planRebuild` agree for the same conflict fixtures: replay-resolvable, unresolvable, and disabled.
5. `we:scripts/lib/daemon-rebuild.mjs:861` — Pass an explicit set of edges confirmed during this run to the resolver, and extend the existing deletion-failure regression test to require dropping the conflicting overlay despite a matching cached approved edge.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3981@c50a89b43e5bf71193cb1bf914f50628d77cb0e5

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
