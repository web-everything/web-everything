---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-team-feed.mjs", "we:scripts/lib/__tests__/red-team-feed.test.mjs", "we:scripts/conveyor/soak/breaks/redteam-feed-pending-never-queued.mjs", "we:scripts/conveyor/soak/breaks/__tests__/redteam-feed-pending-never-queued.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a mutation or branch-coverage check on lib modules that lists each conjunct in a guard chain.… (from web-everything/web-everything#7443 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-team-feed.mjs:46` — Add a mutation or branch-coverage check on lib modules that lists each conjunct in a guard chain. Until then, add the missing test: a 5-minute-old `updatedAt` with a false reader reading yields no row.
2. `we:scripts/lib/red-team-feed.mjs:47` — Add a review lens or checklist item: every `catch` that picks a safe default and every guard clause in a pure planner needs one named negative test.
3. `we:scripts/lib/red-team-feed.mjs:33` — Run the feed or daemon test against the real `rawPrs` producer or a snapshot of its shape. Alternatively, have the feed call `enrichPrsWithFixClaims` (or take an injected claim reader) and fail closed on `fixClaimUnknown`.
4. `we:scripts/lib/__tests__/red-team-feed.test.mjs:1` — Add a mutation or branch-coverage check on new pure planner modules, or a review-lens checklist item that every prose 'fail closed' claim has a test that throws or returns undefined.
5. `we:scripts/lib/__tests__/red-team-feed.test.mjs:59` — Add named operational checks with explicit concurrency and throughput assertions, and require every Acceptance target to reference a check in the preparation gate.
6. `(no file cited)` — Require each measurable Acceptance criterion to reference a named automated check or a recorded deployment measurement.
7. `we:scripts/conveyor/soak/breaks/redteam-feed-pending-never-queued.mjs:35` — Gate feeder integration changes on a saturation test with observable start counts and mutation checks for capacity enforcement.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7443@1145026a5634b4aaccda66da47b717de0043a43d

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
