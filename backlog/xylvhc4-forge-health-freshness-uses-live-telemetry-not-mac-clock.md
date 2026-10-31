---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/forge-remote-health.mjs", "we:scripts/readiness/forge-exec-run.mjs", "we:docs/agent/testing.md"]
dateOpened: "2026-10-30"
tags: []
---

# Forge health freshness uses live telemetry, not Mac clock

Delivered by PR #6106 (stacked on #6059; R280 retro card). Freshness compared the Mac clock to Forge's sampledAtET; Forge runs a few seconds ahead, so fresh samples had negative age and tripped telemetry-stale plus a sticky 120s backoff, silently keeping runs local. Freshness now reflects live Forge telemetry. Core: we:scripts/readiness/forge-remote-health.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-health-fresh.test.mjs` (delivered by #6106).

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
