---
bornAs: x9m6r3t
kind: story
size: 2
status: open
dateOpened: "2026-11-17"
tags: []
related: ["8581"]
---

# Superseded: throttle successful owner reads when cache persistence fails

R970 supersedes this proposed throttle. PR #6945 removes ownership caching and
requires a new successful source read for every role resolution. There is no
cache write or cached grant to throttle or recover.

## Acceptance

- Do not implement the former one-minute successful-read reuse or ten-minute fallback.
- Preserve fresh-read-only behavior in `we:scripts/lib/daemon-host-guard.mjs` and its
  unit and soak coverage.

## Scope

Historical residual of PR #6945; no additional implementation under the old design.
