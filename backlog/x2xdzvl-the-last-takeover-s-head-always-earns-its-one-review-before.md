---
kind: story
size: 3
parent: "xyr5c8u"
status: resolved
priority: high
scaffoldedBy: "last-takeover-review"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/takeover-budget.mjs", "we:scripts/conveyor/pr-status-label.mjs"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# The last takeover's head always earns its one review before the PR goes to the operator

Live #4708: takeover 2 pushed 483aab1e2 with the takeover budget spent. Its review paused on 2 mandatory referrals (advisory 'Pending: … await a ruling', 15:37Z); the planner read that paused advisory as a verdict, so we:scripts/conveyor/takeover-budget.mjs#takeoverProgress judged the takeover and posted 'rounds exhausted (6/5) — a person must take it over' (15:51Z), and we:scripts/conveyor/takeover-review.mjs#takeoverReviewGrant refused the woken re-review as head-already-reviewed (cap-exhausted 6/5, 16:20Z). Fix: a paused advisory is not a verdict (bounded: two paused advisories spend the grant); an operator-only takeover episode compares the PR head with the last reviewed head before it. (A budget-spent note listing what is still open was dropped: we:scripts/conveyor/reconcile-core.mjs is held by a sibling lane.)

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/takeover-budget.test.mjs we:scripts/conveyor/__tests__/pr-status-label.test.mjs`: budget spent + the last takeover's head unreviewed → its review is dispatched and no "a person must take it over" note; a review that only paused on referrals (`**Advisory outcome:** \`pending-referral\``) is not that head's review; after that review returns changes → `cap-exhausted (takeover-budget-spent)` and the round-cap note (needs-you); after an accept → no takeover, no grant, no note.
- [A2] **Live replay (dry run)** — #4708's thread at 15:51Z, 16:20Z and now: before, `head-already-reviewed` → `cap-exhausted 6/5` + needs-you note; after, a review is dispatched for `483aab1e2` (`takeover-awaiting-review`, no note).
- [A3] **Bounded** — one review per takeover head: a concluded verdict naming the head, or a second paused review after the takeover, spends the grant.

## Non-goals

- [N1] The merge gate and the `review:human` ceremony are untouched: the grant only lets the review run.
- [N2] Why the policy's last block ruling at 16:04Z posted no send-back on #4708 is a separate question.

## Edge cases this change must handle

1. **Untrusted text** — a paused note counts only from a trusted author; the outcome read is the LAST outcome line (juror text is folded to one line, so it cannot forge one).
2. **Truncated reads** — n/a: pure functions over the thread the planner already reads.
3. **Shared state files** — n/a: no state files.
4. **Fail closed** — an operator takeover with no reviewed head before it reads as never pushed (the old one-per-head bound), never as an endless grant.
5. **Identity scoping** — the grant stays per PR and per latest escalation anchor; paused notes are counted after that anchor only.
6. **State over time** — a paused review followed by a ruling re-opens the owed review once; a second pause spends it, and the block rulings then judge the head, so the PR reaches the operator instead of hanging at the round limit (live #4708: the woken review at 17:44Z paused again on the same referrals).
7. **Who wrote it** — trusted markers only (`isTrustedMarkerAuthor`), as before.
