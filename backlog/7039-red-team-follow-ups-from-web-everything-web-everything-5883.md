---
bornAs: xy3hbmx
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5883 (head 00922e900)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5883 (reviewed head `00922e9004ea3cd28863d0d6fc4128c3385bfd9e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:969` — (failing-input, degraded) Permanent trigger ineligibility bypasses the retry cap indefinitely
   - Scenario: An open PR on fix/hung-ci, with a valid 40-character head SHA and a CI check older than 45 minutes, reaches hung-cancel-rerun. If REST cancellation returns HTTP 404, the real trigger rejects the non-lane branch with deferred:true. The new marker guard records no attempt, so every subsequent tick repeats cancellation and remains at attempt 1/2. An isolated in-memory probe using the production sweep, planner and trigger functions confirmed three cancellations and zero comments across three sweeps. Non-lane branches pass the candidate builder and production PR listing. This permanent refusal shou
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
