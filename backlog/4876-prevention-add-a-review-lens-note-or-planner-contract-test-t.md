---
bornAs: xor2ch2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/readiness/queue-report.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/readiness/__tests__/dispatch-plan*.test.mjs", "we:scripts/readiness/__tests__/queue-report.test.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-10-06"
preparedAgainstSha: "cc47a8e8dfc7a0ddc9a7142e4d94bdf9ab5cacd7"
tags: []
---

# Prevention — Add a review-lens note or planner-contract test that every per-item validation failure in dispatchPlan… (from chalbert/web-everything#3504 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4556-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:33` — Add a review-lens note or planner-contract test that every per-item validation failure in dispatchPlan must become a held entry (e.g. `invalid-kind`), never a throw, with a regression that a bad card does not stop a valid sibling from launching.
2. `we:backlog/4556-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:37` — Add a spec-checklist or review-lens rule: a runtime validator over a multi-item queue must hold or skip the offending item, not throw for the batch. A dispatch-plan test should also assert that a valid sibling still plans alongside an invalid-kind card.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3504@35a8d9b4ff3c6b8992f0c5b02bd6a9217fb42207

## Progress

- Original premise/scope: guard owed by #3504's review of card 4556 — an invalid per-item `kind` must become a held entry (`invalid-kind`), never a batch-stopping throw. `scope:` pointed at card 4556's Markdown file (a card, not code), which cannot hold a runtime guard.
- Corrected scope: the guard lives in we:scripts/readiness/dispatch-plan.mjs (HELD_REASONS at line 173, the per-item loop at line 476). Two held-reason consumers also need the new token: we:scripts/readiness/queue-report.mjs and we:scripts/conveyor/tick-core.mjs. Tests live in the dispatch-plan tests, the queue-report test and the tick-core test.
- Premise check on current main: no kind validation exists in `dispatchPlan` (no `invalid-kind` anywhere under scripts/); `BACKLOG_KINDS` is only a static check at we:scripts/check-standards-rules.mjs:234. Not already delivered. The guard is still owed.
- Relationship to card 4556: 4556's Design says an invalid kind throws a TypeError from `dispatchPlan`. This card is exactly the review ruling that overrides that choice: hold, never throw. Both edit the same source, so this card must build AFTER 4556 and replace its throw with a hold. No goal change; the card's own text names the required behavior.

## Proposed blockedBy changes

- add 4556 — same source file and it introduces the validation this card converts from throw to hold (we:scripts/readiness/dispatch-plan.mjs:476)

## Design

Runtime validation of an explicit item `kind` at the top of the per-item loop in `dispatchPlan` (we:scripts/readiness/dispatch-plan.mjs:476), against the existing `BACKLOG_KINDS` set (exported at we:scripts/check-standards-rules.mjs:234; the dispatch-plan source imports only `isGroupingKind` from that module at line 84, so add `BACKLOG_KINDS` to that import). An explicit `kind` not in the set is pushed as `held {num, reason: 'invalid-kind'}` and the loop `continue`s — it never throws, never launches, and consumes no lane, so valid siblings later in the same queue plan normally. Absent `kind` (loader failure, legacy callers) is NOT invalid and keeps today's fallthrough. If 4556 has already landed a TypeError, delete it and route through this hold instead; no throw may remain anywhere on the per-item path.

Wire-through so the new token does not itself crash a consumer: add `'invalid-kind'` to `HELD_REASONS` (:173) with an operator gloss constant (`INVALID_KIND_HINT`, "unknown item kind — fix the card's `kind:` frontmatter"); classify it in we:scripts/readiness/queue-report.mjs (which throws on unrecognized tokens, :104) as a needs-human/operator bucket; and leave `invalid-kind` OUT of `HELD_NOTE_EXCLUDED_REASONS` in we:scripts/conveyor/tick-core.mjs (line 167): it has no dedicated spawn route, so the generic held-note loop must report it to the operator (decided: surface, do not suppress). Spawns key on exact reasons, so none occur for it. Add a code comment on the held-reason vocabulary: "a validator over a multi-item queue holds or skips the offending item; it never throws for the batch." The doc row in we:scripts/conveyor/build-dispatch-policy.mjs (line 87) is parity documentation only; no change required.

## MVP

Musts: (1) `invalid-kind` hold in `dispatchPlan`; (2) `HELD_REASONS` token + queue-report classification (it throws on unknown tokens); (3) regression tests below. Should (droppable, not Must): the hint gloss constant and the vocabulary comment.
Out of scope: validating other frontmatter fields, changing the loader, changing the `BACKLOG_KINDS` enum, and rejecting at the loader boundary.

## Test plan

- we:scripts/readiness/__tests__/dispatch-plan.test.mjs: queue `[ {num:1, kind:'bogus', scope:[a]}, {num:2, kind:'story', scope:[b]} ]` → no throw; `held` has `{num:1, reason:'invalid-kind'}`; `launch` contains 2. RED today: item 1 launches (no validation), assertion on held fails. RED baseline is main without card 4556; the prepare-item/fix/ci-heal case below is RED today because the exemptions launch them, and after 4556 because they would throw. Either way it must end as a hold.
- Same shape with `kind:'prepare-item'`/`'fix'`/`'ci-heal'` as card kinds → each held `invalid-kind`, sibling still launches. RED today for the same reason.
- Guards (GREEN today, kept against regression, not RED cases): absent `kind` → not held `invalid-kind` (existing behavior preserved). All six `BACKLOG_KINDS` values never produce `invalid-kind`.
- `HELD_REASONS` contains `invalid-kind`; we:scripts/readiness/__tests__/queue-report.test.mjs: classifying `invalid-kind` returns a bucket and does not throw (RED: throws "unrecognized held reason"). we:scripts/conveyor/__tests__/tick-core.test.mjs: a plan with an `invalid-kind` hold surfaces a held note for it and spawns nothing (a guard on the decided surface-not-suppress behavior, GREEN today).

## Proof plan

Before: run the new dispatch-plan tests against current main and show the red failures (invalid item launches / no held entry). After: all pass. Live probe: a direct Node call of `dispatchPlan` with a bogus-kind row plus a valid row prints `held: [{reason:'invalid-kind'}]` and `launch: [valid]` with no exception, plus classifying `invalid-kind` through the exported classifyHeld function in we:scripts/readiness/queue-report.mjs returns a bucket instead of throwing (a one-line node import). Record commands and exit codes; run `npm run check:standards`.

## Follow-ups

- Loader-level reporting of malformed cards in `check:standards` (already partly covered by the static `BACKLOG_KINDS` check).
- A generic planner-contract test that fuzzes every per-item gate for no-throw, if a second throwing path is ever found.

## Done when

1. **Executable** — `npx vitest run the dispatch-plan, queue-report and tick-core test files` fails before this item lands (invalid-kind cases red) and passes after, and `npm run check:standards` passes.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
