---
kind: story
size: 2
parent: "xpd5nhi"
status: open
blockedBy: ["xuxad3w"]
scope: ["we:packages/longshore/*/package.json", "we:packages/longshore/package.json"]
dateOpened: "2026-10-08"
tags: []
---

# Longshore package manifests plus one all-in-one meta package

Ruling S2 and its addition: Longshore ships as several packages (start: @longshore/kit, @longshore/backlog, core) and also one all-in-one meta package that depends on all of them, so a user can install everything with one name.

## Acceptance

- [A1] **Executable** — `npm pack --dry-run` succeeds for @longshore/kit, @longshore/backlog, the core package and the all-in-one meta package.
- [A2] Installing only the meta package in a scratch directory makes every sub-package importable.

## Non-goals

- [N1] Publishing to a registry (happens at the flip).
