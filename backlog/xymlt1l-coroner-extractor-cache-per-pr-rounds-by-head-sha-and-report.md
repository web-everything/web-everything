---
kind: task
status: open
scope: ["we:scripts/operations/coroner-extract.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Coroner extractor: cache per-PR rounds by head sha and report truncation

coroner 2026-10-20: a 3.5-day window took about 45 min on a busy host and undercounts silently (300 PRs read one by one, 150 of 314 compares skipped, Codex sessions capped at 600, CI runs truncated, 42 smoke sessions on fake PR 999998 counted as fix rounds). Cache per-PR rounds keyed by head sha, drop the 600 cap for the daily window or print truncation next to each number, filter smoke PR ids at the source.

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
