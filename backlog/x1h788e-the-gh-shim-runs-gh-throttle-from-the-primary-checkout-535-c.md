---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The gh shim runs gh-throttle from the primary checkout, 535 commits behind main

[held entry 342] (worker finding 2026-10-14 ~19:50 ET, held, HIGH) The gh shim runs gh-throttle from the primary checkout, 535 commits behind main. Every shim gh call uses stale throttle code: no slot-holder record, no hold timeout (#5326), no per-caller cap. 4-5 of 6 slots in the caught stall were held by such stale callers. Fix idea: the shim resolves gh-throttle by NAME from an auto-updated location (the daemon self-sync state or a dedicated tools clone that follows main), never the primary checkout; log the resolved version. Prove: the shim reports the current main sha and the stall holders are named. WITHDRAWN 2026-10-14 ~19:40 ET: premise wrong. The live shim (gh-shim.d/fd5c03c434fc6486) already runs gh-throttle from the auto-synced wev-control clone; most holders import gh-throttle in-process from daemon clones. Real fix = land #5326 (holder names, hold timeout, per-caller cap). Follow-up idea: stamp calls.jsonl lines and slot locks with the throttle sha.

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
