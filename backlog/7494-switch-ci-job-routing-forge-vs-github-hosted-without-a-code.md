---
bornAs: xjp6t9m
kind: story
size: 5
status: open
scope: ["we:.github/workflows/", "we:scripts/operations/"]
dateOpened: "2026-10-29"
tags: []
---

# Switch CI job routing (Forge vs GitHub-hosted) without a code deploy

Operator 2026-10-29 16:29 ET: expose a switch so merge-queue and push CI routing can change without a PR. Proposal: runs-on reads a repo variable per job group (unit shards, integration, merge queue) with GitHub-hosted fallback, flipped by a policy-cascade-backed CLI with an audit log; doubles as the rollback for the placement gate.

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
