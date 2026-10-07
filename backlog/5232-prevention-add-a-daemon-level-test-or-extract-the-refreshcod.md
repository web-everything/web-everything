---
bornAs: x4ol7l8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/daemon.mjs", "we:tools/drain-daemon/__tests__/daemon.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a daemon-level test (or extract the refreshCodeClone branch into a lib function that takes injected o… (from plateauapp/plateau-app#211 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/daemon.mjs:316` — Add a daemon-level test (or extract the refreshCodeClone branch into a lib function that takes injected overlays, exists and rebuild stubs) asserting the rebuild is invoked at zero overlays with an existing clone.
2. `we:tools/drain-daemon/daemon.mjs:355` — Have the catch use the already-read overlay count (hoisted outside the try) instead of the literal 1, plus a test of that fallback reason.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#211@d8f922c7b68e346beb4249fd00b1ec9fb522c448

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
