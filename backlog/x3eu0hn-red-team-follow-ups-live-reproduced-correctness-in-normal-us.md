---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7142 (head 9f3e78fdc)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7142 (reviewed head `9f3e78fdc5864db5767c8aba3872123aa3056548`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/rerun-failed-once.mjs:79` — (failing-input, degraded) Duplicate titles in passing files prevent unrelated failed files from being retried.
   - Scenario: A shard exits 1 because another test file fails transiently, while we:rerun-failed-once.test.mjs passes. Its four parameterized cases titled 'refuses invalid paths/statuses' produce identical fullName values. planRetry parses every file before filtering failures, so the duplicate-name check throws 'invalid or duplicate assertion evidence' and no retry launches. The unrelated failed file should receive its configured retry; duplicate titles in a passing file should not block it.
   - Class: live-reproduced (basis: Used the installed Vitest 1.6.1 JsonReporter to produce the repeated fullName values and confirmed production planRetry rejects that report. An injected rerunOnce probe with the same passing-file assertions plus one failed file returned 1 without invoking the retry runner.)
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
