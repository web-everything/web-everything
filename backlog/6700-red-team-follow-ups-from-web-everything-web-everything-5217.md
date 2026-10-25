---
bornAs: x8gycxc
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5217 (head 2bee68434)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5217 (reviewed head `2bee6843416a2c269cb843e2284d8ed522b446a3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:235` — (edge-case, degraded) Confirmation counts expired failures toward the strict-mode threshold.
   - Scenario: Persist two failures at t=0 with failureThreshold=3 and failureWindowMinutes=120. At t=121 minutes, gate a previously seen queued singleton #3; it is ejected and freshly re-enqueued before confirm(3, groupId, {already:false}). The confirmation path calls recordQueueExit without pruning failure history. Reproduced result: three stored failures trigger strictUntilMs at t=181 minutes, although only one failure is inside the window. Subsequent observe() removes the two expired failures but retains the full strict episode. Prune expired failures before every threshold evaluation, including confirma
   - Claude's re-check: confirm() calls recordQueueExit, which pushes a failure and compares state.failures.length to failureThreshold. It never prunes failures outside failureWindowMinutes first, unlike observeQueue. Two stale failures plus one new one therefore trigger strict mode. The window is narrow because observe normally prunes each pass, but the code path is real.

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
