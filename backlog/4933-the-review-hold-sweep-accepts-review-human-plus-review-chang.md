---
bornAs: xv05fkj
kind: story
size: 2
status: resolved
scope: ["we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs", "we:scripts/lib/__tests__/gate-invariants.test.mjs"]
dateOpened: "2026-10-03"
dateResolved: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# The review-hold sweep accepts review:human plus review:changes as a valid pair

Follow-up to the operator's approval of #3657 (2026-10-03). #3657 makes a park to review:human keep an existing review:changes send-back, so human+changes is now a designed state. But planReviewHoldCleanup in we:scripts/conveyor/review-hold-reconcile.mjs (~line 107) still flags it as a contradictory verdict pair via findContradictoryReviewVerdicts, and decideContradictoryVerdictHeal returns unsupported-pair, so every sweep re-reports an entry nobody can act on (operator noise only; no label is removed). Fix: treat human+changes as valid in the contradiction check, and add a gate-invariants test that runs planReviewHoldCleanup over every label set decideParkToHuman can produce and asserts none is flagged.

## Progress

- Implemented and verified (2026-10-03, checkout baseline `22103ded6`). Only the sweep's flag input filters `review:changes` while `review:human` is live. The detector and heal function in `we:scripts/lib/review-escalation.mjs` are unchanged; the removal plan is unchanged.
- Before proof: added regression cases in `we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs` and INVARIANT 18 in `we:scripts/lib/__tests__/gate-invariants.test.mjs`, then ran both against the unchanged implementation. Six assertions failed (83 tests passed), including both park powerset invariants and the unwanted sweep entry.
- CLI replay, without helper files: supplied the Proof plan JSON through Bash process substitution (`--prs-file=<(printf '%s' '<JSON>')`) to `node we:scripts/conveyor/review-hold-reconcile.mjs sweep --dry-run` (drop `we:` to execute). Before: `{"checked":true,"changed":1,"results":[{"num":3657,"flagged":["review:changes","review:human"],"flagReason":"unsupported-pair"}]}`. After, identical fixture: `{"checked":true,"changed":0,"results":[]}`. Adding fixture PR #2767 with accepted+human+changes produced only `{"num":2767,"flagged":["review:accepted","review:human"],"flagReason":"genuine-clearance"}`; #3657 remained silent. These are fixture label replays, not claims about current live PR labels; comment history was read by the real CLI, and dry-run performed no writes.
- Regression/soak proof: both 16-subset park powersets pass. Additional cases pin pending cleanup and accepted+changes without human. A 100-sweep mixed-PR regression proves #3657 produces no entries or state reads while accepted+human+changes remains flagged on every fetch failure, with zero label writes or comments.
- Verification: `node we:scripts/verify-lane.mjs` passed all 464 tests across six affected suites, including the final 90 tests in the two scoped suites and the 100-sweep regression. `npm run check:standards` passed with 0 errors (5275 warnings); lane marker recorded green. No helper files or shared agent docs were created/edited.
- Premise checked against main (`e1f0523e0`). #3657 landed as merge `33cee1525`. `we:scripts/lib/review-escalation.mjs:1989 (decideParkToHuman)` now removes only `review:pending`, `review:redteam-accepted` and (unless `keepHumanClearance`) `review:accepted`. It keeps `review:changes`.
- The sweep still flags the pair. `we:scripts/conveyor/review-hold-reconcile.mjs:107 (planReviewHoldCleanup)` passes every live label to `we:scripts/lib/review-escalation.mjs:2016 (findContradictoryReviewVerdicts)`. That returns `[changes, human]`. Then `we:scripts/lib/review-escalation.mjs:2056 (decideContradictoryVerdictHeal)` returns `unsupported-pair`, and the sweep reports it at `we:scripts/conveyor/review-hold-reconcile.mjs:182`.
- Scope correction (narrower). The card says "every label set decideParkToHuman can produce" must be unflagged. That is too wide. With `keepHumanClearance: true` the park keeps `review:accepted` beside `review:human` by design (#3023). The sweep must keep flagging that pair, because the #2766/#2767 heal path depends on it (`we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs:80`). So the rule is: `review:changes` is never part of a flag when `review:human` is live. The accepted+human flag stays.
- Fix location. The detector `findContradictoryReviewVerdicts` stays unchanged. Its docstring says it "reports co-presence, not whether cleanup is safe". `INVARIANT 17` pins it over the full powerset (`we:scripts/lib/__tests__/gate-invariants.test.mjs:876`). The change belongs in the sweep's plan only.
- No live PR carries both labels right now (`gh pr list --label review:human --label review:changes` is empty). So the proof is a replay of the recorded shape.

## Design

In `planReviewHoldCleanup` (`we:scripts/conveyor/review-hold-reconcile.mjs:80`), point (3):

- Build the flag input from `afterHoldCleanup`. When `review:human` is in `names`, drop `REVIEW_LABELS.changes` from that input first. A send-back beside a human hold is a designed state since #3657. It is not a contradiction.
- Call `findContradictoryReviewVerdicts` on that filtered list. Everything else stays the same.
- Effects:
  - `{human, changes}` → `{ remove: [] }`, no `flagged` key. `needsReviewHoldCleanup` turns false, so the sweep skips the PR entirely.
  - `{human, changes, pending}` → `{ remove: ['review:pending'] }`, no flag.
  - `{human, changes, accepted}` → still `flagged: ['review:accepted', 'review:human']`. The heal path is unchanged. `decideContradictoryVerdictHeal` still sees the raw labels and heals or flags as before.
  - `{accepted, changes}` with no human → still flagged. Out of scope.
- Update the point (3) comment to say why `changes` is excluded when `human` is live (cite #3657).

Must lines:
- On error the sweep still refuses to remove anything it flags. This change only removes a flag. It never adds a label removal.
- `review:accepted` + `review:human` must still be flagged in every combination. The loosening covers `review:changes` only.

## MVP

1. Edit point (3) of `planReviewHoldCleanup` as above.
2. Add three cases to `we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs`.
3. Add one invariant block to `we:scripts/lib/__tests__/gate-invariants.test.mjs`.

## Test plan

Both files run under vitest (they import `describe, it, expect` from `vitest`).

In `we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs`, `describe('planReviewHoldCleanup')`:
- `it('does NOT flag review:changes beside review:human — a send-back under a human hold is designed (#3657)')`. Input `['review:human', 'review:changes']`. Expect `{ remove: [] }` with no `flagged` key. Also expect `needsReviewHoldCleanup(pr(1, ['review:human', 'review:changes']))` to be `false`.
- `it('still flags accepted+human when review:changes also rides along')`. Input `['review:accepted', 'review:human', 'review:changes']`. Expect `{ remove: [], flagged: ['review:accepted', 'review:human'] }`.

In the same file, `describe('sweepReviewHoldLabels')`:
- `it('skips a PR carrying review:human + review:changes — no entry, no readPrState call')`. One PR with those two labels. Expect results `[]` and `calls.readPrState` empty.

In `we:scripts/lib/__tests__/gate-invariants.test.mjs`, new block `describe('INVARIANT 18 — the review-hold sweep never flags a send-back the park preserved (#3657)')`. Import `planReviewHoldCleanup` from `we:scripts/conveyor/review-hold-reconcile.mjs` (relative import from the test's folder). Reuse the file's `powerset` helper and the four verdict labels.
- `it('keepHumanClearance:false — no park outcome is ever flagged')`. For each set in the powerset, apply `decideParkToHuman({ currentLabels: set, keepHumanClearance: false })` the same way INVARIANT 17 does. Assert `planReviewHoldCleanup({ currentLabels: after }).flagged` is `undefined`.
- `it('keepHumanClearance:true — only accepted+human is flagged, never review:changes')`. Same loop with `true`. Assert `flagged` never includes `review:changes`. Assert `flagged` is `['review:accepted', 'review:human']` (sorted) exactly when `after` includes `review:accepted`, else `undefined`.

## Proof plan

No live PR has the pair today. Replay the recorded shape through the real CLI:

1. Write a fixture PR list in the scratchpad: `[{"number": 3657, "labels": [{"name": "review:human"}, {"name": "review:changes"}]}]`.
2. Before (on main): run `node we:scripts/conveyor/review-hold-reconcile.mjs sweep --dry-run --prs-file=<fixture>`. It reports PR #3657 as flagged (`review:changes,review:human`, reason `unsupported-pair`).
3. After (on the lane): the same command prints no line for PR #3657.
4. Add a second fixture PR with `review:accepted`, `review:human`, `review:changes`. It must still be flagged after the change.

## Done when

1. **Executable** — `npx vitest run we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs we:scripts/lib/__tests__/gate-invariants.test.mjs` passes (drop the `we:` prefix when running). The new cases in `we:scripts/conveyor/__tests__/review-hold-reconcile.test.mjs` and `we:scripts/lib/__tests__/gate-invariants.test.mjs` fail on main before the change.
2. `planReviewHoldCleanup` returns no `flagged` key for `review:human` + `review:changes`.
3. `review:accepted` + `review:human` is still flagged in every combination, including with `review:changes`.
4. `findContradictoryReviewVerdicts` and `decideContradictoryVerdictHeal` are unchanged.
5. The proof-plan replay shows PR #3657's shape flagged before and silent after.

## Follow-ups

- `{review:accepted, review:changes}` with no human hold is still flagged as `unsupported-pair`. If that shape shows up live, file a card to decide its heal.
- Older card 4834 (changes wins, remove human) is superseded by the #3657 approval. It should be parked or closed against this card.
