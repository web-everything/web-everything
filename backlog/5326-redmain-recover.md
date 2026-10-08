---
bornAs: xo7mr6l
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/conveyor/ci-heal-escalation-mark.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/__tests__/main-defect-escalation-recovery.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Re-run a PR once main recovers when its escalation blamed main's own defect

PRs #4368/#4369 sat needs-human after main was repaired: their red fell outside any red-main window (main's run was cancelled), so ci-heal escalated 'main's own defect' and nothing re-ran them. Recognise that escalation class and refresh onto main once, after main's required check is green on a newer main.

## Done when

1. **Executable** — the vitest file `we:scripts/conveyor/__tests__/main-defect-escalation-recovery.test.mjs` fails before this item lands and passes after.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Escalation comments are read only from trusted marker authors (`isTrustedMarkerAuthor`); a forged comment never matches.
2. **Truncated reads** — n/a: only comment text and check-run timestamps are read; a missing timestamp compares as not-recovered (refuses).
3. **Shared state files** — n/a: no shared state file; the only record is the head-scoped PR comment and the rebase-attempt comment.
4. **Fail closed** — A missing or unparsable timestamp, unread comments, or a PR that already has main's green commit refuses the refresh; the PR falls back to ci-heal.
5. **Identity scoping** — Escalation is scoped to one head sha; the refresh moves the head so the old escalation stops matching.
6. **State over time** — One refresh per head by default (`WE_MAIN_DEFECT_REBASES_PER_SHA`, 0 turns it off); a new red on the new head needs a new escalation.
7. **Who wrote it** — n/a: the escalation author is checked by the shared trusted-author rule.
