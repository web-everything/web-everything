---
bornAs: x60be9o
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a daemon test with a salvage row that asserts tagDispatchStatus is not called. More generally… (from web-everything/web-everything#3936 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:619` — Add a daemon test with a salvage row that asserts `tagDispatchStatus` is not called. More generally, require a test touching each changed source file in the net set.
2. `we:scripts/operations/ci-heal-pr-dispatch.mjs:347` — Call `readLiveFixClaim` before salvage and add a dispatch test where a live claim means `salvage` is not called. A review lens for `bypasses the in-dispatch claim` would also catch it.
3. `we:scripts/operations/ci-heal-pr-dispatch.mjs:409` — Add a CLI-formatting test for each `dispatched` kind. Alternatively, give salvage rows their own `salvaged` result array that the formatter handles explicitly.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3936@6b904e8112f087f5ed69a13fb3fca4e6177be179

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
