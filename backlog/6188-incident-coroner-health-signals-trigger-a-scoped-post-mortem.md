---
bornAs: xhwmyig
kind: epic
status: open
scope: ["we:scripts/conveyor/incident-coroner-job.mjs", "we:scripts/operations/incident-*.mjs", "we:scripts/settings/incident-coroner.json", "we:scripts/conveyor/health-smells/"]
dateOpened: "2026-10-17"
tags: []
---

# Incident coroner: health signals trigger a scoped post-mortem, triaged by impact into P0 fix, later card or operator pick

The coroner runs only nightly and by hand. Health-watch already opens one episode per problem but nothing turns an episode into a card. Add a job that, per episode, extracts scoped evidence, picks a cause by rule (optionally Haiku or Codex), and acts by impact: urgent P0 card, later normal card or nightly batch, or a needs-you entry with a pick. Guarded by daily P0 budget, never-weaken-a-gate, quiet hours, an audit ledger, shadow mode first.

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
