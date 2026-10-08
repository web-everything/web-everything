---
kind: story
size: 5
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Overlay load runs a real dispatch smoke and rolls back a broken launch path

Incident 2026-10-08: overlay lane/worker-contract-s3b on the fix/review daemon edges broke every fix/ci-heal dispatch for ~1h (detached claude -p had no --permission-mode, so each worker hit an approval prompt at step 0). The load's smoke never launched a real worker. Fix: when an overlay touches dispatch-path files (a setting), the gated load launches ONE real worker through the clone's actual launch path against a scratch completion store, requires its first commands to run with no approval prompt and a completion record, and on failure refuses/rolls back only that overlay. daemon-overlay add warns (setting warn|refuse) for an overlay with no PR.

## Done when

1. **Executable** — `npm run test:unit` on we:scripts/lib/__tests__/daemon-load-overlay.test.mjs and we:scripts/__tests__/daemon-overlay.test.mjs fails before (no `withDispatchSmoke`/`judgeDispatchSmoke`, no no-PR warning) and passes after.
2. **Live replay** — loading `lane/worker-contract-s3b` at its pre-fix tip (222e45f5e) onto a scratch daemon clone fails the dispatch smoke (`commands-denied`, transcript `permissionMode:"default"`) and removes that overlay automatically; loading the fixed tip passes (`permissionMode:"auto"`, marker + v2 done record).

## Edge cases this change must handle

1. **Untrusted text** — the ref is checked with `isSafeBranchName` before any git argv; prompt paths are single-quoted.
2. **Truncated reads** — n/a: the completion record and marker are small local files read whole; an unparseable record reads as "no record" (keep waiting, then timeout = fail).
3. **Shared state files** — the smoke writes only to a fresh mkdtemp store (`OPERATION_COMPLETIONS_DIR`), never the real completions dir; the overlay list is changed only through `removeOverlay` (its own list lock).
4. **Fail closed** — an unreadable overlay diff counts as touching the dispatch path; a missing record, a missing marker, or a timeout is a failure; invalid settings fall back to the default (smoke on).
5. **Identity scoping** — rollback removes only the overlay being loaded; the candidate failure throws so the rebuild holds instead of its plain-main fallback (which would drop every other overlay).
6. **State over time** — a daemon tick that adopts the overlay before this load's rebuild is caught by the post-adopt smoke; residual: that tick's own rebuild does not run the dispatch smoke (follow-up: move it into the rebuild's candidate smoke). A **versioned** clone is built by the in-tick updater, not this CLI. With `--wait`, the version the request adopted (named in its result) is smoked when the overlay is in it; on failure the overlay is removed and the version is rolled back with the daemon's own `rollback` (current → previous, rejected sha held until main moves). Without `--wait`, when nothing was adopted, or when the updater did not apply the overlay (it builds origin/main only today), no smoke runs and the load says so (`dispatch-smoke-not-run` warning, also for a non-versioned load whose overlay never reached the tree). The same follow-up closes it: the candidate-smoke move covers the versioned path too.
7. **Who wrote it** — the marker carries a per-run nonce, so a stale marker or record from another run never passes.
