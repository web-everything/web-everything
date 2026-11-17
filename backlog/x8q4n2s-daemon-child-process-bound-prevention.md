---
kind: story
size: 2
status: open
dateOpened: "2026-11-17"
tags: []
related: ["x2fybk1"]
---

# Prevent missing bounds on daemon host inspection subprocesses

PR #6945 security/test-coverage requested a structural prevention guard for subprocess bounds. The repair pins existing scutil, GitHub, git and SSH calls with executable tests; new call sites can still omit bounds.

## Acceptance

- Route the host guard and preflight child calls through one bounded execution helper, or add a standards rule that rejects calls lacking both timeout and maxBuffer.
- Keep the existing 15,000 ms and 1 MiB contract and argv-only execution.
- A named negative test rejects a new unbounded call; failure and timeout paths remain fail closed.

## Scope

`we:scripts/lib/daemon-host-guard.mjs` and `we:scripts/operations/daemon-preflight.mjs`; choose the shared-helper or standards-rule approach before implementation. No daemon wiring.
