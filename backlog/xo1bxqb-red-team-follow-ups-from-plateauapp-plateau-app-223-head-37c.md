---
kind: story
size: 2
status: open
scope: ["we:src/wip/shared-source.ts"]
dateOpened: "2026-10-10"
tags: []
---

# Red-team follow-ups from plateauapp/plateau-app#223 (head 37c77c783)

Filed mechanically by the red-team gate: the post-accept red team on plateauapp/plateau-app#223 (reviewed head `37c77c783e3e34a435b990d5297e54e5bf39b864`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:src/wip/shared-source.ts:314` — (edge-case, degraded) A degraded history read permanently advances past missing sessions
   - Scenario: At 12:00, the initial history read returns rows: [] and degraded: ['review-history:unavailable']; a session actually ended at 11:00. The history source recovers before the 12:10 read. The wrapper nevertheless requests only --ended-within=660s, excluding that session, and publishes rows: [] with degraded: []. This was reproduced with the default window and margin. Subsequent safety polls also remain incremental, so they never recover the missing row. A degraded read must preserve the incomplete history window and retry it before reporting complete data.
   - Claude's re-check: 'cursor = start' is set whenever the output parses, and 'verdict.degraded' is never checked. The next read therefore asks only for the elapsed time plus the margin (~660s) and never recovers sessions missed during the degraded read.
2. `we:src/wip/shared-source.ts:219` — (edge-case, degraded) Direct reads bypass the rebuild floor and cancel pending notifications
   - Scenario: With minGapMs: 30000, complete a read at t=0, signal a change at t=100ms, then call read() at t=200ms. The probe performed a second rebuild immediately and removed the pending notification: two builds, zero callbacks, zero pending timers. Reconnects, periodic reads and refreshes can take this path before the scheduled notification. The floor currently constrains notification timing only, defeating the promised bound on expensive recomputation. Reads arriving before the deadline should reuse the cached value or await the scheduled rebuild while preserving required notification effects.
   - Claude's re-check: 'read()' rebuilds immediately whenever the source is dirty and nothing is in flight, and it ignores 'minGapMs'. 'consumeSignals()' then cancels the pending timer and clears 'firstSignalAt', so 'rebuilt()''s 'schedule()' has nothing to schedule. The result is an immediate second build and no scheduled notification.
3. `we:src/wip/shared-source.ts:307` — (edge-case, degraded) Resuming after a long pause publishes sessions outside the configured history window
   - Scenario: Complete an initial read, suspend the publisher for 48 hours, then resume with a history row that ended one hour after the initial read. The incremental request covers approximately 48 hours. Although the row is deleted from the done cache for exceeding the 24-hour cutoff, it remains in the current rows array and is published. The probe returned a 47-hour-old row with endedWindowMs: 86400000. Apply the cutoff to returned rows as well as cached rows, or cap the requested interval, so the advertised 24-hour window remains accurate.
   - Claude's re-check: Expired rows are deleted only from the 'done' map. The 'rows' array from the response is not filtered by the cutoff. After a 48h gap, a 47h-old done row in the response is still published with 'endedWindowMs' set to 24h.

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
