---
bornAs: xxe02pm
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/__tests__/fix-procedure.test.mjs"]
dateOpened: "2026-09-28"
dateStarted: "2026-10-01"
dateResolved: "2026-10-02"
preparedDate: "2026-09-30"
preparedAgainstSha: "bc9db934c4b93158341ba01a74dccb71583765fc"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2860's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-procedure.mjs:213` — Add a fix-procedure test for reentrant draft-then-plain fix-begin. Alternatively, have `fix-end` read the live `isDraft` from `gh pr view` rather than trusting claim meta.
2. `we:scripts/conveyor/fix-procedure.mjs:213` — Add a deterministic test that acquires normally, reacquires with an explicit draft reason, checks persisted metadata and derived status, then verifies fix-end removes the reason label.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2860@6b9f7e181c254a05509ceadc175e2a0eb749153b

## Done when

1. **Executable** — `npx vitest run fix-procedure.test -t "reentrant draft-then-plain|reentrant explicit draft reacquire"` runs the two new cases below (zero tests matched before this lands, two green after), and the same file stays green in full.

## Premise check (2026-09-30, against `origin/main` bc9db934c)

Still real. `acquireFixClaim` (`we:scripts/conveyor/fix-procedure.mjs:213-216`) deliberately rebuilds `meta.draft`/`meta.reason` from the latest call and never merges them forward; `fixEnd` (`:631-633`) picks the label to drop from that persisted meta; `deriveReviewStatus` (`we:scripts/conveyor/review-status-tag.mjs:133-136`) reads the same meta. The `fixBegin / fixEnd` describe block (`we:scripts/conveyor/__tests__/fix-procedure.test.mjs:554-641`) covers plain, `--draft` and refusal paths, but no case re-calls `fix-begin` on a held claim with a different draft intent, and none checks persisted meta + derived status + `fix-end` label removal together. No commit on `main` mentions #4453 / `xxe02pm`. Citations (`:213`) are still accurate; scope unchanged (both files exist, only the test file is edited unless a test exposes a real bug).

## Design

Two deterministic cases added to the existing `describe('fixBegin / fixEnd — the IO shell')` block, reusing its `fakeGh` / `fakeLabels` helpers and the shared `root` lock dir. No source change is planned; the point is to pin the "latest `fix-begin` wins" rule at `we:scripts/conveyor/fix-procedure.mjs:213-216` plus its two readers (`fixEnd:631`, `deriveReviewStatus:135`). Cases drive `fixBegin` / `fixEnd` with an injected `gh` and label provider, read the persisted claim with `readLiveFixClaim`, and derive status with `deriveReviewStatus({ fixClaim: entry })` (already imported at test line 36). Item 1's alternative ("have `fix-end` read live `isDraft` from `gh pr view`") is NOT taken: the claim meta is the designed source of truth (header docblock, `we:scripts/conveyor/fix-procedure.mjs:30-33`) and the tests prove it is sufficient.

## MVP

Musts only:
1. **reentrant draft-then-plain**: same `who`/`sessionId`, `fixBegin({draft:true, reason:'scope-change'})` then `fixBegin({})` on the live claim (second view: `isDraft:true`, labels include `review-status:draft-scope-change`). Assert second result `reentrant:true`, `draft:false`, `reason:null`, no second marker comment, second label call `{add: FIXING_LABEL, remove:['review-status:draft-scope-change']}`, persisted meta `draft:false, reason:null`, derived status `{role:'fix', state:'fixing'}`, and `fixEnd` removes only `FIXING_LABEL`, reports `draft:false`, and issues no `gh pr ready`.
2. **explicit draft reacquire**: `fixBegin` plain, then `fixBegin({draft:true, reason:'withdrawn'})` on the same claim. Assert persisted meta `draft:true, reason:'withdrawn'` after the second call, derived status `{role:'fix', state:'draft-withdrawn'}`, exactly one `gh pr ready --undo`, then `fixEnd` removes `review-status:draft-withdrawn` (not the fixing label) and reports `draft:true, reason:'withdrawn'`.

Out of scope (see Follow-ups): any change to `fixEnd`'s source of truth, new CLI flags, other repair loops.

## Test plan

Both cases live in `we:scripts/conveyor/__tests__/fix-procedure.test.mjs` and are named "reentrant draft-then-plain …" and "reentrant explicit draft reacquire …" (the bare token "reentrant" already matches an existing test at line 62, so the filter must use the full names). Each case passes `sessionId` explicitly to every `fixBegin`/`fixEnd` (a session-bound claim needs no token), reads the claim with `readLiveFixClaim({…, nowMs: T0 + MIN})` (claims are written at T0 with a TTL), and calls `deriveReviewStatus({ pr, fixClaim: entry })` with `pr` set (the slug minter throws without it).
- Case 1 (draft→plain) asserts the meta is replaced, not merged. It would fail RED if `acquireFixClaim` carried `draft`/`reason` forward from the prior hold (status would read `draft-scope-change`, `fixEnd` would try to remove the draft label and report `draft:true`).
- Case 2 (plain→draft) asserts the new intent wins and `fixEnd` drops the matching label. It would fail RED if the meta were kept from the first hold (status `fixing`, `fixEnd` removes `FIXING_LABEL`, leaving the draft-withdrawn label stuck).
- Honest note: current behavior is correct, so these are regression guards that pass today; RED is demonstrated by a temporary mutation (merge-forward in `acquireFixClaim`), run once and reverted, recorded in the PR body.

## Proof plan

1. `npx vitest run fix-procedure.test` — whole file green with the two new cases.
2. Mutation proof: temporarily change line 216 to `draft: Boolean(draft) || Boolean(prior?.meta?.draft), reason: ...prior reason`, re-run the new cases and show only case 1 fails (case 2 passes under this mutation); then apply the stronger mutation `draft: own ? prior.meta.draft : Boolean(draft)` (same for `reason`) and show BOTH fail (case 1 reads draft-scope-change, case 2 reads fixing); revert and show green again. Paste before/after output in the PR body.
3. `npm run check:standards` green.

## Follow-ups

- If a live PR ever shows a label drifting from claim meta (e.g. a human edits labels mid-hold), consider having `fix-end` reconcile against the live label set — file only on evidence.
- Add a `fix-status` CLI assertion that `draftReason` tracks reentrant re-begin (CLI surface, `we:scripts/conveyor/fix-procedure.mjs` `:670-675`); not needed for the two owed guards.
