---
kind: story
size: 3
parent: "xpd5nhi"
status: open
blockedBy: ["x3xrhfl"]
scope: ["we:scripts/longshore-entry.mjs", "we:scripts/__tests__/longshore-entry.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# One declared entry module that plateau-app imports instead of deep WE paths

plateau-app's drain shell and dev panel import WE files by deep path (drain-lock, daemon-self-sync, daemon-overlays, daemon-rebuild, operations run, http-adapter). Add one declared entry module that re-exports exactly these, and move plateau-app onto it, so later moves only have to keep one file stable.

## Acceptance

- [A1] **Executable** — a test fails if `we:scripts/longshore-entry.mjs` stops exporting any symbol plateau-app uses (drain-lock, self-sync, overlays, rebuild, operations run, http-adapter).
- [A2] plateau-app's drain shell and dev panel import only the entry module (follow-up PR in plateau-app, linked), and the drain daemon runs one full pass on it.

## Non-goals

- [N1] Moving the drain shell or changing its behaviour.
