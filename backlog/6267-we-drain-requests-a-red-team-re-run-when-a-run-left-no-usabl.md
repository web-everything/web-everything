---
bornAs: xogmcq9
kind: story
size: 3
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: drain requests a red-team re-run when a run left no usable result (wire requestRedTeam)

The drain's requestRedTeam hook in we:scripts/lib/drain-merge-strategy.mjs (around lines 211 and 346) defaults to null and no caller passes it, so a red-team run that left no usable result is never re-requested. Live case: PR #5485, red team unparseable at 21:22Z; the review daemon's already-reviewed hold means nothing re-runs it. Wire requestRedTeam and re-arm the review daemon.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/lib/__tests__/drain-merge-strategy.test.mjs` plus the review-daemon hold test we:scripts/conveyor/__tests__/review-referral-hold.test.mjs. Named tests, one per guarantee:
  - `the drain passes requestRedTeam so a run with no usable result requests a re-run`
  - `a red team that left no usable result re-arms the review hold for that head`
  - `a head with a usable red-team result is not re-requested`
  - `the request is made once per head, not every tick`
  - `a failing requestRedTeam call is caught and the drain continues`
- [A2] Live case: PR #5485 (red team unparseable at 21:22Z) gets a re-run with before/after evidence.

## Non-goals

- [N1] Does not change how the red team judges, only when a missing result is re-requested.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the red-team output is only checked for a usable result, never evaluated.
2. **Truncated reads** — an unparseable or truncated result counts as no usable result.
3. **Shared state files** — the re-arm marker is written once per head through the existing hold ledger.
4. **Fail closed** — a failing request is caught and the drain proceeds without it.
5. **Identity scoping** — only trusted lane PRs are re-armed.
6. **State over time** — the request is keyed by head sha, so a new push starts fresh.
7. **Who wrote it** — the hold marker records that the daemon, not a person, re-armed it.
