---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The drain makes other PRs yield to a PR that only a person can land

[held entry 349] (coroner 2026-10-14, held, HIGH) The drain makes other PRs yield to a PR that only a person can land. 148 overlap-yield deferrals; 119 were on #5187 (a workflow-file PR: ready-to-merge, accepted, MERGEABLE, but human-land-only) from 10-14 21:04 ET to 10-15 05:58 ET. #5356 yielded 42 times, #5354 21 times, #5355 16 times. In total, 533 fast drains (1,536 min) produced 70 verified enqueues. Fix idea: overlap-yield skips a culprit the drain cannot land (human-only surface, review:human, stood-down, at-round-limit) and lands the others first. The yield reason names it as "held for a person", and the operator queue shows it under "needs your merge" (card 334). Evidence: plateau-app/.drain-daemon/daemon.log "deferred: waits on overlap-yield:#5187". Scope: we:scripts/merge-ai-prs.mjs overlap context, drain-concurrency. Size 2.

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
