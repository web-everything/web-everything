---
bornAs: xvm9yss
kind: task
status: open
scope: ["we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Forge bundle scan should not flag commit messages that only name the private-key rule

The Forge bundle scan flags commit MESSAGES as private-key when they only name the rule (PR #6748 fixer commits 'fix - private-key label ...', lane-79, FULL run), so the run falls back to the Mac. No key material is present. Match key material only (armour lines, key bodies), not the bare words. Must refuse on any real armour line or key body; file-content scanning stays unchanged. Red-first tests: a message naming the rule, and one with a real armour header.

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

Checked with capability-search and a backlog scan on 2026-11-14; no open card covers this exact change.
