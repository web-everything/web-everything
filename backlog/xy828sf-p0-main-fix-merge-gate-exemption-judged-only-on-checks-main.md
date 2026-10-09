---
kind: story
size: 5
parent: "x8juafk"
status: open
blockedBy: ["xjddimd", "x3r5fzx", "xoa99a8", "xy6r60l", "xp5c982"]
relatedTo: ["5510", "5118"]
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-08"
tags: [conveyor, priority, merge-gate]
---

# P0 main-fix merge-gate exemption: judged only on checks main does not also fail

Slice S4 of epic x8juafk (ruling Q5, merge-gate part). It ships LAST, after every other slice, behind its own fixture set and a red-team pass.

The incident's circular wait: the fix for red main was refused `owed-ci-rerun` and `main-still-red`, i.e. told to wait for main. For the P0 PR that owns the main-red fix only (the 5510 owner record): skip those two holds, and judge its CI only on the checks main does not also fail. Every check main passes must still pass on it. All other merge-gate guards stay.

## Acceptance

- [A1] **Executable** — fixtures: the P0 main-fix PR failing only a check main also fails is admitted; failing a check main passes is refused; a non-P0 PR with the same facts is refused exactly as today; an override-urgent PR that is not the episode's owner gets no exemption.
- [A2] A red-team pass on the diff is recorded on the PR before it lands.
- [A3] Live proof on the next red main: the owner PR is not refused `owed-ci-rerun` / `main-still-red`, and merges with every check main passes green.

## Non-goals

- [N1] Any exemption for P1-P4 or for a P0 that does not own the episode.
- [N2] Relaxing any other merge-gate guard.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the exemption keys on the owner record and check results only, never on PR text or labels.
2. **Truncated reads** — if main's check results cannot be read, no check is excused (today's refusal).
3. **Shared state files** — the owner record is read-only here.
4. **Fail closed** — an invalid setting or a missing owner record gives today's refusal.
5. **Identity scoping** — the exemption applies only to the exact repo, PR and head sha named by the episode owner.
6. **State over time** — an expired owner record or a green main ends the exemption.
7. **Who wrote it** — only the health watch's owner record grants it; an operator override alone does not.
