---
kind: story
size: 3
status: open
dateOpened: "2026-10-08"
tags: []
---

# ci-red-recovery: an owed CI re-run waits forever while main is red on a different check

PRs #4494/#4446/#4511 failed 'test' inside a main-red window; both daemons refuse owed-ci-rerun and defer to ci-red-recovery-watch, which refuses main-still-red every tick because main's CI workflow stays red on daemon-soak only, while main's own 'test' is green. Recovery must be judged per failing check, so the owed refresh/re-run runs once per head.

## Done when

1. **Executable** — the unit test we:scripts/conveyor/__tests__/main-red-recovery.test.mjs fails before
   (the 2026-10-08 replay plans 3× `main-still-red`) and passes after (3× `rebase-onto-main`).
2. **Must (on error, refuse)** — any unread or truncated main job list, missing check name, or unreadable failure
   time keeps the old `main-still-red` wait. Nothing is guessed.
3. **Must (bounded)** — only a PR failure from BEFORE main's current green streak for that check is owed. A
   refreshed head that fails again later waits as before. The per-head attempt cap and marker comment are unchanged.
4. **Must (merge gate untouched)** — this only admits a refresh. Every required check must still pass on the PR.
5. **Setting** — env `WE_MAIN_RECOVERY_SCOPE=workflow` restores the old whole-workflow gate (default `check`).
6. **Live** — on the review daemon edge, the watch log shows one refresh per head for #4494/#4446/#4511, and their
   required checks re-run.

## Edge cases this change must handle

1. **Untrusted text** — n/a: inputs are GitHub run/job conclusions read through gh-throttle, not free text.
2. **Truncated reads** — `checkConclusions` is set only from a complete job list (`total_count === jobs.length`);
   no map reads as "unknown", which is never recovery.
3. **Shared state files** — n/a: no new state. The attempt record is the existing per-sha PR marker comment.
4. **Fail closed** — every unknown falls back to the old whole-workflow gate (`main-still-red`).
5. **Identity scoping** — recovery is judged for the PR's own failing check name only.
6. **State over time** — the green streak must follow a real red-for-check run on main; a later PR failure is never
   owed, so no refresh loop while main stays red on another check.
7. **Who wrote it** — n/a: unchanged; the marker-comment cap already counts trusted authors only.
