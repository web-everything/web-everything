---
bornAs: x49qt1p
kind: story
size: 2
status: open
scope: ["we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Remote-verify-host-only red tests: legacy-settings hand-back grant test and 3 keepalive signal tests

we:scripts/verify-lane.mjs (2026-11-15 01:20 ET, MED): the legacy-settings hand-back grant test and 3 keepalive signal tests are red only on the remote verify host and green on GitHub CI (stood down the #6832 fixer). Find why they fail only on the remote verify host. Prove on the live case with before/after evidence, not only unit tests.

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
