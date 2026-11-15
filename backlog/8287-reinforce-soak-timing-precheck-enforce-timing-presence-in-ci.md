---
bornAs: xaqm796
kind: story
size: 3
status: open
scope: ["we:scripts/lib/soak-precheck-at-open.mjs", "we:scripts/lib/soak-replay-gate.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Reinforce soak timing precheck: enforce timing presence in CI from the published commit

Residuals from the audit of the soak timing precheck in we:scripts/lib/soak-precheck-at-open.mjs: the opt-out and the CI replay gate do not require timings; timings are read from the working tree, not the published commit; the existing-PR exemption in we:scripts/pr-land.mjs skips later pushes. Enforce timing presence in CI (soak-replay-gate) from the published commit.

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
