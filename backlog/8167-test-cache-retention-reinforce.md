---
bornAs: xpj3cu1
kind: story
size: 3
status: open
dateOpened: "2026-11-12"
tags: []
related: ["test-result-cache"]
---

# Reinforce test-result-cache retention: other-run liveness check and settings-layer caps

Prune protects only the caller runId plus a 6h idle window; add other-run liveness (owner PID) and move WE_TEST_CACHE_MAX_AGE_DAYS/MAX_BYTES into the settings layer (R905).

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/test-result-cache.test.mjs` includes a test named 'does not remove an old run whose owner PID is alive' (fails before, passes after), and the two env caps resolve through the settings layer with their source logged.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the age or size defaults, and does not prune `entries/` or `shadow/`.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only names matching the run-id pattern are touched; PID parsed from the name is validated as a positive integer.
2. **Truncated reads** — n/a: no file contents are parsed, only names and mtimes.
3. **Shared state files** — the hourly `.prune-stamp` is shared across processes; keep the O_NOFOLLOW write and treat an unreadable stamp as best-effort.
4. **Fail closed** — if the owner PID cannot be checked, keep the run.
5. **Identity scoping** — a reused PID may keep an abandoned run longer; accepted, the age cap still bounds it.
6. **State over time** — a run idle more than 6h but alive must survive a size-pressure prune.
7. **Who wrote it** — n/a: the cache is written only by the local test reporter.

## Duplicate admission

follow-up to the trace retention PR

retention prune shipped; this adds the live-run check it lacks
