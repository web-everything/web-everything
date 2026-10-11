---
kind: story
size: 5
status: resolved
priority: high
scope: ["we:scripts/conveyor/takeover-budget.mjs", "we:scripts/conveyor/__tests__/takeover-budget.test.mjs", "we:scripts/conveyor/fix-takeover.mjs", "we:scripts/conveyor/takeover-review.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/settings/fix.json", "we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/review-status-tag.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-10-10"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Takeover budget per PR with a progress guard

Live: #4708 got one automatic takeover (#4756); round 6 still asked for changes (open findings 7 to 4), and a second takeover needed the operator by hand. New we:scripts/conveyor/takeover-budget.mjs: fix.takeoverBudget (default 2; cascade standard > platform we:scripts/lib/delivery-platform-preferences.json > repo we:scripts/settings/fix.json > env WE_FIX_TAKEOVER_BUDGET, source logged). A further takeover runs only when the previous one was judged and reduced the open findings (count or severity without the other growing); otherwise the operator gets a takeover-not-converging note listing what is open. Ruling disputes go to the operator at once. A PR held by its own gate (stacked base unmerged, awaiting-base, review:human hold, merge-gate/review-gate hold) with no open defect never triggers a takeover. Takeover 2+ brief carries the previous takeover diff and the review that rejected it, on the top rung; we:scripts/conveyor/takeover-review.mjs anchors on the latest takeover so each takeover head earns one review past the cap.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/takeover-budget.test.mjs`: a second takeover is dispatched when takeover 1 reduced the open findings; no progress escalates with a "takeover not converging" note listing the open findings; a spent budget goes to the operator; a gate that holds the PR itself (stacked base, awaiting-base, review:human, merge-gate hold) with no open defect never triggers a takeover. The module does not exist before this item, so the file is red before and green after.
- [A2] Replay (dry run, nothing posted): #4708's thread at round 6 plans takeover 2 of 2 on the top rung (open findings 7 to 4, weight 18 to 12). On the live thread, the head pushed by the second takeover (483aab1e2) is granted its own review (`takeover-review-spent` before this change).
- [A5] Every escalation dispatch past the cap (a takeover OR a fixer-escalation ladder rung) earns one review for the head it pushes, anchored on the latest dispatch's first push (live #4689 head 6e0d241df: `no-takeover` before, granted after). Every round cap (fix, advisory-fix, and review once the head is judged) leads to a takeover within the budget.
- [A6] One `status:*` label per PR (we:scripts/conveyor/pr-status-label.mjs: needs-you, takeover-running, fixing, at-round-limit, awaiting-base, awaiting-ci, awaiting-review, ready-to-merge), written by the existing review-status writer (we:scripts/conveyor/review-status-tag.mjs) every review-daemon tick; `npm run test:unit -- we:scripts/conveyor/__tests__/pr-status-label.test.mjs`.
- [A3] Must refuse on error: an unreadable thread, a takeover nobody judged yet, or a judged takeover with no measurable before-round is never read as progress: no further takeover runs.
- [A4] Must stay cautious: a ruling dispute always goes to the operator at once; the review gate and review:human ceremony are unchanged (a grant only lets a review run).

## Non-goals

- [N1] Does not change the round cap, the ruling ladder, or the merge gate; does not auto-resolve rulings.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — takeover signals and verdicts count only from trusted authors; findings and the previous diff are quoted in the brief as DATA, and a code fence inside the diff cannot close the block.
2. **Truncated reads** — the previous-takeover diff is cut at 12000 chars with the full `git diff` command named; a failed read leaves the command only.
3. **Shared state files** — n/a: state lives on the PR thread (markers), no new files.
4. **Fail closed** — no judged round after a takeover means no further takeover; a present but unparsable budget setting is 0 (takeover off), never the next cascade layer.
5. **Identity scoping** — per PR: episodes, rounds and the budget are read off that PR's own thread.
6. **State over time** — a takeover is an episode (signals with no verdict between); a void marker cancels its start, so a launch fault does not spend the budget.
7. **Who wrote it** — operator takeover comments and daemon markers both count, only from trusted logins.
