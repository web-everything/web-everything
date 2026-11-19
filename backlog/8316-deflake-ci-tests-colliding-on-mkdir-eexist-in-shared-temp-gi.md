---
bornAs: xk7am23
kind: story
size: 3
status: open
scope: ["we:scripts/lib/__tests__/delivery-policy.test.mjs", "we:scripts/conveyor/__tests__/hung-session.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Deflake: CI tests colliding on mkdir EEXIST in shared temp (git-bundle, delivery-policy, hung-session)

we:forge-offload.test.mjs and we:git-bundle-transport.test.mjs collide on mkdir EEXIST under /tmp/we-vitest-1001/<pid>/gbt-*/snapshot in CI shard 7 (#6841 run 43651099980); we:delivery-policy.test.mjs (policy journal, shard 5) and we:hung-session.test.mjs (EEXIST mkdir, shard 1) flaked on the #6853 run. Use a unique mkdtemp per test.

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
