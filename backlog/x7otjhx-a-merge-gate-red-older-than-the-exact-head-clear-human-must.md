---
kind: story
size: 3
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# A merge-gate red older than the exact-head clear-human must not bounce the PR to review:changes

Live on PR 7452 at 8539625bf: merge-gate failed 2026-11-24 23:53Z, clear-human landed 11-25 11:24Z, no new run started, and at 11:45Z the PR was bounced for that old FAILURE. The bounce removed review:accepted, which we:scripts/merge-gate-check.mjs needs to read the clearance; re-arm refuses a cleared head and clear-human refuses without review:human, so no automatic path is left. Want: the changes verdict writer treats a gate result older than the clearance as stale and re-runs it instead. Related: card 7107 (re-run after clearance) and card 8203.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- stale-gate-verdict` passes on a new test (we:scripts/__tests__/stale-gate-verdict.test.mjs) that replays the PR 7452 timeline (gate FAILURE, then exact-head clear-human, then a changes verdict for that FAILURE) and expects no `review:changes` write and a gate re-run request. Fails today.
- [A2] **Must** — if the run time, clearance time or head cannot be read, keep today's behaviour (the red holds the PR).
- [A3] **Must** — a red from a run started after the clearance, on another head, or from any check other than `merge-gate` still bounces, whatever the diff holds (source, docs, config, data).

## Non-goals

- [N1] Does not let a fixer or daemon grant or restore a human clearance.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only trusted-author clearance markers count; check names come from the check-run API, never comment text.
2. **Truncated reads** — an incomplete comment or check-run page counts as unreadable (A2).
3. **Shared state files** — n/a: state is read from the PR itself.
4. **Fail closed** — see A2; a failed re-run request is reported and the PR stays held.
5. **Identity scoping** — clearance and run must name the same repo, PR and 40-hex head.
6. **State over time** — a newer push voids the exception.
7. **Who wrote it** — a forged clearance from an untrusted login is ignored.
