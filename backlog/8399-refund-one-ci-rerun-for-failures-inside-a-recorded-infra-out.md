---
bornAs: xjgjymn
kind: story
size: 3
status: active
scaffoldedBy: "cards-batch-21"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-11-16"
tags: []
related: ["7763"]
---

# Refund one CI rerun for failures inside a recorded infra-outage window

CI on the self-hosted runners shares the Forge box (ci-runner-1). Failures while Forge was full (2026-11-11 to 2026-11-15 19:05 ET) consumed PR rerun budgets (e.g. #6874 run 43770906069 attempt 2, shard 9: 'workflow self-check failed, fail closed: unavailable'). Refund one rerun for CI failures inside a recorded infra-outage window, and let ci-red-recovery-watch classify them as infra, not own-failure.

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

adjacent: infra retry budget spent on infra-red CI
