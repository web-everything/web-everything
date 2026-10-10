---
kind: story
size: 5
status: resolved
priority: high
dateResolved: "2026-10-10"
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/settings/red-team.json"]
dateOpened: "2026-10-10"
tags: []
---

# Confirmed post-accept red-team breaks go back to the fixer

The post-accept red team (we:scripts/operations/review-extra-seats.mjs) is advisory only, so a PR with a confirmed broken finding reaches the operator queue as NEEDS YOU (live PR #4722, sent back by hand 2026-10-10). Add setting redTeam.confirmedBreaks (policy cascade; defaults broken=send-back, degraded=card, unconfirmed=advisory): parse the red-team comment for confirmed findings on the live head; send broken ones back as review:changes through review-set-label, bounded by the review round cap; file degraded ones as a follow-up card; keep such a PR out of NEEDS YOU while it has unresolved confirmed broken findings. Operator go 2026-10-10.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/red-team-gate.test.mjs we:scripts/operations/__tests__/red-team-gate-apply.test.mjs we:scripts/operations/__tests__/operator-queue-red-team.test.mjs (drop the we: prefixes to run)` fails before (the modules do not exist) and passes after: broken → send-back, degraded → card, unconfirmed → advisory, stale head → ignored, round cap → operator, operator-queue placement.
- [A2] **Replay** — `node we:scripts/operations/red-team-gate-apply.mjs --pr=4722 --repo=web-everything/web-everything --dry-run` on PR #4722's 02:04Z comment (head ea117e8) plans: send back finding 1 (two writers, broken), card finding 2 (stale config, degraded).

## Non-goals

- [N1] Never accepts, never removes `review:human`, never edits a label by hand: a send-back only adds a hold through `we:scripts/review-set-label.mjs`. The red-team pass itself stays advisory; only the gate acts.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — every rendered red-team field is one line (a model field cannot forge a `[**confirmed**]` line); the send-back body and card digest go through `sanitizeCardField`.
2. **Truncated reads** — the PR is read with a 256 MB buffer; an unreadable PR or settings file is a status / the built-in default, never an action.
3. **Shared state files** — the card goes through the shared detached landing job, never `file-item` in the daemon clone.
4. **Fail closed** — a confirmed finding with no stated impact counts as broken; an unknown round still sends back (adds a hold).
5. **Identity scoping** — only the comment whose marker names this PR AND the live head counts; one gate record per head dedups.
6. **State over time** — a new head makes the old comment stale (ignored); the round cap stops the loop and records `round-cap`.
7. **Who wrote it** — only trusted-author red-team and gate-record comments count (`isTrustedMarkerAuthor`); a forged marker does nothing.
