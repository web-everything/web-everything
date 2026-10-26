---
bornAs: xjrufsx
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Review tick does its full reconcile twice per repo and runs the repos one after another

[held entry 312] (daemon-async-audit 2026-10-14, held — interim until 5763) Review tick does its full reconcile twice per repo and runs the repos one after another. Median 587 s, p90 1,575 s against 120 s; 21 of 24 h are spent inside ticks. The convert-advisory stage re-reads the PRs and re-plans every repo (median 188 s for WE). The hold sweep runs its own listing. FUI reconcile takes 235 s median vs plateau 9 s (unexplained). There are no phase timings. Fix idea: pass the tick's plan and rawPrs from runReviewTick into runConvertAdvisoryTick and prep-review; feed the hold sweep the same listing; run the 3 repos bounded-parallel; emit a pass timings line per phase (holds, reconcile per repo, tag, convert, prep). Design: shared + parallel. Evidence: review-daemon.log ledger-shadow markers (31 clean ticks); we:skills-src/conveyor/review-daemon.mjs:598,689-703,954-985. Saves 3–7 min/tick. Size 2.

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
