---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/audit-verdict.mjs", "we:scripts/operations/__tests__/audit-verdict.test.mjs"]
dateOpened: "2026-11-08"
tags: []
---

# audit-verdict: path hardening (U+0600 bypass, unknown-key and trailing-slash globs)

Slice 3 of PR #6381 (R763, follow-up of PR #6381). Audit path hardening: the U+0600 path bypass (we:scripts/operations/audit-verdict.mjs:162 strips only Default_Ignorable_Code_Point), plus unknown-key and trailing-slash glob handling.

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
