---
kind: task
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/operations/__tests__/needs-you-feed.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# needs-you-feed: harden degraded=card settlement

Follow-up to lane/needs-you-break-policy (#7233). Residual items accepted under R1085 for the attention feed (broken breaks always alarm; these only affect degraded findings that policy sends to a card):

1. A spawn-only `card-queued` record settles a degraded finding without proof the card landed; no retraction if filing later fails. (we:scripts/operations/needs-you-feed.mjs:280)
2. The strict fallback's `findingClasses: {}` still lets default `defer-card` classes clear a class-only degraded card. (we:scripts/operations/needs-you-feed.mjs:99)
3. Automatic card rulings inherited through verdict carries settle without a record on the live head (head-binding). (we:scripts/operations/needs-you-feed.mjs:281)
4. The existing "automatic card-queued record does not settle" test uses `**Red-team gate**` without the trailing space, so its action line is never parsed; fix the fixture. (we:scripts/operations/__tests__/needs-you-feed.test.mjs:573)
5. Invalid override values (e.g. degraded=send-bak) are silently dropped by the resolver, keeping degraded=card instead of the strict fallback.
6. (waived, R1085) Automatic card records settle without proving the card landed (spawn-only record, no retraction). The settled check in we:scripts/operations/needs-you-feed.mjs.
7. (waived, R1085) Automatic releases inherit the shared reader's legacy allowance for records without `result=`; a delayed record for an earlier same-head result can settle newer findings by index.

Addendum (added 16:03 ET): a `card` line in a sent-back record settles a break; settlement should require `card-queued`.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- node --test we:scripts/operations/__tests__/needs-you-feed.test.mjs` passes with new cases that fail on main, one per item above: spawn-only record does not settle; empty `findingClasses` does not clear a class-only card; a carried ruling without a live-head record does not settle; the fixed `**Red-team gate** ` fixture is parsed; an invalid override falls back to strict; a record without `result=` cannot settle a newer finding by index; a `card` line in a sent-back record does not settle.

## Non-goals

- [N1] Does not change how broken (non-degraded) breaks alarm, and does not change card filing itself.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Record and finding text is data; action lines are parsed by an anchored grammar.
2. **Truncated reads** — An unreadable or partial record leaves the finding unsettled.
3. **Shared state files** — Settlement re-reads the record after write and refuses if it changed.
4. **Fail closed** — Any unknown, unbound or unparsable record leaves the finding open and alarming.
5. **Identity scoping** — A record settles only a finding of the same head, round and result id.
6. **State over time** — A later retraction or failed filing reopens the finding.
7. **Who wrote it** — Only a record from the expected producer settles; a card line from a sent-back record does not.
