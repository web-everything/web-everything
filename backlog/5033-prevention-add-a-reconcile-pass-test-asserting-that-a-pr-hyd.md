---
bornAs: xywv3f6
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a reconcile-pass test asserting that a PR hydrated through the skip path never receives a CI-… (from web-everything/web-everything#3856 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1087` — Add a reconcile-pass test asserting that a PR hydrated through the skip path never receives a CI-consuming dispatch. A broader option is a lint that flags `ready.push(pr); continue` branches in hydrateChecks lacking an adjacent verdict assertion.
2. `we:scripts/conveyor/reconcile-pass.mjs:1016` — Add a deterministic parameterized regression test covering empty, unrelated-success, unrelated-failure, and partially observed required-check rollups, asserting the resulting CI verdict and dispatch behavior.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3856@99d8aabae8c60b0ba4a7d742185ba76b8b953f29

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
