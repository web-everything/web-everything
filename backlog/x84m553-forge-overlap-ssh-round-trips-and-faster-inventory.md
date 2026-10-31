---
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/remote-exec.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/tree-watchdog.mjs", "we:scripts/lib/worker-deadline.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Forge: overlap SSH round trips and faster inventory

Delivered by PR #6101 (stacked on #6100; R280 retro card). Forge sync spent most wall time on sequential SSH round trips. SSH ControlMaster reuse (private 0700 dir, graceful degrade, also for rsync) plus parallel reachability, HEAD and bases discovery cut it. Core: we:scripts/readiness/remote-exec.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/remote-exec.test.mjs` (delivered by #6101).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing beyond the digest is in scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new input path beyond the digest; existing handling unchanged.
2. **Truncated reads** — n/a: no new input path beyond the digest; existing handling unchanged.
3. **Shared state files** — n/a: no new input path beyond the digest; existing handling unchanged.
4. **Fail closed** — n/a: no new input path beyond the digest; existing handling unchanged.
5. **Identity scoping** — n/a: no new input path beyond the digest; existing handling unchanged.
6. **State over time** — n/a: no new input path beyond the digest; existing handling unchanged.
7. **Who wrote it** — n/a: no new input path beyond the digest; existing handling unchanged.
