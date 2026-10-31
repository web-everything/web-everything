---
bornAs: xywe2yz
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Overlay main-sync survives a timed-out checkout retry

Delivered by PR #6110 (R280 retro card). A 60s git timeout under host load killed a big checkout, leaving a partial index and untracked files in the scratch clone, so the retry aborted. On retry the scratch is now dropped and recreated (scratch clone only). Core: we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs` (delivered by #6110).

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
