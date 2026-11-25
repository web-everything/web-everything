---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7458 (head c79b7733b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7458 (reviewed head `c79b7733b79f7b1ed153df0f1c5b842f84467711`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:803` — (edge-case, degraded) Trace-enabled Node warnings still hide the actual error
   - Scenario: Set NODE_OPTIONS=--trace-deprecation. Run a child that requires punycode, then writes 'TypeError: actual drain failure' on the next tick and exits 1. firstStderrErrorLine skips the warning header but selects its first stack frame, returning '[unclassified stderr; see local log]' instead of the TypeError. Warning stack frames should also be skipped so the real diagnostic remains visible.
   - Class: live-reproduced (basis: Reproduced on Node v22.1.0 with its actual punycode deprecation output, evaluated through the unchanged pure implementation extracted from the checked-out file. The production child runner forwards its environment, making NODE_OPTIONS applicable.)
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
