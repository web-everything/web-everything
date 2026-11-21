---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/operator-why.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7263 (head 46ea7c62a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7263 (reviewed head `46ea7c62a888a25922534db3fce8ab0cb13b9858`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:1648` — (edge-case, degraded) An older readable note masks a newer unreadable advisory
   - Scenario: With advisory reruns enabled, green required CI, and a mechanical live head, supply two trusted advisory comments: an older valid advisory on the previous head, followed by an advisory retaining its structured Net basis footer but missing its Verdict line. The newer comment alone produces unreadable:true. With both comments present, the helper instead returns owed:true and the planner dispatches head-moved-advisory, even with roundCap:0. The newer unreadable advisory should produce advisory-unreadable and no review dispatch.
   - Class: live-reproduced (basis: Executed the production helper and planner with this two-comment input. Confirmed latestAdvisory rejects the newer comment while reviewedHeadsOf recovers its previous-head SHA; that combination bypasses the unreadable guard.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/operator-why.mjs:47` — (failing-input, degraded) why reports review ownership while the planner dispatches CI repair
   - Scenario: Use a review:human PR with a stale readable advisory, a mechanical live head, reruns enabled, and required check gate completed with failure. planReconcile dispatches ci-heal and no review. The production createWhyReader followed by explainWhy nevertheless reports owner 'review daemon' and 'advisory re-run on bbbbbbbbb'. The explanation should reflect CI repair ownership until that prerequisite clears.
   - Class: live-reproduced (basis: Reproduced through the production planner and injected production why-reader boundary using identical PR and check data. Observed planner dispatch ['ci-heal'] alongside why owner 'review daemon'.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
