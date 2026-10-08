---
bornAs: xnbso9j
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/coroner-sample.mjs", "we:scripts/operations/__tests__/coroner-sample.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a main()-level test with a seeded ranking JSONL (3 identical rows) and an explicit --sample-s… (from web-everything/web-everything#4418 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/coroner-sample.mjs:265` — Add a main()-level test with a seeded ranking JSONL (3 identical rows) and an explicit --sample-size, asserting the requested N. Decide the intended precedence in the same change: either an explicit flag overrides the replayed N, or the docs say it only sets the large N.
2. `we:scripts/operations/__tests__/coroner-sample.test.mjs:96` — Add a readRankingRows test that writes more than 256 KiB (or injects a small TAIL through io) and asserts the returned rows are exactly the complete trailing lines. A standards rule requiring a test for every 'bounded read' claim would catch the whole class.
3. `we:scripts/operations/coroner-sample.mjs:214` — Add a vitest that mocks judge-spawn and snapshots the `judgeSpawn` call options for the coroner summariser, so adding tools or widening the input fails the test. More generally, any module that spawns a model should have a spawn-options contract test.
4. `we:scripts/operations/__tests__/coroner-sample.test.mjs:95` — Add a deterministic reader test asserting bytes requested and starting offset for a history larger than 256 KiB.
5. `we:scripts/operations/__tests__/coroner-sample.test.mjs:101` — Add a deterministic integration test with persisted reduced state and nonempty candidates whose answers all fail validation or throw.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4418@e5d4a4c0b77a4be1248ade3b38a13d54923345ae

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
