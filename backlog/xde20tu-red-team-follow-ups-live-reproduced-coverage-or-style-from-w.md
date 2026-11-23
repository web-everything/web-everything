---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/check-timings-bot-only.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7387 (head 152983514)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7387 (reviewed head `152983514b80e36a04298a76e61a238268806c23`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/check-timings-bot-only.mjs:17` — (edge-case, degraded) Renames are counted twice toward the API's 3000-file limit.
   - Scenario: A PR renaming 1500 unrelated Markdown files produces 1500 API records, each emitting filename and previous_filename. The resulting 3000-element array makes the guard reject the PR, blocking required CI despite complete evidence and no timing-file change. Apply the cap to API records before expanding rename paths; this PR should pass.
   - Class: live-reproduced (basis: A read-only Node probe invoked the actual exported guard with the flattened paths from 1500 rename records. It returned ok:false with the 3000-file-cap message.)
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
