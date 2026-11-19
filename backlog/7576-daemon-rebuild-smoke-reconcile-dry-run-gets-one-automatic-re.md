---
bornAs: xc9k065
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild"]
dateOpened: "2026-10-31"
tags: []
---

# Daemon rebuild smoke reconcile-dry-run gets one automatic retry and keeps its full stderr

Live 2026-10-31 14:42 ET: the rebuild smoke step reconcile-dry-run (120s budget) fails transiently under load / gh throttle (exit 1, truncated stderr) and HOLDS the clone (health-watch 538b3484 smoke-rejected 18:39Z, slice 2 candidate). By hand it passes in 81s (candidate) / 61s (HEAD). Add one automatic retry of that step and capture the full stderr; consider running the smoke on Forge. Related: #5810, #5539 (transient GitHub errors blamed on overlays), #6135 (smoke gh budget).

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
