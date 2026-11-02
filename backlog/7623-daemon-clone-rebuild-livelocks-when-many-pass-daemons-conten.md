---
bornAs: xhvgyzx
kind: story
size: 5
status: open
scope: ["we:scripts/lib/daemon-clone-lock.mjs", "we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/daemon-overlay.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Daemon clone rebuild livelocks when many pass-daemons contend for the writer slot; one owner should rebuild each clone

Live 2026-11-02 (R409-R411): after the review pinned overlay was removed, the review clone stayed on 1b9105b5, 28 behind main, for hours. Cause: about 12 pass-daemons share the review clone and each runs withSelfSync, so each takes the writer slot in turn, waits on readers, then backs off with reader-priority. The review daemon log shows 46 reader-priority backoffs and no clone move after 10:02Z; a manual we:scripts/lib/daemon-rebuild.mjs run returned concurrent-mover twice. Design: one owner rebuilds each clone (the primary daemon of that clone); pass-daemons only read it and never take the writer slot or run a rebuild; and removing a pinned overlay (we:scripts/daemon-overlay.mjs remove) writes a rebuild request that the owner honors on its next tick, and clears a stale held pinned-overlay-conflict flag once the pin is gone. Proof needed: before/after backoff counts and a clone adopting main after a pin removal.

## Acceptance

- [A1] **Executable** — a test that starts N reader pass-daemons plus a rebuild owner on one clone: fails today (rebuild never moves the clone, reader-priority backoffs grow), passes after (owner adopts main within one tick).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] does not change reader fairness for the owner itself, and does not kill or restart any daemon.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no untrusted text is parsed; the rebuild request is a fixed-shape file.
2. **Truncated reads** — n/a: the request file is tiny and written atomically.
3. **Shared state files** — the rebuild request lives in the daemon-self-sync-state dir; written atomically, consumed once, safe with a concurrent writer.
4. **Fail closed** — if the owner is unknown or dead, fall back to today lock behavior and alert; never let two writers move a clone.
5. **Identity scoping** — owner is keyed by clone key, so one clone has exactly one rebuild owner.
6. **State over time** — a stale held pinned-overlay-conflict flag clears once the pin is gone from the overlay list; the request expires after a TTL.
7. **Who wrote it** — n/a: the request carries the remover identity for the alert only; no trust decision uses it.
