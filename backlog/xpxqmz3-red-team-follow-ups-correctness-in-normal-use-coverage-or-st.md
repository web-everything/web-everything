---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/fetch-main-history.sh"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7605 (head 4b4459d06)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7605 (reviewed head `4b4459d069ce62ddab033c42c6d6a71d81bf0680`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `scripts/ci/fetch-main-history.sh:47` — (failing-input, degraded) A trailing slash in the cache directory makes saving fail
   - Scenario: Given an existing valid mirror at /cache/main-history, run MAIN_HISTORY_CACHE_DIR=/cache/main-history/ sh scripts/ci/fetch-main-history.sh save. The staging directory becomes /cache/main-history/.tmp.d and the backup becomes /cache/main-history/.old. Publication attempts to move the mirror into its own subdirectory, which fails and exits with status 1. Equivalent directory paths with and without a trailing slash should both save successfully.
   - Class: correctness-in-normal-use (basis: A read-only path-resolution probe confirmed that the trailing slash places both derived paths inside the mirror. Moving a directory into its own descendant is invalid. The full save was not executed because this review prohibits filesystem writes.)
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
