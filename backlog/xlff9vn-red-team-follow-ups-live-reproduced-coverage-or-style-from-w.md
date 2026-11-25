---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7458 (head 87e343edd)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7458 (reviewed head `87e343eddead170d3ee60b411ca7ff25b3d7c902`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:803` — (edge-case, degraded) Warning stack traces still hide the actual error
   - Scenario: Run Node with --trace-warnings, emit a DeprecationWarning, then write 'TypeError: actual failure' to stderr. The extractor skips the warning header but selects its first 'at ...' stack frame, returning '[unclassified stderr; see local log]' without reaching the TypeError. It should skip the warning's stack trace and return the actual error. Multiline warning messages cause the same failure through their continuation lines.
   - Class: live-reproduced (basis: Generated real Node stderr for both --trace-warnings and a multiline process.emitWarning message, then evaluated the checked-out extractor against each. Both returned the unclassified marker despite a following TypeError line.)
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
