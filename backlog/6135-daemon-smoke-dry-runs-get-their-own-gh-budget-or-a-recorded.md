---
bornAs: xstapna
kind: story
size: 5
status: open

dateOpened: "2026-10-14"
tags: []
---

# Daemon smoke dry runs get their own gh budget or a recorded PR snapshot

Daemon smoke tests time out waiting for a gh slot. Drain and review clones were held 4-7 h on 2026-10-14 (since 13:09Z / 16:16Z) because the reconcile and dispatch smoke runs hit 300-786 s waiting in gh-throttle at load about 5; #5293 only ends the endless hold. Measured (review items 1, 2, 6): dispatch-dry-run 57/57 failed, p50 750 s (the widened cap), one attempt 382 gh calls; it runs reconcile-fix-pass, reconcile-ci-heal-pass and reconcile-review-pass one after another over every live open PR (we:scripts/lib/daemon-live-smoke.mjs:589-623). reconcile-dry-run 45/45 failed, p50 307 s, serial per-repo loop that repeats the same reads (we:scripts/lib/daemon-live-smoke.mjs:434-445). Budgets scale on CPU idle, not on the real bottleneck: 56 slot_timeout and 30 slot_throttled events in the retained window, cap 6 concurrent (we:scripts/lib/gh-throttle.mjs:203). Fix: either a separate smoke gh slot budget (cascade setting, e.g. ghThrottle.pools.smoke) so a busy production pool cannot fail a rebuild, or record one open-PR + per-PR status snapshot per smoke and replay it to the three dispatch passes and the reconcile pass (through the throttle's memo/snapshot layer); run the passes and repos concurrently. Old behaviour stays selectable. Prove: a rebuild under a full production pool passes smoke in normal time (750 s to under 60 s expected with a snapshot).

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/daemon-live-smoke.test.mjs`: a new test asserts the dispatch and reconcile dry runs read from one recorded PR snapshot (or the smoke gh pool) and make no production-pool gh calls; it fails before and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change production gh-throttle caps or the real-worker overlay smoke.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the recorded snapshot is gh JSON; parse failures fail the check, never pass it.
2. **Truncated reads** — a partial or truncated snapshot (pagination cut) fails the smoke rather than replaying a short PR list.
3. **Shared state files** — the snapshot is per-smoke, written in the smoke's own temp dir; the smoke gh pool is a separate slot set.
4. **Fail closed** — if the snapshot cannot be recorded, fall back to the old live reads (selectable setting), never skip the check.
5. **Identity scoping** — the smoke pool and snapshot are keyed to the smoke run id; production callers never read them.
6. **State over time** — the snapshot is used only within one smoke run and discarded after.
7. **Who wrote it** — n/a: the snapshot is recorded by the smoke itself from gh.

## Findings (standalone worker, 2026-10-14)

The build-dispatch daemon held #6135 with:

> worker-declined: **could-not-prepare** — a genuine design choice remains: allocate additional live GitHub capacity to smoke runs, or require recorded inputs and define what happens when those inputs are unavailable. Current code already shares per-smoke memoized reads ('we:scripts/lib/daemon-live-smoke.mjs:902'), but memo misses still make live calls ('we:scripts/lib/gh-throttle.mjs:1782'). Missing or expired PR snapshots also trigger live fetching ('we:scripts/lib/pr-snapshot.mjs:253'). These mechanisms therefore do not guarantee independence from a saturated production pool. The unresolved choice is whether co…

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
