---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch-job.mjs", "we:scripts/conveyor/health-watch.mjs", "we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs", "we:scripts/conveyor/__tests__/health-watch-job.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a unit test for cloneNodeModulesInstaller covering its three branches with an injected exec.… (from web-everything/web-everything#4691 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-watch-job.mjs:78` — Add a unit test for cloneNodeModulesInstaller covering its three branches with an injected exec. Add a live-proof checklist item that times a cold-store tick against the tick budget. A lint rule banning execFileSync in tick-side job modules is the deterministic option.
2. `we:scripts/conveyor/health-watch.mjs:1245` — Add an allowlist of probe keys and a `Number.isFinite(sampledAt) && sampledAt <= now + skew` check to a single `validateJobResult()`. Cover it with a tick test that feeds a hostile sidecar. A check:standards rule could flag `Object.assign(probes, <parsed file>)`.
3. `we:scripts/conveyor/health-watch.mjs:1238` — Add a deterministic integration test that seeds an unconsumed durable job without state.jobs, disables admission, and asserts that rollback discovers and drains it.
4. `we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs:257` — Assert HEALTH_WATCH_JOB_SWITCHES.ghProbes and resolveHealthJobSwitches({}).ghProbes are false in the deterministic unit suite.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4691@0d1c634928f6ab1f9cad0abe87891ce7e1556212

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
