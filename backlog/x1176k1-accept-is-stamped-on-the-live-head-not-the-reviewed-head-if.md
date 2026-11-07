---
kind: story
size: 3
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Accept is stamped on the live head, not the reviewed head, if a push lands between the pre-write head check a…

Flow-sim gap A-C5, class K6 (check-then-act race with no pin). Failing input: labels: [review:pending] files: 'review job reviewed head H1 (read.netBasis.rev=H1), verdict accept, CI green; PR head still H1 at RPIO:1007/1038' author pushes H2 after assertPublishable's last assertHead and before the child process we:review-set-label.mjs reads PR state (node start-up + imports + gh, seconds) Cited: we:scripts/review-set-label.mjs, we:scripts/operations/review-pr-io.mjs:991-1039, we:scripts/operations/review-pr-io.mjs:1590-1604, we:scripts/review-set-label.mjs:1153-1166, we:scripts/review-set-label.mjs:1370. Soak-break sketch: wrong-clear: review:accepted + matching reviewed-sha on a head no panel read (the file itself notes this at RPIO:991-996 for the unpinned case).

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
