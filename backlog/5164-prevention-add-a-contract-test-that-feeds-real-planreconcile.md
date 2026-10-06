---
bornAs: xs8a5m0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a contract test that feeds real planReconcile live-process output (with a bound agent carryin… (from web-everything/web-everything#4022 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:711` — Add a contract test that feeds real planReconcile live-process output (with a bound agent carrying `name`) through formatRefusalLine. Alternatively, have the card's executable done-when assert on producer output, not a synthetic row.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4022@03324a30cf4db87cb47edff1b6647172e5c36f45

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
