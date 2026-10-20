---
bornAs: xgyj0q6
kind: story
size: 8
status: open
deliveryMode: prototype
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

## Emergency fast start

- An operator-only mode (`rebuild.emergencyFastStart`, requires --by and --reason, both logged) starts the new build at once after a minimal check (entries-boot, tree-clean, one gh call).
- The full smoke runs right after on the new build. The old build stays warm on hold, and on any full-smoke failure it switches back automatically.
- It never skips the PR or prototype guard audit; it only shortens time-to-start.
- It is never the default, and it is never usable by an agent without an operator instruction.

## Design notes (operator 2026-10-19)

- **Order:** first the review daemon, then the drain.
- **Four pieces:**
  1. Two clones plus an indirection: launchd points at a switchable symlink. That is one plist change per daemon, which needs the operator's OK.
  2. Rebuild and smoke into the inactive clone, using `we:scripts/lib/daemon-rebuild.mjs` with `--clone`.
  3. A pause flag checked between ticks, plus a switch command: pause, wait idle, flip, start, health check, auto-revert on failure.
  4. The hard part: move per-daemon state out of the clone (`.conveyor/`, `.operations/` job records, locks) to one shared location, so in-flight jobs survive a switch.
- **Interim, already built as a hotfix (lane/hot-rebuild-no-starve):** a ready candidate waiting more than N ticks makes the next tick yield, so the swap happens within one tick. The pause flag is reusable for manual "pause, switch, resume".
- **Evidence, 2026-10-19:** the review clone was stuck about 70 min (17:42-18:52 ET) because reader priority starved the rebuild writer, and 4 hotfixes stayed un-adopted.
- **Estimate:** about 1 day; most of it is the state move. Build it via the builder as proper work, not as a hotfix.

## Delivery mode (operator 2026-10-19)

The field `deliveryMode` has its home in card 6626 (deliveryMode per card). This card is `prototype`.

- Prototype first, then shadow, on ONE daemon (review) first.
- Shadow: build and smoke into the idle clone, with "dry" switches that only log.
- Then a few real switches in quiet hours, with the old clone kept warm for an instant revert.
- Proof before the PR: a log of real switches with no lost review jobs and no lock issues, plus at least one deliberate failed switch that auto-reverted.
- Then graduate via a normal PR, and repeat for the drain.
