---
bornAs: x5059uu
kind: story
size: 5
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Daemon rebuild keeps the adopted overlay set and parks the conflicting newcomer instead of dropping proven overlays

Live 2026-10-09 19:54Z on wev-control: after #4643 (registered first) pushed a new commit (90931a79e), the rebuild in we:scripts/lib/daemon-rebuild/plan.mjs logged overlay-conflict-unresolved on we:skills-src/conveyor/build-dispatch-daemon.mjs and conflict-DROPPED the established, live-proven overlays #4658 (prepare launches) and #4663 (ruled-hold release), silently regressing the builder until their branches were hand-merged. Rule: an overlay that is in the currently adopted HEAD is established; when a rebuild hits a conflict, keep the previously adopted overlay set and refuse/park the overlay that CHANGED or was newly added (the newcomer), never the established ones. Alert overlay-newcomer-parked with ref, PR, its conflicting files and the established overlay it collides with, and post that on the newcomer's PR so its author resolves it (merge the established branch into it). Dropping an established overlay must never be silent: it needs its own loud alert. Also observed: the rebuild smoke took 1,002 s (smoke-slow 20:11:49Z; reconcile-dry-run 148 s, dispatch-dry-run 218 s, lane-acquire-release 32 s), which held #4677/#4680 out of the tree for a whole extra rebuild cycle and made a manual load return rebuild-in-progress; file or fold a slice to cut the smoke. Proof required: replay the 19:54Z case (newcomer commit on an earlier-registered overlay that conflicts with later established ones) and show the established overlays stay in HEAD with the newcomer parked.

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
