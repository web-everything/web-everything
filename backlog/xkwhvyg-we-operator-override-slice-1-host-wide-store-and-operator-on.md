---
kind: story
size: 5
parent: "xouq5b0"
status: open
scope: ["we:scripts/lib/operator-override-store.mjs", "we:scripts/operations/operator-override.mjs", "we:scripts/lib/__tests__/operator-override-store.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 1 - host-wide store and operator-only write CLI with audit log and expiry

Build the store of decision xouq5b0 (we:docs/agent/platform-decisions.md#operator-override-settings-layer): a host-wide path outside any lane clone, one readOperatorOverrides read interface, and an operator-only operator-override set operation that rejects agent callers, appends a change log and supports expiry.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/lib/__tests__/operator-override-store.test.mjs` fails before the module exists and passes after. Named tests, one per guarantee:
  - `set then readOperatorOverrides returns the value with source operator-db`
  - `the store path is host-wide and never inside a lane clone`
  - `an agent caller is rejected by the write operation and nothing is written`
  - `each write records instruction, actor, channel, time, reason and optional expiry`
  - `the change log is append-only and a write never edits earlier lines`
  - `an expired override is ignored on read and logged once; the log keeps it`
  - `a snapshot that fails to parse is skipped whole and logged`

## Non-goals

- [N1] Does not wire the layer into the cascade (slice 2), the guard floor (slice 3), the needs-you flag (slice 4) or any plateau DB work.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the verbatim instruction is stored as a quoted JSON string, never executed or interpolated.
2. **Truncated reads** — a snapshot or log line that fails to parse is skipped whole and logged, never half-applied.
3. **Shared state files** — the log is append-only under a lock; the snapshot is replaced atomically.
4. **Fail closed** — an unreadable store or an agent caller means no write and no applied override.
5. **Identity scoping** — actor and channel come from the command authority check, not from a flag.
6. **State over time** — expired entries are ignored on read and the log keeps them.
7. **Who wrote it** — every entry carries actor, channel, time, instruction and reason.
