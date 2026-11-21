---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7142 (head f3d88e68c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7142 (reviewed head `f3d88e68cacbbf6d68f7d0a94471071327ce4c93`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/rerun-failed-once.mjs:65` — (failing-input, degraded) Duplicate names in passing tests prevent unrelated failed files from being retried
   - Scenario: A shard contains one failed file and a passing file with repeated assertion names. This PR's we:rerun-failed-once.test.mjs already produces repeated names through it.each cases titled 'refuses invalid paths/statuses'. parseReport rejects these names before planRetry filters out passing files. Consequently, rerunOnce returns 1 without launching any retry. Passing files with valid duplicate Vitest titles should not prevent an unrelated failed file from receiving its once-only retry.
   - Class: live-reproduced (basis: The installed Vitest JSON reporter emitted duplicate assertion names without error. Feeding that report into the actual rerunOnce function with injected IO returned exit 1 and zero retry invocations. Removing only the duplicate produced one retry and exit 0.)
   - Also class: correctness-in-normal-use
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
