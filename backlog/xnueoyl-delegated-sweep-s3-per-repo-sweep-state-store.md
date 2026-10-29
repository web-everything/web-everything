---
kind: story
size: 5
status: open
blockedBy: ["x660rls"]
scope: ["we:scripts/conveyor/delegated-clearance-sweep.mjs", "we:scripts/lib/atomic-json-file.mjs"]
dateOpened: "2026-10-29"
tags: []
---

# Delegated sweep S3: per-repo sweep state store

Per-repo state file, updateState(fn) under withFileLock with a re-read (atomic-json-file), set-if-absent claimed before runLabel, void keyed by ruling, pruning. Authority stays in the verdict ledger. Owns invariants I6 per-PR isolation, I7 write-once baselines, I4 expiry admitted once at the commit point. Blocked by S2.

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
