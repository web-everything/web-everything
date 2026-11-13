---
bornAs: xxucf4c
kind: story
size: 2
status: open
scope: ["we:scripts/forge-remote-health.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Forge soak: git-head-unavailable keeps runs local (push or bundle head first)

R909 (2026-11-12 19:46 ET). Forge rejects with git-head-unavailable when it cannot resolve the lane head (seen lane-88, lane-46, lane-67; about 5 in a day). Likely the head commit is not yet on origin. Push or bundle the head before remote soak, or retry once after fetch. Code: we:scripts/forge-remote-health.mjs

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
