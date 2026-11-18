---
bornAs: xzrjof6
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# (2026-11-01 19:52 ET) judge-sweep-facts ran from the primary checkout 1232 commits behind origin/main → most P

HIGH priority hint. - [ ] (2026-11-01 19:52 ET) judge-sweep-facts ran from the primary checkout 1232 commits behind origin/main → most PRs "evidence-unavailable"; sweep was a no-op. It should run in a fresh lane (or refuse when its checkout is stale) — HIGH, silently blinds every judge sweep.

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
