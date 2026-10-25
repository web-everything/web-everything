---
kind: task
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Stale and content-landed overlay registrations on daemon clones are auto-ported or retired

2026-10-24: the drain clone has a stale registration (drain-top-1022c) blocking loads, same class as review 1023c; the merge daemon (HEAD 9a2bf43528) runs OLD code through its only overlay lane/proto-daemon-resources, where redTeamPanelSeatOwed treats a red-team result as always owed so a skipped card-only PR holds forever (19:42 ET). Handle like 1023c: auto-rebase or port (R55-style), or retire when content landed.

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
