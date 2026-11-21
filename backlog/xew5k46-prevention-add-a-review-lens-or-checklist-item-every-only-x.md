---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:backlog/8622-clear-red-team-pending-decline-memo-on-wildcard-feed-gap-and.md", "we:scripts/lib/__tests__/enqueue-catchup-dedupe.test.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a review lens or checklist item: every 'only X, not Y' comment needs a paired negative-case t… (from web-everything/web-everything#7146 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/enqueue-on-event.mjs:1336` — Add a review lens or checklist item: every 'only X, not Y' comment needs a paired negative-case test. A deterministic gate is not practical here.
2. `we:backlog/8622-clear-red-team-pending-decline-memo-on-wildcard-feed-gap-and.md:20` — Extend the existing card-lint gate so a status:open card with TODO placeholders in Acceptance cannot merge, if it does not already check this.
3. `we:scripts/lib/enqueue-on-event.mjs:1336` — Record a per-PR lastEventAt on notePoll. Have the decline-recording path skip the memo when lastEventAt > startedAt, and add a daemon test that sends an event mid-drain.
4. `we:scripts/lib/__tests__/enqueue-catchup-dedupe.test.mjs:44` — Parameterize the shared evidence tests (TTL, labels, checks and missing-evidence fail-open) over every member of CATCH_UP_DECLINE_DEDUPE_KINDS, with a guard test that iterates the exported set. Adding or reclassifying a reason would then fail the build until it has coverage.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5590.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7146@95212397533c8061a614906875f2f525734c8281

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
