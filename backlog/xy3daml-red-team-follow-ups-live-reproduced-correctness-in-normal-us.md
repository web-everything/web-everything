---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7142 (head 2bb6f6e14)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7142 (reviewed head `2bb6f6e14096f00c16d3cf66693e608c9382b37f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/rerun-failed-once.mjs:65` — (failing-input, degraded) Duplicate titles in passing files block unrelated failed-file retries
   - Scenario: Supply a first-run report containing one failed file and an unrelated passing file with repeated assertion fullName values. Existing parameterized tests in we:scripts/operations/__tests__/agy-usage-reader.test.mjs:61 generate such repeated titles. parseReport rejects the passing file before planRetry filters failed files, so rerunOnce exits 1 without attempting recovery. The unrelated passing file should not prevent retrying the failed file.
   - Class: live-reproduced (basis: Called the actual rerunOnce function with injected in-memory report I/O. With the unrelated passing file present, it returned 1, made zero retry calls, and reported invalid or duplicate assertion evidence. Removing that passing file produced one retry and exit 0. This reproduces the orchestration failure without running full CI.)
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
