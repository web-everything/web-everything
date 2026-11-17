---
kind: story
size: 2
status: closed
dateOpened: "2026-11-17"
tags: []
related: ["x2fybk1"]
---

# Superseded: throttle successful owner reads when cache persistence fails

R970 supersedes this follow-up in PR #6945: ownership caching and throttling are removed entirely. Every activation requires a new successful ownership-source read. R971 adds a persistent opaque local ID, which stores identity only and cannot authorize an offline decision.

## Acceptance

- No throttle or ownership-cache implementation remains to reinforce.
- Guard tests cover repeated successful reads, handoff, read failure and fresh recovery.
- The existing registered soak covers the fresh-source path and unreadable preflight ownership.

## Scope

`we:scripts/lib/daemon-host-guard.mjs` and its unit/soak coverage. No further implementation is required for this superseded design.
