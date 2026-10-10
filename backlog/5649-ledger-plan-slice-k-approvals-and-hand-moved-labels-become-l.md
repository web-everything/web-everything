---
bornAs: x72nwuy
kind: story
size: 2
priority: high
parent: "3007"
status: open
blockedBy: ["5355"]
scope: ["we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs"]
dateOpened: "2026-10-09"
preparedDate: "2026-10-10"
preparedAgainstSha: "ab01c2a20c0bf8446f55fa079c48e68a8d000bed"
tags: []
---

# Ledger plan slice K: approvals and hand-moved labels become ledger events (tighten-only)

Slice K of the verdict-ledger plan (#3007), D5 ruling. Clearing ceremonies in we:scripts/review-set-label.mjs and the judge append an approval event (with delegation); the label mirror we:scripts/conveyor/pr-label-mirror.mjs records a hand-moved label as a label-input event that only counts if it tightens. Use the judge block planned by #5072/#5074, not a second shape. Done when an operator removing review:human by hand is restored by the mirror with a label-input row, and a judge clear writes an approval row. Depends on G1 (#5355) and the v2 event types (slice B), both delivered.

## Design

What exists already (do not rebuild): the v2 event types `approval` and `label-input` with their schemas (we:scripts/lib/verdict-ledger.mjs:539-553, payloads at :596-612), and the derive side that reads them (`approvalValid`/`approvalLiftsAfter`, we:scripts/lib/pr-state/holds/verdict.mjs:12-24; the `label-input` hold, we:scripts/lib/pr-state/holds/label-input.mjs:12-23; human-gate use at we:scripts/lib/pr-state.mjs:57,108). What is missing is the two WRITERS: no non-test code under we:scripts builds either event today.

**Part 1 — approval rows at the label home.** In `runReviewLabelCli`, right after the verdict append (we:scripts/review-set-label.mjs:1368-1395), when `to` is `clear-human` (only then; an ordinary `accepted` is a verdict, not an approval), append `buildLedgerEvent({type:'approval', approval:'clear-human', delegation:null, …})` with the same repo/pr/at/source/declaredActor/session/channel as the verdict row, through the same store path `appendVerdict` uses (it takes any row validated by `validateLedgerEvent`). The judge route already calls `clear-human` with the judge as actor (#5072 rule 3), so the row carries `approval:'judge'` when the caller passes a new `--approval-kind=judge` (closed set `APPROVAL_KINDS`, default `clear-human`) and an optional `--delegation-json` object `{by, scope, expires}` checked by the existing `delegationOrNull` shape (we:scripts/lib/verdict-ledger.mjs:567-573). That object IS the judge block: K introduces no second shape; the judge runner passing it is #5072's own work. The `clear-human` verdict row already clears on its own (`CLEAR_HUMAN` is clearing), so the approval row is the audit record and the lift for a hand-added `label-input` hold on a stale head, not what stops the mirror re-adding `review:human`. F4 is extended anyway: a refused approval append for `clear-human` blocks the swap (reusing `clearingLedgerMiss`), so a clearance never lands without its audit row. The two appends are not atomic: if the verdict lands and the approval append fails, the swap is refused and the retry appends a second clearing verdict row, which is harmless (clearing is idempotent); a test pins that the retry succeeds.

**Part 2 — label-input rows from the mirror.** we:scripts/conveyor/pr-label-mirror.mjs gains, per open PR, a read of the PR's `LabeledEvent`/`UnlabeledEvent` timeline items for the four `HOLD_LABELS` (we:scripts/lib/pr-state/holds/label-input.mjs:4), with actor login and `createdAt` (the GraphQL shape at we:scripts/lib/pr-state-io.mjs:98, extended with `UnlabeledEvent` and `actor { login }`). The mirror runs this timeline read only for PRs where the derive wants `review:human` and the PR lacks it, or the PR carries a hand-added hold label (no extra per-PR cost elsewhere), with its own GraphQL query in we:scripts/conveyor/pr-label-mirror.mjs including `pageInfo { hasPreviousPage }` (we:scripts/lib/pr-state-io.mjs is not touched). Any change whose actor login differs from the login `gh api user` returns for the mirror's own run, and that is not already ledgered (best-effort idempotency key: repo + pr + label + change + timeline `createdAt`, checked against a fresh ledger read; no locked check-and-append exists, so two concurrent passes may append a duplicate, which is harmless to the derive) becomes a `label-input` row `{label, sender: actor login, change}`. Only `added` rows can hold (the reader ignores `removed`: tighten-only); a hand REMOVAL of `review:human` is recorded as `change:'removed'` for the audit trail and changes nothing in the derive.

**Part 3 — the restore.** The `removed` row is an audit record; the restore itself comes from the derive. A hand-removed `review:human` is still held by the ledger (the `human` verdict hold), so `derivePrState` still derives `review:human` and G1's compare already plans it as an ADD. K gives the mirror a write mode for exactly that: `--apply` adds ONLY labels of the `review:human` family that the derive wants and the PR lacks (one family at a time, as the D5 ruling and slice G2 do for `advisory:ruling-needed`); it never removes a label, so it can only tighten. Without `--apply` the behaviour is G1's report mode, byte for byte. Order: the label-input row is appended BEFORE the label add, so a crash between the two leaves a row and the next pass restores.

## MVP

Musts only:
1. `clear-human` appends an `approval` row (kind `clear-human`, or `judge` plus an optional validated delegation) next to the verdict row; failure is fatal and the label is not swapped.
2. The mirror appends `label-input` rows for hand-moved hold labels, idempotently, ignoring its own writes.
3. The mirror `--apply` re-adds a derived-but-missing `review:human` (add only), after appending the audit label-input row for the removal. If the PR's current verdict is not `human`, the derive wants no `review:human` and the mirror correctly does nothing (a test pins this).

Deliberately OUT (see Follow-ups): label-input handling for `review:accepted`/`ready-to-merge`, mirror writes for any other family, the judge runner passing the delegation (#5072), the daily digest (#5074), running the mirror on a tick.

## Test plan

In we:scripts/__tests__/review-set-label.test.mjs:
- `clear-human appends an approval row after the verdict row` — asserts the injected ledger sink gets one `type:'approval'`, `approval:'clear-human'`, `delegation:null` row with the verdict's actor/session. RED today: no approval row is built.
- `--approval-kind=judge with a valid delegation is stored; a malformed delegation is refused before any write` — asserts the row and the refusal. RED today: the flag does not exist.
- `a refused approval append blocks the swap` — asserts exit 1 and no label call. RED today: nothing appends it.
- `accepted and changes append no approval row` — only `clear-human` writes one (guards the ordinary-reviewer path).

In we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs:
- `a hand-removed review:human becomes a removed label-input row and is restored (--apply)` — fixture: ledger holds a `human` verdict, live labels lack `review:human`, timeline shows an Unlabeled by a non-mirror actor; asserts one `label-input removed` row appended BEFORE exactly one add of `review:human`. RED today: no row, no write path.
- `a hand-added review:human becomes an added label-input row` — asserts the row, and that `derivePrState` then holds `label-input:review:human`.
- `the mirror's own label write is never re-ledgered` — actor equals the mirror identity; zero rows.
- `idempotent: the same timeline event on a second pass appends nothing`.
- `report mode (no --apply) makes zero gh writes and appends zero rows` — keeps G1's contract; G1's "source holds no label-write call" test is narrowed to "no write call outside the `--apply` branch".
- `--apply never removes a label` — fixture with an extra live label; the remove set is never sent.
- `a truncated or unreadable timeline plans no write and no row`.
- `a PR whose current verdict is not human gets no review:human add even after a hand removal`.
- `clear-human: verdict lands, approval append fails -> swap refused; the retry succeeds`.
The new mirror entry point is `runMirrorApply`, an export that does not exist today; each mirror test's RED reason is the missing write path, asserted by first running the same fixture through the report-mode export. `accepted and changes append no approval row` and the report-mode zero-writes test are guards that pass today and are labelled as such.

## Proof plan

Live, on a real repo with a throwaway PR parked `review:human` by a real verdict row. (1) Before: `node we:scripts/conveyor/pr-label-mirror.mjs --json` shows the PR in sync; remove `review:human` by hand with `gh`; the report now lists `add [review:human]` (today's G1 baseline, no write). (2) After: `node we:scripts/conveyor/pr-label-mirror.mjs --apply --json` prints one label-input row and one add; `gh pr view --json labels` shows `review:human` back; `node we:scripts/review-ledger-check.mjs` reports the PR in agreement; the home ledger file holds the `label-input removed` row. (3) A `clear-human` run on the same PR through we:scripts/review-set-label.mjs writes an `approval` row (read it back from the ledger file) and the mirror then plans nothing. The throwaway PR gets its `human` verdict row from `node we:scripts/review-set-label.mjs --to=changes` after parking it with the `review:human` label via the sanctioned park path; expected output literals (the `label-input removed` row JSON and the checker's agreement line) are captured in the PR body.

## Edge cases this change must handle

1. **Untrusted text** — label names are matched against the closed `HOLD_LABELS` list before use; the sender login and the `--delegation-json` strings go through the schema's `oneLine` fold in `validateLedgerEvent` and never reach argv or a shell; `--approval-kind` is a closed set and `--delegation-json` is JSON-parsed, so a value starting with `--` is refused. Test: a login with a newline and backticks is stored folded.
2. **Truncated reads** — the timeline read is windowed; if it reports earlier pages unread, the PR is `unreadable` for label-input purposes (nothing appended, nothing restored), never "no changes". A PR-list `--limit` hit stays an error as in G1. Test: `a truncated or unreadable timeline plans no write and no row`.
3. **Shared state files** — two mirror passes at once, or the mirror racing a `clear-human` run: appends go through `appendVerdict`'s existing lock + atomic store; the idempotency key is re-checked against a fresh ledger read just before append (compare-and-set), so repeat passes across ticks append nothing new; two truly concurrent passes may append one duplicate, which the derive ignores. Test: idempotency case above (sequential passes).
4. **Fail closed** — an unreadable ledger, unreadable timeline or failed append means NO label write and a non-zero exit naming the reason. A failed approval append for `clear-human` refuses the swap (F4). An unparseable `--delegation-json` is a refusal, never `null`.
5. **Identity scoping** — every row and idempotency key is scoped by repo + PR number (+ label, change, timeline timestamp); the derive's `scopedEvents` already drops other PRs' rows. Card-id spellings: n/a, only PR numbers are used.
6. **State over time** — label-input rows are not head-bound: they hold until a later valid approval or a covering clearing verdict (the existing reader), and an expired delegation lifts nothing (default deny, `approvalValid`). Repeat suppression across ticks is the idempotency key. Restart mid-operation: row-then-add order (Part 3) means a crash leaves a row and a missing label, repaired next pass.
7. **Who wrote it** — a label change is hand-made only if its timeline actor is not the mirror's own identity; the mirror cannot tell its own login from the operator's when they share an account, so a hand change by that login is NOT recorded (fails toward fewer holds, stated residual); a bot or missing actor is treated as NOT hand-made for `removed` and as hand-made for `added`. `--apply` adds only `review:human`, never `advisory:ruling-needed` (that family is G2, #5647). An `approval` row is written only by the label home after the `clear-human` guards (`review:human` present, `--actor` and `--reason` required); the mirror never writes an `approval`.

## Follow-ups

- Label-input handling for `review:accepted` / `ready-to-merge` families (a hand-ADDED clearing label must never count; needs its own rule).
- The judge runner passing the delegation block (#5072) and the daily digest of judge clears (#5074).
- Running the mirror `--apply` on the conveyor tick, sharing one apply path with G2 (#5647).
- Mirror write mode for the remaining families, one per slice.

## Progress

- 2026-10-10 prepare pass: premise holds on `main` (ab01c2a). No commit delivers a writer for `approval` or `label-input` events; the mirror is still G1 report-only (77 lines, zero writes). Corrected a stale premise: #5072 and #5074 are still open, so K reuses the `{by,scope,expires}` delegation object already in the schema (we:scripts/lib/verdict-ledger.mjs:567) instead of waiting on a judge block. Scope and size 2 unchanged.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/__tests__/review-set-label.test.mjs we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs` fails before this lands (the new approval and label-input cases are RED) and passes after; `node we:scripts/conveyor/pr-label-mirror.mjs --json` without `--apply` still makes zero writes.

## Non-goals

- [N1] No `review:accepted`/`ready-to-merge` label-input handling, no mirror writes beyond adding `review:human`, no judge-runner changes, no tick wiring (see Follow-ups).
