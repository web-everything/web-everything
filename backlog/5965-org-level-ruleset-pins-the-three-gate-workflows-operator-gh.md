---
bornAs: xtu0yr2
kind: story
size: 1
status: open
scope: ["we:.github/workflows/ci.yml", "we:.github/workflows/merge-gate.yml", "we:.github/workflows/soak-replay-gate.yml"]
dateOpened: "2026-10-12"
tags: []
---

# Org-level ruleset pins the three gate workflows (operator gh admin:org)

Held finding 253 (2026-10-12). The repo ruleset refused the workflows rule (422). Create an org-level ruleset (plan=enterprise) targeting web-everything/web-everything that pins we:.github/workflows/ci.yml, we:.github/workflows/merge-gate.yml and we:.github/workflows/soak-replay-gate.yml at refs/heads/main, and record it in the runbook. Needs the operator gh admin:org scope, so it is an operator action, not a build. Related: #5918. Not queued.

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
