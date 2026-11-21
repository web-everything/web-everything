---
kind: task
status: open
scope: ["we:scripts/prototype-load.mjs", "we:scripts/operations/__tests__/prototype-load-remove-real.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Overlay remove must force re-adopt or hold the daemon

Removed overlay code ran for 20+ minutes after the overlay was removed. Overlay remove must force a re-adopt or hold the daemon. Source: build-queue 00:04 ET 2026-11-21 (#7262).

## Acceptance

- [A1] **Executable** — Planned `overlay removal invalidates daemon adoption` in `we:scripts/operations/__tests__/prototype-load-remove-real.test.mjs`: Remove an overlay in a real fixture; assert the next daemon tick either re-adopts code without that overlay or is held before executing removed code.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No unrelated overlay lifecycle redesign.

## Edge cases this change must handle

1. **Untrusted text** — Overlay metadata is data.
2. **Truncated reads** — An incomplete removal/adoption read holds the daemon.
3. **Shared state files** — Coordinate removal with daemon adoption state.
4. **Fail closed** — Failed re-adoption keeps the daemon held.
5. **Identity scoping** — Match the removed overlay to the affected daemon.
6. **State over time** — Cover removal while the daemon is already running.
7. **Who wrote it** — Only verified adoption state permits continuation.

## Duplicate admission

new-card-from-build-queue-CARD-line --json
