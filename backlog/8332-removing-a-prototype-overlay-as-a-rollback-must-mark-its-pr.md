---
bornAs: x2onz2f
kind: story
size: 3
status: open
scope: ["we:scripts/operations/prototype-load.mjs"]
dateOpened: "2026-11-15"
tags: []
related: ["6518"]
---

# Removing a prototype overlay as a rollback must mark its PR and stacked PRs held/unlandable with the rollback reason

we:scripts/operations/prototype-load.mjs (2026-11-15 05:52 ET, HIGH): #6871 (part of the rolled-back B16 stack, carrying the rerun code) reached ready-to-merge, review:accepted and red-team:clear 37 min after its overlay was removed; only the monitor caught it. Rollback of an overlay must hold its PR and any stacked PRs automatically, with the reason. Prove on the live case with before/after evidence, not only unit tests.

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

## Duplicate admission

adjacent but distinct

different failure/behaviour
