---
kind: task
status: open
scope: ["we:scripts/ci/test-timings.json"]
dateOpened: "2026-11-21"
tags: []
---

# Fix daemon-soak 50-tick and pr-live-owner-watch timeouts under saturated shards

Owner of 2 main-red quarantines (expire 2026-11-21 22:43 ET): daemon-soak 50-tick timeout and the pr-live-owner-watch expectedHead 5000ms timeout under saturated shards after #7259. Consider re-balancing timings; unquarantine before ttl. Source: build-queue 22:43 ET.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Duplicate admission

new card from build-queue CARD line
