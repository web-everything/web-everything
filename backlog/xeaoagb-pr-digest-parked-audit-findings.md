---
kind: story
size: 3
status: open
scope: ["scripts/operations/pr-digest*.mjs", "scripts/operations/__tests__/pr-digest*.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# pr-digest is parked: branches kept, three open audit findings

Operator ruling R62 (2026-10-24 ~14:07 ET, chalbert, "Ok"): pr-digest is PARKED. Branches kept: lane/grad-pr-digest-1a and lane/grad-pr-digest-2c. Open audit findings: (1) a reviewer not-real ruling overrides an operator block; (2) WE_FIX_LOOP_LEDGER is ignored; (3) the --all budget counts PRs, not pages. Resume from the kept branches; fix the three findings before any port.

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
