---
bornAs: xj2x95y
kind: story
size: 2
status: open
scope: ["we:scripts/lib/host-load.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Host memory check under-counts free memory on macOS

MED priority hint. ## (held 2026-10-27 13:03 ET) Host memory check under-counts free memory on macOS `we:scripts/lib/host-load.mjs:25-33` counts headroom as free + speculative + purgeable pages + free swap, and never counts inactive pages. At 12:33 ET it read 1.2 GB and held 8+ reviews, while macOS reported pressure level 1 (normal), "memory free 62%" and about 20 GB free+inactive. Fix: admit on the macOS memory pressure level (kern.memorystatus_vm_pressure_level: 1=normal admit, 2=warn hold heavy, 4=critical hold all), or count inactive pages. Keep free-MB only as a fallback off macOS. Prove it: the same host state admits the review.

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
