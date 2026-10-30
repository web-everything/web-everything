---
bornAs: x7sqjon
kind: story
size: 5
status: open
scope: ["we:scripts/lib/import-closure.mjs", "we:scripts/lib/daemon-rebuild/skip-unrelated.mjs", "we:scripts/lib/daemon-rebuild/closure-scope.mjs"]
dateOpened: "2026-10-29"
tags: []
---

# Spawned-script precision in the fail-closed closure scan

we:scripts/lib/daemon-rebuild/skip-unrelated.mjs now protects any file named by a spawn/fork/exec/Worker argument, test scripts included, plus opaque launches (R210 fail-closed, PR 6023). Follow-up: resolve spawned targets precisely so fewer files are over-protected, without ever protecting less.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/closure-scope.test.mjs` gains a precision test that fails before and passes after, while every R210 protection test stays green.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not relax R210: unknown still means protected; only proven-resolvable targets may become droppable.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: precision work on the same scan; unknown references stay protected (fail closed).
2. **Truncated reads** — n/a: precision work on the same scan; unknown references stay protected (fail closed).
3. **Shared state files** — n/a: precision work on the same scan; unknown references stay protected (fail closed).
4. **Fail closed** — n/a: precision work on the same scan; unknown references stay protected (fail closed).
5. **Identity scoping** — n/a: precision work on the same scan; unknown references stay protected (fail closed).
6. **State over time** — n/a: precision work on the same scan; unknown references stay protected (fail closed).
7. **Who wrote it** — n/a: precision work on the same scan; unknown references stay protected (fail closed).
