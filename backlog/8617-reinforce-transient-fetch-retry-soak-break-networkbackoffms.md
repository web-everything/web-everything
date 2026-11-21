---
bornAs: xpmplnv
kind: task
status: open
scope: ["we:scripts/conveyor/soak/breaks/transient-fetch-retries-before-needs-you.mjs", "we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Reinforce: transient-fetch retry soak break, networkBackoffMs bound and timeout policy after network failure

Follow-ups from the transient-fetch-retry fix (#7232), accepted under R1085 and fast-mode residual risk (R825). Three reinforce-later items:

1. `we:scripts/conveyor/soak/breaks/transient-fetch-retries-before-needs-you.mjs:53` — recovery behaviour determines `fixPresent`; removing retries makes it false and `defineBreakTest` switches to `it.fails`, so the regression passes as an expected failure instead of failing the gate.
2. `we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:103` — `deps.networkBackoffMs` bypasses all retry-count and delay validation; a probe accepted four 90-second delays, and long overrides block heartbeat refresh past lock expiry.
3. `we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:116` — retries after an initial network failure bypass the timeout handler; connection reset then ETIMEDOUT stops after two calls and loses the 3-attempt timeout policy and `transientGit` classification, so callers record failure/escalation instead of skipping the tick.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- node --test we:scripts/conveyor/soak/breaks/transient-fetch-retries-before-needs-you.soak.test.mjs we:scripts/lib/daemon-rebuild/__tests__/overlay-main-sync.test.mjs` passes with new cases that fail on main: (a) with retries removed the soak break test FAILS (fix presence decided by behaviour, no `it.fails` pass); (b) `networkBackoffMs` is clamped to the advertised count and delay bounds; (c) connection reset followed by ETIMEDOUT still makes three attempts and returns the `transientGit` classification.

## Non-goals

- [N1] Does not change the retry count or delay defaults, and does not touch other daemon sync paths.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no text input; git error codes are matched against a closed set.
2. **Truncated reads** — n/a: no file reads are added.
3. **Shared state files** — Backoff total must stay below lock expiry so heartbeat refresh is never blocked.
4. **Fail closed** — An invalid or oversized `networkBackoffMs` is clamped or refused, never trusted.
5. **Identity scoping** — n/a: no identity decision.
6. **State over time** — The attempt counter is shared across network and timeout failures within one tick.
7. **Who wrote it** — n/a: no authorship decision.
