---
kind: story
size: 2
status: open
dateOpened: "2026-11-17"
tags: []
related: ["x2fybk1"]
---

# Throttle successful owner reads when cache persistence fails

PR #6945 codex-correctness advisory at `we:scripts/lib/daemon-host-guard.mjs` reports that successful remote reads are not throttled if cache persistence fails. Repeated calls can exceed the promised one remote read per host per minute. The review explicitly deferred this behavior change to a card.

## Acceptance

- Reproduce repeated successful owner reads with failing cache writes and assert a per-host one-minute bound after the first read.
- Preserve startup's fresh-read requirement, handoff denial, independent host state and the ten-minute cache lifetime.
- Exercise thrown persistence failures and false returns separately; do not reuse superseded ownership evidence.
- Add a daemon soak case for the selected retry behavior.

## Scope

`we:scripts/lib/daemon-host-guard.mjs` and its unit/soak coverage. No daemon wiring or lock reclamation.
