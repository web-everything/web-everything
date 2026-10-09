---
kind: story
size: 2
parent: "5445"
status: open
blockedBy: ["xdt06rk", "xedhm8w", "xmeeqj3"]
scope: ["we:scripts/verdict-ledger-conformance.mjs", "we:scripts/__tests__/verdict-ledger-conformance.test.mjs", "we:package.json"]
dateOpened: "2026-10-09"
tags: []
---

# Ledger standard: one conformance runner over schema, derive and store vectors

Slice of #5445 (A1). One command runs the event-schema, derive-rule and store-contract vector sets against the open-core implementation (home and git store adapters, derivePrState) and prints a pass/fail per set. Done when the runner passes on main and fails on a deliberately broken adapter and on a deliberately broken derive rule.

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
