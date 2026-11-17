---
bornAs: xbjzlug
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/settings/gh-throttle.json"]
dateOpened: "2026-11-16"
tags: []
---

# gh-throttle concurrency cap as a tool-layer setting

All gh calls share 6 slots (DEFAULT_GH_CONCURRENCY_CAP); slot waits reach 39-89 s while calls take 0.9 s. Make the cap resolve default 6 -> we:scripts/settings/gh-throttle.json -> env WE_GH_THROTTLE_CAP, validated positive integer <= 50; tool file sets 12.

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
