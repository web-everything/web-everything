---
bornAs: xe90f4w
kind: task
status: active
scaffoldedBy: "fix-6535"
dateScaffolded: "2026-11-08"
scope: ["we:scripts/lib/red-team-check-run.mjs"]
dateOpened: "2026-11-08"
tags: []
related: ["6535"]
---

# redTeamGate.source can differ between the drain host and GitHub CI

redTeamGate.source can differ between the drain host and GitHub CI. Context from the finding: PR 6535 self-review: the drain resolves redTeamGate.source from its env and host-local platform preference, while merge-gate in CI reads vars.WE_RED_TEAM_GATE_SOURCE plus the settings file. A drain-only drain-scan rollback skips publish-first while CI still trusts the check run, so an older success can pass. Make the mode one shared source of truth, or have merge-gate refuse when the two disagree.

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

## Duplicate admission

PR 6535 self-review: the drain resolves redTeamGate.source from its env and host-local platform preference, while merge-gate in CI reads vars.WE_RED_TEAM_GATE_SOURCE plus the settings file. A drain-only drain-scan rollback skips publish-first while CI still trusts the check run, so an older success can pass. Make the mode one shared source of truth, or have merge-gate refuse when the two disagree
