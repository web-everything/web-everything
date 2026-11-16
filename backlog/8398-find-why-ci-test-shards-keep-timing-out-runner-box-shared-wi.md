---
bornAs: x308l9q
kind: story
size: 3
status: active
scaffoldedBy: "cards-batch-21"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-16"
tags: []
related: ["4171"]
---

# Find why CI test shards keep timing out (runner box shared with Forge)

Test-shard TIMEOUTS across 4+ PRs end in the fix-daemon refusing the timeout retry ('timeout-retry-ineligible: timeout-evidence incomplete-failure-inventory'), so they fall through to ci-heal. Note: we:scripts/conveyor/reconcile-core.mjs:3394-3412 already gives an incomplete-inventory timeout ONE stale rerun (staleCiRerun, once per head, main green), so the eligibility rule exists. The real open question is WHY shards time out: the CI runner box is shared with Forge. Measure shard durations against limits.

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

CI job timeouts and rerun recovery
