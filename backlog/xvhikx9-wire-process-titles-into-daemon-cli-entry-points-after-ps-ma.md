---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/process-title.mjs", "we:scripts/operations/runner-activity-io.mjs", "we:scripts/operations/heavy-queue.mjs", "we:scripts/conveyor/verify-dispatch.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# Wire process titles into daemon/CLI entry points after ps matchers use lease identity

we:scripts/lib/process-title.mjs landed unwired: process.title replaces the ps command text, which we:skills-src/conveyor/review-daemon.mjs liveReviewRoundBudget, we:scripts/operations/runner-activity-io.mjs scriptToken, we:scripts/operations/heavy-queue.mjs and we:scripts/conveyor/verify-dispatch.mjs read (codex audit WEAKENED on the wired attempt). Migrate those matchers to lease/pid identity, then wire setProcessTitle at: review-daemon, verify-daemon, review-job, review-loop-cli, review-extra-seats, verify-lane, reconcile-fix-dispatch-daemon, pass-daemon, pr-merge-watch-pass, pr-postmortem-pass, and the files skipped as occupied at 11:3x ET (merge-ai-prs held by #6338/#6288, health-watch by agent forge-share, lane-pool by #6319, heavy-admission by #6337/#6193, reconcile-pass by #6296).

## Acceptance

- [A1] **Executable** — `npx vitest run` on a test that sets the title and shows each matcher still counts/identifies the process via lease or pid, not command text.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: no change to titles format.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: matcher migration card; handled in its design.
2. **Truncated reads** — n/a: matcher migration card; handled in its design.
3. **Shared state files** — n/a: matcher migration card; handled in its design.
4. **Fail closed** — n/a: matcher migration card; handled in its design.
5. **Identity scoping** — n/a: matcher migration card; handled in its design.
6. **State over time** — n/a: matcher migration card; handled in its design.
7. **Who wrote it** — n/a: matcher migration card; handled in its design.
