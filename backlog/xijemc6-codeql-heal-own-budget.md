---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-heal-mark.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# CodeQL-held PR is charged only CodeQL heals, not the shared ci-heal cap

LIVE PR #4453 (2026-10-09): 2 red-ci heals + 1 CodeQL heal spent the shared 3-heal cap, so a NEW CodeQL alert (Bad HTML filtering regexp at we:scripts/conveyor/prep-review.mjs:127) was refused cap-exhausted though no heal was ever briefed with it. Not an App-permission gap: alerts already reach the brief via CodeQL check-run annotations (x8cnbii); the direct code-scanning alerts API would need App repo permission 'Code scanning alerts: Read' (security_events:read), operator decision. Fix: per-reason count for the CodeQL branch + setting WE_CI_HEAL_CODEQL_OWN_BUDGET (default on) + #4453 fixture.

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
