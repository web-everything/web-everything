---
bornAs: x1o8yjc
kind: story
size: 3
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/lib/jury-core.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a test that seeds an older-head superseded record plus its backing ruling and asserts assertM… (from web-everything/web-everything#3952 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#3952's review (reviewed head `54729c4489ae2cacc353761865027bbfb89994b1`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/review-set-label.mjs:2029` — Add a test that seeds an older-head superseded record plus its backing ruling and asserts assertMandatoryReferralsCleared does not hold. Longer term, make `records` a required argument of referralRecordState whenever a record carries `superseded`, so a missing pass-through fails loudly instead of defaulting to [].
2. `we:scripts/lib/jury-core.mjs:2306` — Add a negative-case test: same file, line within 8, a short summary sharing only some words with the ruled finding, expected `null`. Consider a symmetric or Jaccard measure, or a minimum word count, for the clearing path. Until that exists, the opt-out `WE_REFERRAL_ADVISORY_SUPERSEDE=0` limits the blast radius.
3. `we:scripts/lib/jury-core.mjs:2306` — Add a negative test fixture: a short ruled summary against a longer, different finding on a nearby line must not supersede. Tighten the match to Jaccard, or require equal summaries, before it clears. Longer term, add a lint or standards rule that heuristics reused for clearance paths need a named false-positive test.
4. `we:scripts/lib/jury-core.mjs:2398` — Refactor so the backing check reuses the same effective-ruling resolver (independence plus supersedes plus latest operator) as the own-ruling path. Add parity tests: any condition that leaves a finding pending when ruled directly must also leave a superseded duplicate pending.
5. `we:scripts/lib/jury-core.mjs:2401` — Add a deterministic regression test that creates a backed supersession, appends a block superseding its backing ruling, and requires the advisory key to become pending; share the active-ruling predicate between creation and resolution.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
