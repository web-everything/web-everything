---
bornAs: xp9dmnh
kind: story
size: 3
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Overlays are stack-aware

Held item 212 (session 2026-10-10; being built now by another session -- resolve through that PR; filed unqueued). Live 14:40 ET on wev-fix-daemon: #4779 was rebased onto #4770 (new head 2f073a693) while #4792 and #4797 still sat on its old head; the loader treated all three as independent, the newcomers conflicted on we:scripts/conveyor/fix-takeover.mjs and were parked/dropped, and the old #4779 code (309be0b58) fell OFF the live fixer. Hand workaround: removed #4779 from the overlay list (its old code rides inside #4792/#4797). Fix: when an overlay's PR base is another overlay's branch, apply only the stack top (it contains its bases); when a base PR moves, keep the last adopted stack until the children are restacked; log the decision.

## Acceptance

- [A1] **Executable** — a test with a three-PR stack applies only the top; moving the base keeps the last adopted stack until the children restack.
- [A2] **Live** — a stacked overlay set adopts without dropping the base's code.

## Non-goals

- [N1] Restacking PRs (the overlay only reads stack shape).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: PR numbers and refs only.
2. **Truncated reads** — If a PR's base cannot be read, treat it as independent and log it.
3. **Shared state files** — The overlay list is the existing state file, written under its lock.
4. **Fail closed** — Unknown stack shape -> keep the last adopted set.
5. **Identity scoping** — Per clone and repo.
6. **State over time** — Base moves are covered by keeping the last adopted stack.
7. **Who wrote it** — Only the operator registers overlays.
