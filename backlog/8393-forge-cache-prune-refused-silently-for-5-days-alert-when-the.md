---
bornAs: xp794fc
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/forge-cache-prune.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Forge cache prune refused silently for 5 days: alert when the prune refuses N runs in a row or Forge / passes high-water

The Forge cache prune refused on every run from 2026-11-11 to 2026-11-15 (469 refusals) because a .running record lacked a lock, and nobody was told; / hit 100% and every remote run failed. Add an alert when we:scripts/readiness/forge-cache-prune.mjs refuses N runs in a row, or when Forge root passes a high-water mark (the R811 S1 forge-disk-low smell). Found while fixing the prune in lane/forge-prune-unstick.

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
