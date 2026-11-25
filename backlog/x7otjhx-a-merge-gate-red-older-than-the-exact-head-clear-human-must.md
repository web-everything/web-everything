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
