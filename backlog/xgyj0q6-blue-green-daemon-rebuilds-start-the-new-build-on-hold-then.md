---
kind: story
size: 8
status: open
scope: ["we:scripts/lib/daemon-rebuild.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-load-overlay.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Blue-green daemon rebuilds: start the new build on hold, then switch quickly

A rebuild starts the new build alongside the old one in a hold mode: it boots, runs the smoke, and reads state, but takes no dispatches and writes nothing shared. When the smoke passes and a cascade setting rebuild.blueGreen.switchWhen is met (idle between passes, or immediately), the switch is atomic and the old build stops. One-command rollback means switching back to the still-warm old build. Today, adoption waits 5-22 min for an idle moment and a failed smoke leaves the clone held on last-good. Settings, each with its source logged: rebuild.blueGreen.enabled, holdMaxMin, switchWhen. Prototypes start in hold mode the same way. It never weakens the smoke or the guards. Evidence: 2026-10-18 daemon-rebuild adoption gaps of 5-22 min, and a 22:10Z smoke-rejected / clone-held-stale on the drain. Scope: the daemon-rebuild code (we:scripts/lib/daemon-rebuild.mjs and we:scripts/lib/daemon-rebuild/), we:scripts/lib/daemon-load-overlay.mjs, and the daemon supervisors. Parent: the parked delivery-modes epic (xc4ft34) is not on main yet, so it is not linked as --parent.

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
