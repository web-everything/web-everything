---
bornAs: xkg4dvb
kind: story
size: 3
status: active
scaffoldedBy: "fix-6595"
dateScaffolded: "2026-11-10"
scope: ["we:scripts/lib/drain-verdict.mjs", "we:scripts/lib/merge-gate-inventory.mjs"]
dateOpened: "2026-11-10"
tags: []
related: ["6595"]
---

# drain-verdict marks live-only drain holds (branch preparation, queue admission) as local-only unknown

A drain dry-run never runs branch preparation or queue admission (batching-deferred, merge-lock), so an enqueue verdict cannot have checked them. The verdict localOnly block does not name them. Add them to LOCAL_ONLY or the gate inventory so a consumer knows the local drain must re-check them.

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

found by the PR 6595 fix self-review
