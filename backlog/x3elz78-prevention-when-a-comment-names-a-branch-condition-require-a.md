---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/__tests__/review-referral-acceptance.test.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — When a comment names a branch condition, require a test fixture that sets that condition explicit… (from web-everything/web-everything#3787 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#3787's review (reviewed head `f9b02539517ff07a1ea3417a49533fd363ca1665`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/lib/jury-core.mjs:2342` — When a comment names a branch condition, require a test fixture that sets that condition explicitly. Review lens: 'a guarantee in prose needs a test that flips the stated condition'.
2. `we:scripts/lib/jury-core.mjs:2441` — A characterization test that pins the intended fate of old-head `blocked` (carried until the key is explicitly re-ruled or the finding is shown fixed). The existing test asserts only the drop and does not say whether the drop is deliberate, so a policy decision should be recorded in the operator doc and the test.
3. `we:scripts/lib/jury-core.mjs:2342` — Add two tests: (1) a disabled-seat block ruling whose reviewer id equals the author id must still hold, expected to redden under the `history.length` mutation; (2) an earlier same-head record with a later `updatedAt` must not clear a persistence failure, expected to redden under an `updatedAt` read.
4. `we:scripts/__tests__/review-referral-acceptance.test.mjs:129` — Extend the named test with createdAt before the failed review and updatedAt after it starts, asserting that acceptance still refuses; verify that preferring updatedAt makes this test fail.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
