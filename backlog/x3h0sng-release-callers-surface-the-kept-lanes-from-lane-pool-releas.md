---
kind: story
size: 2
status: active
scaffoldedBy: "fix-6319"
dateScaffolded: "2026-11-04"
scope: ["we:scripts/lane-drain.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/conveyor/build-dispatch-orphan-adopt.mjs"]
dateOpened: "2026-11-04"
tags: []
---

# Release callers surface the kept lanes from lane-pool release --json

lane-pool release now keeps a lane with unpushed work, exits 1, lists it under kept in --json and journals a loud release-refused line (PR #6319). Its callers still ignore that: lane-drain releaseItemLeases reads only released, dispatch-lane-io releaseReservedLane and build-dispatch-orphan-adopt releaseReservedLaneLease discard stdout. Make each caller report kept lanes in its own output (drain land event, dispatch result) and add a caller test against a lane holding an unpushed or squash-merged branch, asserting the refusal is surfaced rather than swallowed. From the PR #6319 round-3 review (finding at we:scripts/lane-pool.mjs:2828).

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
