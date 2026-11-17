---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs"]
dateOpened: "2026-11-17"
tags: []
---

# we:open-pr-audit-gate.test.mjs:17 COVERAGE: No supplied behavioral test exercises either entry point with its default canoni (web-everything#7011)

1. `we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs:17` — COVERAGE: No supplied behavioral test exercises either entry point with its default canonical audit checker.

Operator card follow-up for web-everything/web-everything#7011 (head a67a19a6193912d421fe82bc6e6776b10685529f).

Not worse than main (R903): main has no open-pr audit gate (R995); default wiring verified on head at we:open-pr-io.mjs:142, we:pr-land.mjs:100 and we:pr-land.mjs:932

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
