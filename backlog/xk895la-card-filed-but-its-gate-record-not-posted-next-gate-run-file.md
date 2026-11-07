---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/lib/prevention-landing-job.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Card filed but its gate record not posted -> next gate run files the card again

Flow-sim gap B-C8, class K3 (one-shot step, no re-driver). Failing input: Trusted result on HEAD with a `degraded` finding (card action). No card-queued marker. gh comment post throws (throttle). first gate run: fileCard ok (:217), postComment fails (:182-185) -> status 'card-record-failed' (:222); any later gate run (review-job rerun, extend-rounds regate). Cited: we:scripts/operations/red-team-gate-apply.mjs:158, we:scripts/lib/prevention-landing-job.mjs:84. Soak-break sketch: double-act (duplicate follow-up card). Combine with C1: if no later run ever comes, the card is also simply never recorded.

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
