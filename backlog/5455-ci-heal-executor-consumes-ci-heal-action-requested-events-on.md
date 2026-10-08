---
bornAs: x33k4z1
kind: story
size: 2
parent: "5452"
status: open
blockedBy: ["5454"]
scope: ["we:scripts/operations/dispatch-providers/ci-heal.mjs", "we:scripts/lib/ci-heal-reserve.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# ci-heal executor consumes ci-heal action-requested events on its own cursor and clone

Ruling E2: the ci-heal role becomes an executor reading only its own action kind, on its own clone, keeping its reserved slots (we:scripts/lib/ci-heal-reserve.mjs) as admission settings. A crashed ci-heal executor delays only ci-heal.

## Acceptance

- [A1] **Executable** — a test feeds a log with a ci-heal request whose cause is a new failed run on the same head as an earlier heal, and asserts the executor runs it (the cause in the key keeps a same-head re-run from being suppressed).
- [A2] The ci-heal executor reads only its own action kind through its own cursor, on its own clone.
- [A3] The ci-heal reserve stays an admission setting in the decider.
- [A4] The decider's ci-heal rules flip from shadow to live and the old ci-heal path stops in the same change.

## Non-goals

- [N1] No change to how a CI failure is healed.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — CI logs are data for the heal worker; they never choose the action.
2. **Truncated reads** — a failed log read starts nothing.
3. **Shared state files** — reserved slots are derived from worker events.
4. **Fail closed** — if the failed run cannot be confirmed on the current head, nothing is started.
5. **Identity scoping** — requests are keyed to repo, PR, head commit and the failed run.
6. **State over time** — a request for a superseded head is skipped.
7. **Who wrote it** — worker events name the executor role, clone and edge version.
