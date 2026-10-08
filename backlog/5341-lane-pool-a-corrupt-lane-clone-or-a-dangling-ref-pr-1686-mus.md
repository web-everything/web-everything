---
bornAs: xj1vryw
kind: story
size: 5
status: active
scaffoldedBy: "lane-health"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-repair.mjs", "we:scripts/__tests__/lane-pool-repair.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# lane-pool: a corrupt lane clone or a dangling ref (pr-1686) must self-heal on acquire, not block ci-heal

Acquire/refresh fetch dies on refs pointing at missing objects (refs/heads/pr-1686) or a commit-graph naming an absent object; the lane is detected, repaired or quarantined and re-provisioned.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
