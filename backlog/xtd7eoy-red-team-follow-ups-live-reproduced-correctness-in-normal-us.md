---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/rerun-failed-once.mjs", "we:.github/workflows/ci.yml"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7142 (head 1a233bfe7)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7142 (reviewed head `1a233bfe783fff54e3ead9270c1fe6cd54732424`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/rerun-failed-once.mjs:65` — (failing-input, degraded) Valid duplicate test titles prevent unrelated failed files from being retried
   - Scenario: A first-run report contains a passing parameterized file with duplicate fullName values and another file with one failed assertion. parseReport rejects the passing file before filtering failed files, so rerunOnce exits 1 without retrying. The new we:rerun-failed-once.test.mjs itself generates four identical titles through it.each at line 41. Valid repeated titles in passing files should not prevent retrying another failed file.
   - Class: live-reproduced (basis: An in-memory rerunOnce probe using this report shape returned exit 1, logged 'invalid or duplicate assertion evidence', and invoked the retry runner zero times. No actual Vitest execution was available because dependencies are absent.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:.github/workflows/ci.yml:214` — (failing-input, degraded) The claimed increase to 24 covered shards is absent
   - Scenario: Trigger a full CI run using the checked-out workflow. Its matrix contains only shards 1 through 10; shard 10 is the no-coverage group, covered assignments use /9, and coverage merge still requires --expect=9. Consequently, this PR does not deliver its claimed 24 covered shards plus shard 25 or the associated concurrency increase.
   - Class: correctness-in-normal-use (basis: Read-only workflow inspection and a Node extraction confirmed ten matrix entries, nine covered shards, and merge expectation nine. No CI timing improvement is inferred or claimed.)
   - Also class: coverage-or-style
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
