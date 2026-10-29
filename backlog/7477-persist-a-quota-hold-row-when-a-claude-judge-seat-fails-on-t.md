---
bornAs: xska8ze
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/lib/provider-quota-hold.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs"]
dateOpened: "2026-10-29"
tags: []
---

# Persist a quota-hold row when a Claude judge seat fails on the weekly limit

judge-spawn now tags a quota juror failure with .quota and .holdRow (we:scripts/lib/judge-spawn.mjs, we:scripts/lib/provider-quota-hold.mjs) but nothing writes that row to the seat scorecard, so the Claude seat is not held until the reset and the review run is not deferred or routed to the remaining seats. Persisting the row and the fallback/defer decision need we:scripts/operations/review-extra-seats.mjs, which PR 6056 held when this was split off. Start after 6056 lands. The parent change already excludes incomplete runs whose every failed seat carries failureKind provider-quota from the same-head cap.

## Acceptance

- [A1] **Executable** — a new test file `we:scripts/operations/__tests__/review-extra-seats.test.mjs` (or the existing one for that module) has a case where a Claude seat quota failure writes a quota-exhausted row; reset-time parsing is out of scope here (N1), so the row keeps quotaResetsAt null and the one-hour default cool-off applies.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the same-head cap accounting (done in the parent change) and does not parse the reset time out of the message: rows keep quotaResetsAt null and the one-hour default cool-off applies.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only error text matching the anchored weekly, daily, 5-hour or session limit message from the claude seat spawner is trusted.
2. **Truncated reads** — n/a: no reads are truncated by this change.
3. **Shared state files** — the scorecard rows are append-only through the existing seat writer.
4. **Fail closed** — an unreadable or unrecognised error writes no hold and the run counts as a normal failure.
5. **Identity scoping** — the hold is keyed by provider claude.
6. **State over time** — the hold ends after the one-hour default cool-off.
7. **Who wrote it** — n/a: rows come from the seat spawner, not from user text.
