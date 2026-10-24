---
bornAs: xnyxe7k
kind: story
size: 2
status: open
scope: ["we:scripts/codex-direct-task.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5835 (head ed46762f5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5835 (reviewed head `ed46762f56a9475b08fa8f1507e96bff32963d9d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/codex-direct-task.mjs:1221` — (edge-case, degraded) A backward wall-clock adjustment extends the advertised wait deadline.
   - Scenario: Run wait --max-ms=250 for a running job and move the wall clock backward by 1000 ms during the wait. Because deadline calculations use Date.now, polling continues for approximately 1250 ms. A read-only probe simulating that clock step through the injected now callback measured 1251 ms. The same mechanism can exceed the nine-minute cap. Measure elapsed wait time with a monotonic clock.
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
