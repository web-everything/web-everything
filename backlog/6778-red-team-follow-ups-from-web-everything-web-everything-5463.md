---
bornAs: xrgywav
kind: story
size: 2
status: open
scope: ["we:scripts/operations/needs-you-feed.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5463 (head 9e3d7874f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5463 (reviewed head `9e3d7874fcb9338ae5830ee7f121e6f9abb266e6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/needs-you-feed.mjs:66` — (failing-input, degraded) Polling clears and reopens unchanged round-cap alerts because the event keys disagree.
   - Scenario: A capped PR causes the notes daemon to publish an at-round-limit event with headRefOid. The next poll obtains its needsPerson row through needsPersonRow(), which omits both head and headRefOid, so itemsFromReport() supplies an empty head. Since feed keys include the head, polling clears the original event and opens a different, headless event. The next notes pass publishes the original key again. Reproduced using buildNoteComment(), needsPersonRow(), itemsFromReport(), and diffFeed(): an unchanged PR produced NEEDS-YOU-CLEARED followed by a fresh NEEDS-YOU. Both producers should use the same i
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/reconcile-pass.mjs:1914` — (edge-case, degraded) The queued blocked-check path overrides the new cancelled-shard cap and grants a second rerun.
   - Scenario: Use a ready-to-merge PR with mergeStateStatus=BLOCKED, a newer cancelled test-shard suite, and an older workflow rerun whose successful test and shard checks completed later. The planner consequently reads phase=queued while GitHub judges the newer cancelled suite. Supply cancelledShard=true evidence and a budget of confirmed=1, rejected=0, pending=false. A read-only probe through enrichPrsWithTimeoutEvidence() produced cap=1, but planReconcile() dispatched another ci-timeout-rerun with variant=blocked-cancelled and cap=2. The earlier queued branch hardcodes BLOCKED_CANCELLED_RERUN_CAP, bypass
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
