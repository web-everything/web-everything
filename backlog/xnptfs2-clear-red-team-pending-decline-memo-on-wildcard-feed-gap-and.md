---
kind: story
size: 1
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/__tests__/enqueue-catchup-dedupe.test.mjs"]
dateOpened: "2026-11-19"
tags: []
related: ["6664"]
---

# Clear red-team-pending decline memo on wildcard feed-gap and reset marks

we:scripts/lib/enqueue-on-event.mjs notePoll only clears declines for numbered PR marks; a wildcard feed-gap or reset mark (key *) leaves the head-scoped red-team-pending memo intact until its TTL. Clear all declines on such marks. Found by the audit of lane/drain-decline-memo-head.

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

## Duplicate admission

follow-up to the head-scoped decline memo
