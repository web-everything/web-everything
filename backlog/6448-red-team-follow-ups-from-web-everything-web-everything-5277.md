---
bornAs: x4jhudd
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5277 (head f25321e3e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5277 (reviewed head `f25321e3ea57624959859b8748fa877ae8e326dd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:662` — (edge-case, degraded) Sibling completion restores catch-up work after a batching deferral clears it
   - Scenario: Reproduced with concurrency=3, capacity=3, an empty queue, and candidates #1–#5. Start #1–#3; finish #1 with a batching-deferred outcome, then finish #2 and #3 with skipReasons. Their completion callbacks increment catchUpRoom and refill pending with #4 and #5 despite batchingDeferred. The round logs its next opportunity in 600 seconds, but tick() five seconds later launches both retained PRs without another candidate listing. Deferred work should remain withdrawn until the next catch-up opportunity; sibling completions must not repopulate it.
   - Claude's re-check: The batching-deferral branch clears catch-up pending, but the sibling-completion branch (fastDrainUsedNoRoom) still does catchUpRoom++ and refillCatchUp() with no batchingDeferred guard. The refill code is unchanged and predates the flag. That repopulates pending, and the next tick() (a fresh run with batchingDeferred=false) starts those PRs before the next catch-up opportunity.
2. `we:scripts/lib/enqueue-on-event.mjs:719` — (edge-case, degraded) An event drain can start after kill() returns
   - Scenario: Reproduced with catch-up disabled and allowed() returning true: submit a due eligible event for #42, call tick(), pause its readPr promise, call kill(), then resolve readPr with an open ready-to-merge PR whose checks are finished. spawnImpl is called after shutdown. The post-read stopped check exists only inside the catch-up branch, so this ordinary event child escapes the shutdown kill sweep. Shutdown should prevent this child from starting, as the added testing guidance requires.
   - Claude's re-check: The added 'stopped' re-check after the async reads sits only inside 'if (p.catchUp)'. An event (non-catch-up) PR goes straight from readPr to attempted.add and finish(), which calls runChild and spawns. If kill() runs while readPr is pending, 'children' is empty and 'stopped' is set, but the spawn still happens. The loop-top 'stopped' check has already passed by then.

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
