---
bornAs: xk6mrey
kind: story
size: 3
status: resolved
scope: ["we:scripts/readiness/forge-exec-bases.mjs", "we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/forge-warm-base.mjs", "we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-10-30"
dateResolved: "2026-10-31"
graduatedTo: 2ee4dcbf9bf17c1674e7948339d0b15c164151b6
tags: []
---

# Forge pre-warmed slots and reliable warm base

Delivered by PR #6104 (stacked on #6101; R280 retro card). Prewarm hit only 1 of 3 delta runs and slot trees existed only for the newest base. We now keep 12 bases and pick the one nearest HEAD, retry the guard a bounded number of times, and claim per-slot pre-assembled base trees exclusively (falls back to normal copy on any doubt). Core: we:scripts/readiness/forge-exec-bases.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-offload.test.mjs` (delivered by #6104).

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
