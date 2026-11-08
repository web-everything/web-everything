---
bornAs: xbfeat8
kind: story
size: 5
status: open
scope: ["we:scripts/operations/operator-queue-needs-person.mjs", "we:scripts/lib/marker-authorship.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/operations/needs-you-feed.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# needs-person ask is cleared by ANY comment from the operator login, including daemon comments posted under th…

Flow-sim gap R8b-G9, class K8 (authority asymmetry). Failing input: Trusted note 'needs your decision' on PR (key e.g. round-cap-exhausted:5:fix:4/4). Later the conveyor, running on the operator's personal gh auth fallback (documented in we:marker-authorship.mjs header), posts any comment (stand-down, rearm, heal marker, status) or the operator posts an unrelated remark.' 'operator-queue run. Cited: we:scripts/operations/operator-queue-needs-person.mjs:8, we:scripts/lib/marker-authorship.mjs:120-132, we:scripts/operations/operator-queue.mjs:793-794, we:scripts/operations/needs-you-feed.mjs:160. Soak-break sketch: Fixture: comments [botNote(ci-heal-exhausted) t1, operatorLogin comment 'rearm: review-loop re-armed' t2 (automation fallback)]. Assert needsPersonRow still returns a row (no answer command ran: no extend-rounds/stand-down-answer/send-back marker); fails toda…

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
