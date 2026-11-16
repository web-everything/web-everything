---
bornAs: xnzleyt
kind: story
size: 2
status: open
scope: ["we:scripts/worker-brief.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# worker-brief should flag daemon-soak scope: a bug fix there needs a soak break from the start

2026-11-15 14:34 ET MED: the open-pr soak-declaration refusal hit 3 PRs today late in the cycle (#6877, #6897 probe, carry-over-jit-number), causing extra verify rounds. worker-brief should detect daemon-soak scope in --files and add 'a bug fix here needs a soak break (module, its soak test and the index) from the start' to the brief; free-scope could flag it too.

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
