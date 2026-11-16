---
kind: story
size: 2
status: open
dateOpened: "2026-11-16"
tags: []
related: ["daemon-host-guard"]
---

# Daemon host guard reinforce: cache invalidation on failed write, preflight clone-discovery completeness

Reinforce the host guard after R825 residuals: (1) a failed cache write after a successful fresh read naming another host leaves old cache naming this host, so a later failed remote read could reactivate it; fix by tombstone or fail closed on write failure. (2) preflight clone discovery relies on daemonCloneRoots which silently skips unreadable dirs and corrupt overlay records; add a strict discovery mode that reports skips.

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

residual of host-guard PR

new residual cards from codex audit of host guard PR
