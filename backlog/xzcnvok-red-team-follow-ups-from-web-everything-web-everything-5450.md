---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/nightly-coroner-job.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5450 (head a3461b9ae)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5450 (reviewed head `a3461b9aec1f26ff10023097f84bba67091e7a86`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/nightly-coroner-job.mjs:147` — (edge-case, degraded) Daily coroner notifications collide in the feed's unacknowledged-item index.
   - Scenario: Publish reports for 2026-10-16 and 2026-10-17 without acknowledging either, then start another operator session. The emitted events omit repo, pr, and head, so we:needs-you-feed.mjs keys both as undefined#undefined(at)undefined:coroner-ready. Its unacknowledged() consumer silently replaces the first notification with the second. A read-only probe running both extractions against an in-memory filesystem produced two reports and two feed lines, but unacknowledged() returned only we:coroner-2026-10-17.md. Each dated report should have a distinct event identity so every pending report survives session repl
   - Claude's re-check: The coroner event has only at, kind, report and reason. In we:needs-you-feed.mjs, parseFeedLine returns it, keyOf (line 81) builds 'undefined#undefined(at)undefined:coroner-ready' for every report, and unacknowledged() (lines 151-156) stores events in a Map by that key. The second report overwrites the first, so only the latest pending report is returned, although replay() still lists both.

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
