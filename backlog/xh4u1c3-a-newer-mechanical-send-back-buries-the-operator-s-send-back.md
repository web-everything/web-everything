---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A newer mechanical send-back buries the operator's send-back

[held entry 341] (operator 2026-10-14 ~19:45 ET, held, HIGH) A newer mechanical send-back buries the operator's send-back. #5243: the operator sent back at 16:20 ET (clear-human capture regex); at 17:06 the parked-PR conflict watch added its own review:changes; the fixer at 17:35 fixed only the conflict and re-armed; the review accepted and the PR came back as NEEDS YOU with the operator fix never made. Fix idea: the fixer brief includes every unresolved operator send-back on the PR (not just the latest bounce); the review checks operator send-back items before accepting; the existing ruling-not-addressed detector (fired on #5293) also covers operator send-backs. Prove on #5243.

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
