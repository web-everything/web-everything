---
bornAs: xqku0oj
kind: story
size: 3
status: open
related: ["6291"]
scope: ["we:scripts/operations/operator-queue.mjs", "we:scripts/operations/needs-you-feed.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A needs-judgment stand-down is shown in the queue's NEEDS YOU but is never published to the needs-you feed (d…

Flow-sim gap R8b-G1, class K15 (detector or report false negative). Failing input: PR (any labels) with an unresolved trusted stand-down comment whose trailer reason is 'needs-judgment'; review setting standDownQueueSection unset (built-in default 'needs-you', we:review-settings.mjs:49).' 'needs-you-feed tick runs operator-queue --json and builds items from the report. Cited: we:scripts/operations/operator-queue.mjs:813-820, we:scripts/operations/operator-queue.mjs:867, we:scripts/operations/needs-you-feed.mjs:80, we:scripts/operations/operator-queue.mjs. Soak-break sketch: Fixture: operator-queue --json report with needsYouStandDowns=[{repo,number:7,title,standDownAt,question,remaining:[]}] and every other section empty. Action: itemsFromReport(report) (and runOnce with liveGate:false). Assert items contains a row for #7 with a…

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
