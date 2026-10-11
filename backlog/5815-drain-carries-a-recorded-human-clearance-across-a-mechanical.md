---
bornAs: xnqxtdy
kind: story
size: 3
status: resolved
scope: ["we:scripts/lib/human-clearance-carry.mjs", "we:scripts/lib/__tests__/human-clearance-carry.test.mjs", "we:scripts/settings/human-clearance-carry.json", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Drain carries a recorded human clearance across a mechanical main refresh when the net diff is byte-identical

Live case PR #4722: operator cleared review:human on e125ac999; the drain's merge-queue freshness refresh moved the head (1e48ae9, then de961efb5, a merge of main) with a byte-identical net diff, but the permission-change hold in we:scripts/lib/review-escalation.mjs#decideReviewGate requires humanClearedSha === headSha, so it re-parked review:human and added review:awaiting-advisory; the operator had to approve identical code again. Fix: setting review.humanClearanceCarryForward (default true, we:scripts/settings/human-clearance-carry.json) — we:scripts/lib/human-clearance-carry.mjs proves the move mechanical (every commit between the cleared head and the live head that is not on main is a merge with a parent on main) and the net diff byte-identical to the human-cleared comment's reviewed-diff; the drain (we:scripts/merge-ai-prs.mjs#decideDrainReviewGate) then posts a durable carry record (reviewed-sha + cleared-human for the new head, plus a human-clearance-carried marker naming old head, new head, fingerprint) and honours the clearance. Any diff change or non-mechanical push keeps today's re-park.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/human-clearance-carry.test.mjs`: the #4722 replay (e125ac999 → 1e48ae9a4 → de961efb5, recorded markers + commit graph) fails on main's drain (permission-change re-park) and passes after: the gate merges and posts one carry record.
- [A2] Must refuse to carry when the net diff fingerprint differs, the live diff is unreadable, the clearance recorded no fingerprint, or any commit between the cleared head and the live head is not a merge with a parent on main (author push, rebase/rewrite, merge of another branch) — today's re-park stands.
- [A3] Must write the durable record (reviewed-sha + cleared-human for the new head, plus `human-clearance-carried: from= to= diff=`) BEFORE honouring the carry; a failed write defers the pass with no label change.
- [A4] Setting `review.humanClearanceCarryForward` (default true) in we:scripts/settings/human-clearance-carry.json; env `WE_REVIEW_HUMAN_CLEARANCE_CARRY` overrides; the effective value + source is logged once per drain process.

## Non-goals

- [N1] No change to who may clear `review:human`, to the contribution-tier coverage escape, or to the review-set-label restamp path; a restack (history rewrite) is carried only by the existing drain restamp, never by this gate.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the clearance is read through `parseLatestHumanClearedSha` / `isTrustedMarkerAuthor`; a forged comment is skipped (tested).
2. **Truncated reads** — an unreadable live diff or git error means no carry (fail closed to today's re-park).
3. **Shared state files** — n/a: reads one settings JSON; writes only a PR comment.
4. **Fail closed** — every missing input refuses the carry; a failed record write defers instead of merging.
5. **Identity scoping** — the sha and fingerprint come from the SAME latest accept-shaped comment, so an older clearance never lends itself to a later plain accept.
6. **State over time** — each carry re-binds the clearance to the new head, so a later refresh carries again from the latest record.
7. **Who wrote it** — the record is posted by the drain's own credential (trusted automation author), naming the original human clearer.
