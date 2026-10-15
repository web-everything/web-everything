---
kind: story
size: 3
status: active
scaffoldedBy: "fix-5356"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/check-standards.mjs", "we:scripts/lib/operator-send-backs.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# check:standards rule: every fail-closed hold needs a test-covered release path

PR #5356 review: the operator send-back hold parsed head=null from the canonical review-set-label render, and no test exercised its release, so the hold deadlocked PRs. Add a check:standards rule (or a test convention) that any fail-closed hold reader (hold reasons, verdict reductions, not-addressed detectors) has a test that builds the hold through the real producer render path and asserts the documented release path clears it.

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
