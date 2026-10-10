---
bornAs: xcb7m27
kind: story
size: 5
status: open
scope: ["we:package.json", "we:scripts/lib/daemon-rebuild/", "we:scripts/lane-pool.mjs", "we:.github/workflows/"]
dateOpened: "2026-10-10"
tags: []
---

# Installs use pnpm (or a shared content-addressed store) instead of npm ci copies

Held item 205 (session 2026-10-10; operator OK). Live 30 s FSEvents sample 13:2x ET: ~3,000 events/30 s; ~40% daemon rebuild candidates (daemon-self-sync-state candidate dirs), ~18% rebuild job dirs, ~33% review daemon .operations; fseventsd ~100% CPU. Every lane and every rebuild candidate runs a full npm ci (npm cache 13 GB). pnpm hard-links from one store -> far fewer file writes, faster installs, less disk. Plan: measure first (rebuild wall time, events per install, disk) on one daemon rebuild. Package manager is a PLATFORM setting (operator 2026-10-10: "Package manager should be platform settings"): `packageManager: npm | pnpm` in the Platform Forever preferences (delivery-platform-preferences, PR #4708), resolved through the cascade (standard default -> platform -> tool/repo override -> env) with the source logged, so every lane, rebuild, daemon and CI job reads one value and can fall back; CI parity. Also look at why the review daemon's .operations writes ~1,000 events/30 s (run record churn). Likely an epic: lanes, rebuilds, CI.

## Acceptance

- [A1] **Measure** — a before/after on one daemon rebuild: wall time, FSEvents per install, disk.
- [A2] **Executable** — `packageManager` resolves through the cascade and lanes, rebuilds and CI read it; a test covers the fallback to npm.
- [A3] **Live** — a rebuild with pnpm shows fewer file events and equal or faster install time.

## Non-goals

- [N1] Changing dependencies or versions.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no external text.
2. **Truncated reads** — A failed pnpm install falls back to npm ci, logged.
3. **Shared state files** — One shared store; concurrent installs rely on pnpm's own store locking.
4. **Fail closed** — Unknown `packageManager` value -> npm.
5. **Identity scoping** — Setting is per platform with repo override.
6. **State over time** — Lockfile drift between npm and pnpm is checked in CI.
7. **Who wrote it** — The source layer of the setting is logged.
