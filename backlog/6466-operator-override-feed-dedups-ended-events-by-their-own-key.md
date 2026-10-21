---
bornAs: xtip243
kind: story
size: 2
status: open
scope: ["we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md"]
dateOpened: "2026-10-18"
tags: []
---

# Operator-override feed dedups ended events by their own key (slice 4 of PR 5549, card 6265)

[A1] Executable. Red-team break (degraded) on PR #5549 head 71839eec, card 6265 line 23: the planned feed-file dedup check searches only the active key (operator-override#0@entry-1:override-loosening), but a published ended event carries kind override-loosening-ended, so a crash after appending the ended event and before saving the cursor republishes it on restart. Scenario: entry-1 expires between polls, the producer appends the ended event, crashes before the cursor save, history returns entry-1 again, the check misses the ended key, a second ended line is appended. Fix in the 6265 card text: the dedup must recognize an already-published ended event as well as an active one, with the named crash-replay test asserting exact feed-line counts and a rewritten-log replay. Also add the two named tests from referrals 6265:29 and 6265:75: 'a missing cursor replays history across default-sized pages without skipping ended events' and 'invalid identities preserve the history cursor and recovery delivers skipped ended events'.

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
