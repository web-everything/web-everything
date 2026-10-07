---
bornAs: xqvjp8p
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/conveyor/__tests__/await-verify-pass.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a real-laneState test: a dirty git lane with { hashDirty: true } returns a string treeHash eq… (from web-everything/web-everything#4253 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/await-verify-pass.mjs:240` — Add a real-`laneState` test: a dirty git lane with `{ hashDirty: true }` returns a string `treeHash` equal to `computeWorkingTreeHash`, and without the option returns null. Make the fake io's `laneState` record its options so the pass test can assert `{ hashDirty: true }` for delivery/prepare and `false` for fix. A lint rule against io fakes that drop their parameters would catch the class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4253@179d4faf5073cbf2181f98a6c365a9ec39740f89

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
