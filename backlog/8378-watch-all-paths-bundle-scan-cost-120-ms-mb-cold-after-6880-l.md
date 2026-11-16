---
bornAs: xdtj7zg
kind: story
size: 1
status: open
scope: ["we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Watch: all-paths bundle scan cost (~120 ms/MB cold) after #6880 lands

2026-11-15 09:20 ET WATCH: the #6880 all-paths scan costs about 120 ms/MB cold (17 s quiet, 39 s loaded on a 142 MB tree; warm-base reuse skips it). After merge, compare Forge bundle times in the heavy-local report; if bundling time hurts the Forge share, cache scan results per blob sha.

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
