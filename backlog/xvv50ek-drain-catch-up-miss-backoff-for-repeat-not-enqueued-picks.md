---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/settings/merge-queue.json"]
dateOpened: "2026-10-30"
tags: []
---

# Drain catch-up miss backoff for repeat not-enqueued picks

Delivered by PR #6113 (R260; R280 retro card). Drain catch-up kept retrying a PR whose fast drain ended 'not enqueued'. It now backs off until the head sha or labels change or catchUp.missBackoff.ttlMinutes (default 30) passes; logged once per hold; enabled:false reverts. Core: we:scripts/lib/enqueue-on-event.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/enqueue-on-event.test.mjs` (delivered by #6113).

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
