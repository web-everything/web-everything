---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# ci-heal spends sessions on PRs whose only red check is the red-main freeze

[held entry 304] (coroner-redmain 2026-10-14, held) ci-heal spends sessions on PRs whose only red check is the red-main freeze. 7 escalations on unique PR heads concluded "merge-gate held by red-main-freeze; all real checks green": #5240, #5241, #5243, #5237 (red main 829a08272), and #5241, #5245, #5253 (red main 62da75ed3). In the window there were 13 escalated fix sessions (212 min). These sessions also took the 3 reserved ci-heal slots that the main-fix PRs were refused for. Fix idea: before admitting a ci-heal, read the merge-gate check output. If the only red is a red-main-freeze hold (and any review hold, card 259), record held-not-broken and dispatch nothing. Re-arm on the main-green transition. Same rule for the owed-rerun/refresh paths, which already refuse main-still-red. Evidence: fix-dispatch-daemon.log note ci-heal-escalated … red-main-freeze 2026-10-13T21:57Z–23:19Z and 2026-10-14T08:11Z–10:27Z; coroner run 2026-10-14 errorRates.fixSessions.escalated. Scope: we:scripts/conveyor ci-heal-pr-dispatch + reconcile-fix-dispatch admission. Size 2.

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
