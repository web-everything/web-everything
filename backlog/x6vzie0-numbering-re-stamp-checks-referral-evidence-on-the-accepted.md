---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/numbering-carry.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Numbering re-stamp checks referral evidence on the accepted prior head

Prove drain numbering before checking mandatory referrals, then check the accepted prior head whose review evidence exists and the live head for standing holds. Only the live guard's specific missing-current-head-evidence refusal can be satisfied by the proven move and clean prior head. Recheck the same proof and both heads before writes; failed reproof independently refuses the write even when referrals clear. This unblocks card-only numbering such as PR #5505 without clearing any standing referral. `review.numberingCarryReferralEvidence` defaults on, logs its source, and can restore the previous behavior.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` (we:scripts/lib/__tests__/numbering-carry-referral.test.mjs; host heavy queue) proves clean prior-head carry, held/unproven refusal, #5505 card renames, write-time rechecks, and the setting off.

## Non-goals

- [N1] Change referral rulings, accept author edits, or broaden numbering proof to code, config, or unrelated data/docs edits.

## Edge cases this change must handle

1. **Untrusted text** — Existing referral authentication and exact numbering proof remain authoritative.
2. **Truncated reads** — Unreadable proof or referral evidence refuses carry.
3. **Shared state files** — n/a: no new persistent state or endpoint.
4. **Fail closed** — Held prior-head or live-head referrals, persistence failures, and unreadable referral evidence still refuse; unproven moves retain the live-head guard.
5. **Identity scoping** — Carry only the planned PR/repository and proven accepted-head → live-head pair.
6. **State over time** — Replan and recheck proof and referrals before each write.
7. **Who wrote it** — Keep existing acceptance and referral authorship checks.

## Risks

- A review on the numbered head can record a hold before re-stamping finishes. Checking the prior head alone would skip it; check both heads initially and before each write, including label-only recovery.
- A proof can become unreadable after the initial check. A clearing referral guard must not replace that proof; retry without writing, or withdraw this pass's already-posted record before changing labels.
- Carry evidence only for the planned repository/PR and accepted-head → live-head pair. Setting-off and identical-net-patch paths keep their existing live-head guard without substituting numbering evidence.

## Test plan

- `numbering-carry-referral.test.mjs`: held referrals on either head; live-head holds initially, before the comment, and before labels; label-only recovery; live-head persistence/read failures; clean current-head evidence.
- The same file pins unreadable, thrown, and negative write-time proof with clearing referral guards, zero writes before the comment, and withdrawal after the comment.
- The named identity-scoping test asserts every proof's exact `fromSha`/`toSha` and both guards' `{repo, pr}` context. The unreadable-initial-proof test asserts only the live head is guarded and no writes occur.
- `numbering-carry.test.mjs` retains the live re-read regression after both initial head checks.
