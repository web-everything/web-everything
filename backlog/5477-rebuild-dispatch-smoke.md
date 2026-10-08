---
bornAs: xhiqxz3
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/rebuild.mjs", "we:scripts/lib/__tests__/daemon-rebuild-smoke.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Daemon tick rebuild runs the real dispatch smoke before adopting a dispatch-touching overlay

The tick rebuild adopts overlays with only dry-run smokes, so a broken worker launch (s3b, 2026-10-08) can run for minutes before the gated load smokes it. The rebuild's candidate smoke now launches one real worker (#4481's runRealDispatchSmoke) when a new or moved overlay touches a dispatch-path file, and holds on last-good on failure.

Stacked on #4481 (card 5478, unmerged at filing): reuses its `runRealDispatchSmoke`, `matchDispatchPaths` and
`overlaySafetySettings` (same `overlaySafety` settings) from we:scripts/lib/daemon-load-overlay.mjs.

## Done when

1. **Executable** — the unit test we:scripts/lib/__tests__/daemon-rebuild-smoke.test.mjs (run through `npm run test:unit`) fails before (no
   gate: the s3b-shaped overlay is adopted) and passes after.
2. **Live** — a scratch clone whose tick rebuild picks up the pre-fix s3b commit 222e45f5e fails the dispatch smoke
   inside the rebuild and stays on its last-good tree; the fixed tip passes.

## Edge cases this change must handle

1. **Untrusted text** — the worker's denial text is only redacted into an alert detail; never executed or parsed as a command.
2. **Truncated reads** — an overlay diff that cannot be read counts as touching the dispatch path (fail closed: smoke it).
3. **Shared state files** — the hold + rejection is written in the one locked state write; the overlay drop goes through `removeOverlay`'s own list lock.
4. **Fail closed** — a failed or unreadable dispatch smoke never adopts; only a definite failure (denied / no command ran / launch threw) drops the suspects, a timeout keeps them and retries with backoff.
5. **Identity scoping** — only overlays NEW or MOVED since the adopted build are smoked; unknown adopted state ⇒ every dispatch-touching overlay is.
6. **State over time** — a passed overlay is in `state.adopted.applied` and is not re-smoked; a timeout retries on the reject backoff, not every tick.
7. **Who wrote it** — n/a: the smoke tests the candidate tree's own launch path, whoever authored the overlay.
