---
bornAs: xpblms8
kind: story
size: 2
status: open
scope: ["we:scripts/operations/operator-queue.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Optional-section reads (lane reclaim, backpressure) return an empty list on any failure, which prints as '(no…

Flow-sim gap R8b-G7, class K15 (detector or report false negative). Failing input: Operator runs operator-queue with --with-lanes and/or --with-backpressure; we:lane-whois.mjs --json exceeds its 20 min timeout, crashes, or we:pr-limit.mjs status fails / prints non-JSON.' 'laneReclaimQueue / prLimitCounts catch the error. Cited: we:scripts/operations/operator-queue.mjs:445, we:scripts/operations/operator-queue.mjs:472-480, we:scripts/operations/operator-queue.mjs:897-902. Soak-break sketch: Fixture: main(['--with-lanes','--with-backpressure']) with exec mocked to throw for the lane-whois and pr-limit children. Assert report.errors (or stdout) names both sections as UNKNOWN / exit code 1; fails today ('(none)' under LANE RECLAIM and BACKPRESSURE,…

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
