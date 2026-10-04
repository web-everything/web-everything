---
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Confirmed-finding referral records close when a later review accepts the fix on a new head

Live 2026-10-04: PR #3833 was re-reviewed on head 8216c33fc after an Opus fixer addressed three CONFIRMED findings (security: unvalidated by/at in we:scripts/broadcast-inject.mjs; correctness: a partial ack suppressing delivery; ack before emit). The mandatory correctness and security lenses both accepted, and the advisory was accepted. Yet the PR still carried the 'Mandatory review owner ... CONFIRMED findings require a finding-specific block/card/not-real ruling' records for those same findings from earlier heads, so it still looked like it needed a ruling, and the operator had to approve it by hand. Fix: when a later review on a new head accepts and the earlier finding is no longer reproduced (same file and claim, matched as in the ignored-ruling detection from #3889), mark that referral resolved-by-fix with the head SHA, so the referral gate and the ruling-needed surfacing (#3889) stop counting it, and show that on the PR. Scope: the referral record and gate code in we:scripts/lib/jury-core.mjs (referralRecordState, mandatoryReferralState, renderReferralRecord) and we:scripts/operations/review-pr-io.mjs, with tests. Done when: (1) we:scripts/lib/jury-core.mjs records a resolved-by-fix entry carrying the accepting head SHA for a referral whose finding (same file and claim) is not reproduced by an accepting later-head review; (2) we:scripts/lib/jury-core.mjs referralRecordState and mandatoryReferralState no longer count a resolved-by-fix referral as pending, while a still-reproduced finding or a non-accepting review keeps holding; (3) we:scripts/operations/review-pr-io.mjs shows the resolved-by-fix state and head SHA in the PR referral comment; (4) tests cover resolved, still-reproduced, and not-accepted cases, red-green proven.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
