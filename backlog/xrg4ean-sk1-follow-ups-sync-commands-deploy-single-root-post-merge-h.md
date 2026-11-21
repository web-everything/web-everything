---
kind: task
status: open
scope: ["we:scripts/sync-commands-deploy.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# SK1 follow-ups: sync-commands-deploy single root, post-merge hook skill watch, plateau-settings fixture test

SK1 items: we:scripts/sync-commands-deploy.mjs is single-root (no --root); the post-merge hook watches only WE skills-src, so plateau-ops skill edits do not trigger a sync; fixture-test the plateau-settings tier-screen and allowlist. Source: build-queue 00:50 ET 2026-11-21.

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

nd
