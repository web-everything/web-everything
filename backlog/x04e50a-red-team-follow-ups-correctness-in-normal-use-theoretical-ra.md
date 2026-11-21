---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, theoretical-race] from web-everything/web-everything#7146 (head 3e860335d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7146 (reviewed head `3e860335db158eda5d8c7c26616fa18bbeee63e0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:667` — (failing-input, degraded) Transient red-team read failures now survive main CI changes
   - Scenario: A ready PR has complete listing evidence, but its fast drain receives an HTTP 503 reading red-team checks. readRedTeamCheckFact returns an unreadable result, which checkRunAdmission classifies as red-team-pending and the daemon memoizes. Restore the endpoint, leave the PR unchanged, and advance mainCiRunId from 100 to 101 before the memo expires. Catch-up now skips the PR instead of retrying the recovered read. Transient unreadable results should remain retryable rather than receiving main-independent suppression for up to the memo TTL.
   - Class: correctness-in-normal-use (basis: Source trace: we:red-team-check-run.mjs catches read errors; we:drain-merge-strategy.mjs returns those errors as red-team-pending; we:scripts/lib/enqueue-on-event.mjs memoizes that kind without excluding unreadable evidence. Runtime reproduction was blocked by missing dependencies.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/enqueue-on-event.mjs:1335` — (edge-case, degraded) Feed gaps preserve a memo whose invalidating event may have been lost
   - Scenario: Remember a red-team-pending decline, then lose a clearing review/comment event during a feed gap while head, labels and checks remain unchanged. Pass notePoll a successful poll containing key '*' with cause 'feed gap (events pruned before read)', then run catch-up with a newer main CI run. parseMarkKey rejects '*', so the memo survives and the new main-independent comparison suppresses another drain until expiry or other recovery. A gap or reset should invalidate these memos because numbered event delivery is no longer assured. The added backlog card acknowledges this unresolved case.
   - Class: correctness-in-normal-use (basis: The feed consumer emits wildcard marks for gaps and resets; the new invalidation loop ignores them. Lost comment events need not change the evidence digests. This is source-established behavior, not a completed runtime reproduction.)
   - Also class: theoretical-race
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
