---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-job.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5890 (head f929f28c6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5890 (reviewed head `f929f28c6dcb531e9d112938583bbbcae9419db9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-job.mjs:300` — (edge-case, degraded) A crashed admission erases the unknown prior and permits a fresh model call
   - Scenario: Start with an accepted code head whose persisted status is finished/result:null, with no seat row or result comment. Invoke fresh recovery directly: admission preserves the unknown prior only in memory and overwrites storage with queued/result:null. Crash after that write, before guard rollback. Once the writer is dead, recovery normalizes this queued record to finished/null; the planner dispatches fresh and the next admission discards the prior. An in-memory probe of the production functions confirmed the original guard refuses, while the post-crash guard admits execution. This bypasses the c
   - Claude's re-check: demonstrated break

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
