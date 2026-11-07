---
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/readiness/file-locks.mjs", "we:scripts/readiness/drain-lock.mjs", "we:scripts/lane-drain.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Drain lease (15 min) is renewed only at the top of a watch pass; a one-shot sweep never renews it, and the he…

Flow-sim gap R8c-G1, class K7 (unserialized duplicate actors). Failing input: we:merge-ai-prs.mjs running a label sweep (resident --watch or one-shot) holding the per-repo drain lease (we:drain-lock.mjs:71,79: DRAIN_LEASE_MINUTES = DEFAULT_LEASE_MINUTES = 15). One sweepOnce() takes longer than 15 minutes (many ready-to-merge PRs, unknown-mergeability retry sleeps, gh throttle, rebase waits). Time passes … Cited: we:scripts/merge-ai-prs.mjs:7732, we:scripts/merge-ai-prs.mjs:2924-2955, we:scripts/merge-ai-prs.mjs:7734, we:scripts/readiness/file-locks.mjs, we:scripts/merge-ai-prs.mjs:7819. Soak-break sketch: Fixture: temp DRAIN_LOCK_ROOT, drain A acquires with injected nowMs=T0, runs a stub sweepOnce that advances the clock 16 min. Action: drain B calls the gate+acquire at T0+16m, then A finishes its sweep step. Assertion that fails today: A must detect lease los…

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
