---
bornAs: xchovdf
kind: story
size: 3
status: active
scaffoldedBy: "unstick-4361"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/conveyor/load-flake-hold.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Load-flake reverify push must re-arm the bounced PR for review

Live PR #4361: fix-4361 hit a load-flake hold, released its claim at the old head, then the reverify pass pushed the held fix (a5938d89) without re-arming review:changes. The PR stayed bounced at a fixed head; review daemon logged 'owed a fix, not a review' every tick and no fixer picked it up. Fix: the reverify pass re-arms after its push and catches up any pushed-but-unrearmed PR; reconcile refuses a fixer on that shape (rearm-owed) instead of claiming a fix is owed.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
