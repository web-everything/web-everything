---
kind: story
size: 5
parent: "xpd5nhi"
status: open
blockedBy: ["xqpz3zp", "xgwmxd4"]
scope: ["we:packages/standard-web/**", "we:scripts/conformance/**"]
dateOpened: "2026-10-08"
tags: []
---

# Conformance runner and web rule pack as a standalone everstandards package with no Longshore dependency

Ruling S3: the conformance runner and the web rule pack live in everstandards and must not depend on Longshore; each standard ships its own rule pack. Make the runner plus web pack a self-contained package (vendoring the few hundred lines of helpers it needs) and prove it has zero imports into delivery code.

## Acceptance

- [A1] **Executable** — a test walks the runner and web pack import graph and fails on any import into Longshore-classified code.
- [A2] The runner runs the web rule pack on WE with the same findings as `check:standards`'s web pack today.
- [A3] Each standard can register its own rule pack through the loader (one sample pack proves it).

## Non-goals

- [N1] Creating the everstandards repo or publishing; this makes the package ready to move.
