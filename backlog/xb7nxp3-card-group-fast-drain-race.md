---
kind: story
size: 5
status: open
scaffoldedBy: "fix-5762"
dateScaffolded: "2026-10-20"
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/card-group.mjs", "we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/card-group-drain-wiring.test.mjs", "we:scripts/lib/__tests__/card-group.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Card grouping: event-driven --only enqueues race whole-pass group formation

Card grouping (xym8nt4) forms only on whole drain passes. The enqueue-on-event `--only` fast drain (and its
10-minute catch-up) enqueues the PR that other card-only PRs yield to before a whole pass can group them, and
`queueBlocksGroup` then waits on that queued PR. So with enqueue-on-event on, a group forms only when a whole pass
wins the race. Decide the policy and prove it on a live overlap. Options: hold a card-only PR that shares a card
with another approved card-only PR out of `--only` enqueues so the next whole pass can group them, or form groups
in `--only` passes.

Also: changing the card-group state path (`WE_DRAIN_CARD_GROUP_STATE` or the coordination root) orphans a live
group. Its sources are released while the combined PR stays open, so both can land.

Found by the fix-5762 self-review (PR #5762, round 5).

## Acceptance

- [A1] **Executable** — a drain wiring test in `we:scripts/lib/__tests__/card-group-drain-wiring.test.mjs`: with
  grouping on and two approved card-only PRs sharing a card, an `--only` pass for the PR the other yields to does
  not enqueue it while a whole pass could group them, and the next whole pass forms the group. It fails on the
  tree before this item lands.
- [A2] **Executable** — a whole pass that cannot form the group (refused union, retry backoff) still enqueues the
  PRs serially, so the `--only` hold never starves a PR. Named test in the same file.
- [A3] **Executable** — a state-path change is detected (a group recorded under the previous path is still found,
  or the drain refuses to release its sources). Named test in `we:scripts/lib/__tests__/card-group.test.mjs`.

## Non-goals

- [N1] No change to the combined PR's review or the union proof.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads PR numbers and file paths already parsed by the drain.
2. **Truncated reads** — an incomplete file list (100-path cap) never counts as card-only; the PR is not held.
3. **Shared state files** — the hold decision re-reads group state under the same lock the enqueue uses.
4. **Fail closed** — an unreadable group state holds (as today); an unreadable open-PR listing does not hold.
5. **Identity scoping** — PR numbers are compared within one repository only.
6. **State over time** — the `--only` hold lapses once a whole pass has run for the current heads.
7. **Who wrote it** — n/a: only the drain writes the group state.
