---
kind: task
parent: "xw51scb"
status: open
scope: ["we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# Forge remote-exec: exact sibling byte accounting

Advisory: sibling byte totals are approximate; make them exact. Core: we:scripts/readiness/remote-exec.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/ -t "sibling byte" (new test comparing reported bytes with the sum of file sizes)`

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change what siblings are shipped.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text input.
2. **Truncated reads** — n/a: no new read path.
3. **Shared state files** — n/a: no new shared state file.
4. **Fail closed** — n/a: the change only tightens or tests existing behavior; any failure keeps falling back to the full scan.
5. **Identity scoping** — n/a: no identity logic touched.
6. **State over time** — n/a: no persisted state added.
7. **Who wrote it** — n/a: no authorship signal touched.
