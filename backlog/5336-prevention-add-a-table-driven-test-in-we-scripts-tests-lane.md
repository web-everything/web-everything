---
bornAs: xboim7v
kind: story
size: 3
status: open
scope: ["we:scripts/lib/lane-repair.mjs", "we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-repair.test.mjs", "we:scripts/lib/__tests__/lane-repair.test.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a table-driven test in we:scripts/__tests__/lane-pool-repair.test.mjs of real network, auth a… (from web-everything/web-everything#4382 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4382's review (reviewed head `d2673323e7f705acb75e9b94cbef666ca1468f8f`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/lane-repair.mjs:36` — Add a table-driven test in we:scripts/__tests__/lane-pool-repair.test.mjs of real network, auth and lock error strings that must classify as not-corruption.
2. `we:scripts/lane-pool.mjs:853` — Clone into a temp sibling directory with the lease marker already written, then rename it into place atomically. Add a test that the lane path always carries a lease during re-clone.
3. `we:scripts/__tests__/lane-pool-repair.test.mjs:106` — Pair every 'never X' negative test with a positive control that proves the same setup does trigger X when the guard is removed or the lease is absent. A review-lens rule would be enough.
4. `we:scripts/lane-pool.mjs:1159` — Have `recloneLane` (or `quarantineLane`) take the caller's expected lease identity and re-read `.git/.lane-lease` immediately before the rename, refusing if it differs. A lint is impractical here; a focused concurrency test on this seam is the guard.
5. `we:scripts/__tests__/lane-pool-repair.test.mjs:104` — Add a deterministic regression test with a live lease and missing HEAD object that forces healing and retry to fail; require it to detect removal of the allowReclone guard.
6. `we:scripts/__tests__/lane-pool-repair.test.mjs:85` — Extend the deterministic quarantine integration test with tracked edits and an untracked sentinel, asserting their exact contents in the moved clone after recovery.

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
