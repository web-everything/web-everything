---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Queue-merged PR follow-up gives up after 5 attempts with only a log line; attempts are spent at collection ti…

Flow-sim gap D-C6, class K14 (progress counter counts only successes). Failing input: we:drain-merge-queue-followups.json pending[{num, headSha, followUpAttempts:4}]; PR already MERGED by GitHub; drainFollowupJob handed off=false (job launch failed -> inline path, we:drain-followup-job.mjs:380-395); cwd tracked-dirty or detached so local pull and resync fail (MAP:7466-7488) => localSynced=false' 'another pass (f… Cited: we:scripts/lib/drain-merge-strategy.mjs:705-708, we:scripts/merge-ai-prs.mjs:7679, we:scripts/lib/drain-merge-strategy.mjs:717, we:scripts/lib/drain-merge-strategy.mjs:694-697. Soak-break sketch: none

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
