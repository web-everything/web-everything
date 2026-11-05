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

## Progress

**2026-11-05 · slice 1 (A1 measurement + the setting).** One copy of origin/main (544 npm packages), pnpm 9.15.9 pinned via `npx`, hoisted linker, store outside the repo. Events come from a recursive `fs.watch` counter on the target; disk is the `df` delta. One run per arm, on a loaded Mac, so treat the df column as noisy.

| arm | wall s | fs events | disk delta MB |
|---|---|---|---|
| npm ci, cold cache | 9.0 | 22.0k | 1675 |
| npm ci, warm cache | 7.0 | 27.9k | 726 |
| pnpm hoisted, clone, cold store | 12.3 | 39.8k | 578 |
| pnpm hoisted, clone, warm store | 3.8 | 26.5k | 19 |
| pnpm hoisted, hardlink, cold store | 13.2 | 22.5k | 551 |
| pnpm hoisted, hardlink, warm store | 7.4 | 22.4k | 295 |
| `cp -cR` of the npm tree (today's rebuild-job) | 4.8 | 40.5k | 198 |
| symlink to the shared store | 0.003 | 1 | n/a |

Files written: npm 18.8k, pnpm 18.76k; the pnpm store is 470 MB, counted once. Unit tests (`we:scripts/lib/__tests__`) under the default isolated pnpm layout: 481 of 492 files pass; the 11 failing files are "not a git repository" errors (the archive has no `.git`), with zero module-resolution errors, so no phantom-dependency breakage was found.

Conclusion: pnpm cuts disk heavily (a warm install is 19 MB vs 726 MB) and install time (3.8 s vs 7 s), but barely cuts fs events. Only a symlink to a shared store cuts events, to 1. So for rebuild jobs, replace cp -cR with a symlink where tests don't write into node_modules; pnpm is the disk and time win for lanes.

The setting itself: `we:scripts/lib/package-manager.mjs` (`resolvePackageManager`, `installArgv`, `installCommand`, `installWithFallback`, `--explain`); nothing calls it yet.
