---
bornAs: xe3wqhx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a unit test for spawnGateBounded with a child that emits the marker and exits immediately, us… (from web-everything/web-everything#4054 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/verify-dispatch.mjs` — Add a unit test for spawnGateBounded with a child that emits the marker and exits immediately, using a large tailIntervalMs. Assert no timers remain and onGateStarted is not called after settle. Fix: set a `settled` flag in close/error and have onStderr/armGate no-op once it is set, or run stopTail() before clearTimeout(timer) and clear again afterwards.
2. `we:scripts/conveyor/verify-dispatch.mjs:402` — Open lane-controlled paths with O_NOFOLLOW|O_CREAT|O_TRUNC, or unlink first and use 'wx'. Better, add a lint rule that flags openSync(...,'w') on paths derived from a lane/git dir.
3. `we:scripts/conveyor/verify-dispatch.mjs:402` — Cap the log size by truncating and rotating on drain, or by having the child use a bounded writer. Cap notices per run (say 20) and strip control characters before logging. Add a test that emits more than N MB or N notices.
4. `we:scripts/conveyor/verify-dispatch.mjs` — Add a deterministic test that completes a file-backed child before its first poll, advances timers after settlement, and asserts no timeout callback or kill occurs; clear the timer after the final drain or prevent timer creation once settled.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4054@0df05a27282de813b43928793a45a17a6429f723

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
