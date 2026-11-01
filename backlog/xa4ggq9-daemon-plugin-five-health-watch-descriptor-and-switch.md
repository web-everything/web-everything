---
kind: story
size: 3
parent: "7504"
status: open
blockedBy: ["7504"]
scope: ["we:scripts/lib/daemon-plugins.mjs", "we:scripts/settings/daemon-plugins.json", "we:skills-src/conveyor/pass-daemon.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Daemon plugin five: health-watch descriptor and switch

Child of 7504 (R357). health-watch clone has 4 overlays today (top 1101c, smoke-gh-throttle, 2 loader-fast-return); descriptor and switch only after they graduate or land.

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
