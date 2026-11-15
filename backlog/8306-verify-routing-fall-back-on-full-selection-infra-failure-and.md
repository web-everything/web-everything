---
bornAs: x0v7yqs
kind: story
size: 3
status: open
scope: ["we:scripts/operations/verify-io.mjs", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# verify routing: fall back on full-selection infra-failure, and send --gate and standards through Forge/heavy-admission

Full-selection verify fails as infra (remote-termination-unconfirmed exit 124, selection-truncated) repeatedly (4 workers on 11-14) while explicit --gate with named files succeeds: fall back to a named-file local gate instead of settling infrastructure-failure. Also verify --gate runs the explicit gate as a raw local command (heavy-local raw-command 67 min per 12h): route it through heavy-admission or Forge. And incomplete-standards-inputs keeps check:standards local (32 runs, 35 min per 12h): find which input is missing on Forge.

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
