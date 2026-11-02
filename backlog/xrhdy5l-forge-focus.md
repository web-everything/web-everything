---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/verify-remote-routing.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# (Forge focus)

HIGH priority hint. - (2026-11-01 01:19 EST) HIGH (Forge focus): #6141 verify→Forge does NOT cover the verify DAEMON's selected-tests gate. Daemon builds 'npx vitest run --passWithNoTests --testTimeout=15000 --hookTimeout=30000 a placeholder-named file && VERIFY_SCAN_FILES=… npx vitest run --testTimeout=15000 --hookTimeout=30000' — compound '&&' + env-prefixed second run + those flags → wrappedVitestCommand (we:scripts/lib/verify-remote-routing.mjs) gives up → local slot. Evidence: job-verify-gate-1ca434ee @16e02f89 on snapshot bb459e8b, no remote-admission line. Fix: route each vitest segment of the compound gate (strip/translate the 3 flags as #6141 does for plain runs, carry VERIFY_SCAN_FILES env), or make the daemon emit a remote-compatible gate.

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
