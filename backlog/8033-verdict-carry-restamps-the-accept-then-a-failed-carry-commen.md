---
bornAs: xh0qyfl
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Verdict carry restamps the accept, then a failed carry comment falls through to a full normal review

Flow-sim gap A-C9, class K3 (one-shot step, no re-driver). Failing input: labels: [review:accepted] files: 'carryAcrossRebase=on; prior accept on head P (findCarriableVerdict), PR rebased to head H with identical patch-id; no verdict-carried comment yet' restampVerdict succeeds (RSL --to=restamp moves review:accepted/reviewed-sha to H) and then postCarryComment throws (gh throttle/network) or the job… Cited: we:scripts/operations/review-job.mjs:1121-1123, we:scripts/operations/review-job.mjs:1132, we:scripts/operations/review-job.mjs:497, we:scripts/operations/review-job.mjs:1138, we:scripts/operations/review-job.mjs:1145-1309. Soak-break sketch: double-act: a second panel and second verdict on an already-accepted head; the red-team gate markers that the carry comment would have copied (RJ:1126-1129) are never posted.

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
