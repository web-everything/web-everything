---
bornAs: x42xzps
kind: task
status: open
scope: ["we:scripts/lib/red-team-check-run.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Move red-team check publication off the legacy web-everything GitHub App

The red-team check publication runs on the legacy 'web-everything' GitHub App (id 5037855, redTeamGate.appId). The operator wants off it. Grant checks:write to a Plateau app (Reviewer 5267537 is already used by the review daemon), set redTeamGate.appId through a repo PR, drop WE_GITHUB_APP_ROLE=legacy in the writer, then the operator reviews and retires the legacy app permission (2026-11-13).

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

Checked with capability-search and a backlog scan on 2026-11-14; no open card covers this exact change.
