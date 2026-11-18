---
bornAs: x2kxqkz
kind: story
size: 3
status: open
scope: ["we:scripts/", "we:.github/workflows/"]
dateOpened: "2026-10-29"
tags: []
---

# Break-glass on workflow files must pass actionlint first

#6064 was break-glass merged with an invalid runner context in job-level env, which broke every CI run (workflow file issue) until hotfix #6067. Break-glass skips CI, so nothing validated the workflow. Any merge path, including break-glass, that touches we:.github/workflows/ must run actionlint on the head and refuse on errors.

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
