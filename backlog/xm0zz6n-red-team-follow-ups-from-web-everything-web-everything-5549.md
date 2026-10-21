---
kind: story
size: 2
status: open
scope: ["we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5549 (head 71839eeca)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5549 (reviewed head `71839eecaa6b3bc9954edb4b10a7fe9834d6daf1`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:23` — (failing-input, degraded) The specified deduplication key does not match ended events
   - Scenario: An override entry-1 expires between polls. The producer appends its override-loosening-ended event, then crashes before saving the cursor. On restart, history returns entry-1 again. The specified feed-file check searches for operator-override#0(at)entry-1:override-loosening, but the persisted event has kind override-loosening-ended. The check therefore permits another ended event. An in-memory probe using the existing parser confirmed these are distinct keys. The deduplication check must recognize an already-published ended event as well as an active event, preserving exactly-once publication aft
   - Claude's re-check: demonstrated break
2. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:28` — (edge-case, degraded) A crash after publishing an active override can leave its alarm permanently uncleared
   - Scenario: Start with empty persisted openKeys. Publish an active override-loosening line, then crash before writing state. Let the override expire before restart. The next current view is empty, and persisted openKeys is still empty, so diffFeed emits no clear. The history rule also suppresses an ended event because the active key exists in the feed file. The original active event consequently remains open in unacknowledged() despite expiry or a safe replacement. A read-only probe of the existing diffFeed confirmed the missing clear for this state sequence. Recovery must reconcile appended active events
   - Claude's re-check: demonstrated break

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
