---
bornAs: xukt5wy
kind: task
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# reconcile-pass: 'could not read state' includes gh's stderr, not just the first error line

we:scripts/conveyor/reconcile-pass.mjs prints only the first line of a failed gh call's error ('Command failed: gh pr list ...'), dropping gh's stderr such as 'unexpected end of JSON input'. Live 2026-10-10 the wev-fix-daemon rebuild smoke rejected every build on this line with the cause hidden. Append the gh stderr (first non-empty line) to the message. Deferred from PR #4851 because that file is held by the takeover stack.

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
