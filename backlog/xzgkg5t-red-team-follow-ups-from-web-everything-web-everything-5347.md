---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/merge-queue-adaptive-batching.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5347 (head 1037d9131)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5347 (reviewed head `1037d9131a63b58316c4ed73ac0b67bfd638d769`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/merge-queue-adaptive-batching.mjs:143` — (edge-case, degraded) Stale singleton history cancels isolation required by a later failed group.
   - Scenario: Reproduced with direct Node assertions: observe queued group [1,2] with closed={2} and inQueue={1}; recovery records recoveryRetired=[1] and dequeues #1. After dequeue, re-admit #1 alongside #3, observe both queued, then observe both ejected. The new failure correctly sets isolate=[1,3]. Calling admitEnqueue for #1 with an empty queue then matches the OLD singleton recovery record, removes #1 from isolation, and refuses its retry with reason 'isolating culprit among #3'. Expected: preserve the newer two-member isolation and admit #1 into a singleton recovery group. Removing only the old failed
   - Claude's re-check: healSoleSurvivors (we:scripts/lib/merge-queue-adaptive-batching.mjs:~139) removes any non-queued isolate member if ANY failed group has recoveryRetired of length 1 equal to it. The old sole-culprit group keeps recoveryRetired=[1] while status stays failed within the failure window. After a later group [1,3] fails and sets isolate=[1,3], admitEnqueue for #1 with an empty queue matches the stale record. It drops #1 from isolate and wrongly marks #1 a culprit. That leaves isolate=[3], so #1 is refused. The heal check is not tied to the group that produced the current isolation, so the claim holds.

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
