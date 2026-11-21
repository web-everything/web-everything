---
bornAs: xw7yt6b
kind: task
status: open
dateOpened: "2026-11-20"
tags: []
---

# ruling-cli direct-entry guard: fail closed on realpath errors and assert exact refusal text

Follow-up to lane/ruling-cli-loud (#7241, waived R1085):

1. the direct-entry-guard module (on the lane/ruling-cli-loud branch, not yet on main): make realpath errors fail closed (refuse, name the error) instead of treating the entry as "not direct".
2. the ruling-cli-loud test (same branch): assert the exact op name and the exact "use <cmd>" text for both entry points.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- node --test` on the ruling-cli-loud test passes with new cases that fail on main: an entry whose realpath throws is refused with the error named, and both entry points assert the exact op name and exact "use <cmd>" refusal text.

## Non-goals

- [N1] Does not change which entries count as direct; only the error path and the test assertions.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Entry paths are data; the error text printed is bounded.
2. **Truncated reads** — n/a: no file contents are read.
3. **Shared state files** — n/a: no state files.
4. **Fail closed** — A realpath error refuses and names the error; it never means "not direct".
5. **Identity scoping** — n/a: no identity decision.
6. **State over time** — n/a: stateless check.
7. **Who wrote it** — n/a: no authorship decision.
