---
bornAs: x98ea4l
kind: task
status: open
scope: ["we:scripts/codex-direct-task.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# codex-direct-task ends with the full gate for code PRs

coroner 2026-10-16: Codex-direct builds finish with gate none, so ci-heal rounds follow - 17 of 55 fix rounds (31%) and 3 verify-red rounds were old defaults pinned in tests, maxBuffer and hermetic-fixture misses that only fail in the full suite (#5441, #5444, #5449, #5425, #5439, #5453). Default to the full gate (verify-lane plus test:unit) for code PRs with a card-only exception. Prove ci-heal rounds per code PR drop from about 0.8 to near 0.

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
