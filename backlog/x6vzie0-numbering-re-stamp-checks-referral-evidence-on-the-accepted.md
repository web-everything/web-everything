---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/numbering-carry.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Numbering re-stamp checks referral evidence on the accepted prior head

Prove drain numbering before checking mandatory referrals, then check the accepted prior head whose review evidence exists. Recheck the same proof and live referrals before writes. This unblocks card-only numbering such as PR #5505 without clearing any standing referral. `review.numberingCarryReferralEvidence` defaults on, logs its source, and can restore the previous behavior.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` (we:scripts/lib/__tests__/numbering-carry-referral.test.mjs; host heavy queue) proves clean prior-head carry, held/unproven refusal, #5505 card renames, write-time rechecks, and the setting off.

## Non-goals

- [N1] Change referral rulings, accept author edits, or broaden numbering proof to code, config, or unrelated data/docs edits.

## Edge cases this change must handle

1. **Untrusted text** — Existing referral authentication and exact numbering proof remain authoritative.
2. **Truncated reads** — Unreadable proof or referral evidence refuses carry.
3. **Shared state files** — n/a: no new persistent state or endpoint.
4. **Fail closed** — Held prior-head referrals still refuse; unproven moves retain the live-head guard.
5. **Identity scoping** — Carry only the planned PR/repository and proven accepted-head → live-head pair.
6. **State over time** — Replan and recheck proof and referrals before each write.
7. **Who wrote it** — Keep existing acceptance and referral authorship checks.
