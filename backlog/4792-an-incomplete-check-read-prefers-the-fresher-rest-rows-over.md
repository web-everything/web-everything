---
bornAs: xd5465r
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-22"
preparedAgainstSha: "9bf5729aeac1239433a84d766cf8530fd3ed0d5e"
tags: []
---

# An incomplete check read prefers the fresher REST rows over the stale snapshot

Follow-up from the #3432 advisory (operator approved #3432, 2026-10-02). In `we:scripts/conveyor/reconcile-pass.mjs:1665`, an incomplete exact-head REST read can still select an older red or pending snapshot instead of the validated REST rows. Preserve known snapshot evidence only on read errors; use REST rows on an incomplete but valid read. Missing required checks must remain unchecked, never become an inferred pass.

## Progress

- Original premise/scope: the refusal branch at the formerly cited `we:scripts/conveyor/reconcile-pass.mjs:1022` discarded fresher REST rows; a snapshot cancellation followed by REST success was expected to read green. Scope named `we:scripts/conveyor/reconcile-pass.mjs` and `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`.
- Corrected premise/scope: the selection is now at `we:scripts/conveyor/reconcile-pass.mjs:1662-1665`. `result.incomplete` is set only when required names are absent and no relevant red/pending REST evidence exists (`we:scripts/conveyor/reconcile-pass.mjs:1633-1639`). Thus the defective case should become unchecked, not green. Complete successful REST evidence already supersedes the snapshot. The existing source/test scope remains sufficient; no reducer, REST reader, or required-check policy change is needed.
- Source evidence: `we:scripts/operations/pr-status.mjs:171-213` reduces missing required checks to unchecked after red/pending precedence. Existing tests in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1039-1066` currently require snapshot cancellation recovery for both transport failure and absent evidence; split those expectations. The latest-run collapse regression at `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1068` already covers superseded cancellations in complete REST rows.
- Observed with a network-free injected `runReconcilePass` probe: required names smoke/test, snapshot smoke CANCELLED, REST smoke success with test absent produced red, ci-heal, and check-read-failed; reducing the REST rows alone produced unchecked. Adding successful test to REST produced green, promote-draft, and no refusal. The defect is still present; the complete-green variant is already supported.

## Design

In `we:scripts/conveyor/reconcile-pass.mjs`, separate refusal reporting from evidence selection. Keep `check-read-failed` for read errors only and the `ci-trigger-owed` note for incomplete reads (`we:scripts/conveyor/reconcile-pass.mjs:1639-1647`, unchanged). At `we:scripts/conveyor/reconcile-pass.mjs:1665` change `(refused || neverStarted) && known` to `(refused || (neverStarted && result.rowsComplete !== true)) && known`. The read's own attestation (`rowsComplete`, set from `read.rowsComplete` and `read.rowsHead` at the cache write) separates the cases: a complete, head-attested read that lacks a required name means the check never started, so the REST rows win; an unattested (possibly truncated) incomplete read keeps the known red/pending snapshot so a cancelled run is never lost to truncation. Keep the `rowsComplete` clause `!(neverStarted && known)` at line 1662 unchanged (conservative: stays unattested) and comment why. Select the known red/pending snapshot only when `result.error` exists; on errors without that evidence select an empty rollup. Otherwise select the normalized `result.rows`, including an empty array or a valid incomplete result. Do not merge snapshot-only rows into REST: those rows could reintroduce stale failure or falsely fill missing required checks.

Retain exact-head validation, row validation, latest-per-name collapse, read deduplication, and the existing reducer. Update the adjacent comment to describe error fallback separately from incomplete-read handling. Keep the PR in non-CI planning regardless of refusal.

## MVP

1. Adjust the final evidence-selection condition and comment in `we:scripts/conveyor/reconcile-pass.mjs:1654-1665` so only read errors permit snapshot fallback.
2. In `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`, split the existing absent-evidence/transport-error regression and add stale cancellation and pending cases with validated but incomplete REST success. Assert the hydrated rollup at the injected enrichment boundary as well as the resulting plan.
3. Keep changes to the scoped source and matching test file. No new API, check-name policy, or recovery policy is required.

## Test plan

Extend `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs` with item-labelled cases:

- Snapshot smoke CANCELLED; REST smoke success; another required name absent: REST rows reach enrichment, state is unchecked, refusal remains visible, and neither ci-heal nor promote-draft is dispatched. Repeat with snapshot smoke IN_PROGRESS and with an empty REST array.
- Snapshot cancellation; all required REST names successful: green and promote-draft, without refusal. Keep the existing unordered duplicate-run success regression.
- Valid REST cancellation or pending evidence with another required name missing: preserve REST evidence and existing red/pending behavior; do not revert to snapshot evidence.
- Read exceptions, malformed rows, invalid SHA, and unreadable completed conclusions: preserve error refusal and known red/pending fallback; an otherwise green truncated snapshot remains unchecked and cannot promote.

## Proof plan

1. Add the item-labelled regression cases first in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`; run them against the unchanged source and capture the stale cancellation yielding ci-heal and the stale pending rollup surviving. Those are the expected pre-fix failures.
2. Apply the bounded source change and rerun the same cases; capture unchecked, no CI dispatch, preserved REST rows, and the visible incomplete-read refusal. Capture the complete REST success control and the transport-error cancellation fallback separately.
3. Run Vitest on `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs` and `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs`, then run `npm run check:standards`. Use repository-relative filesystem arguments when executing Vitest; the `we:` prefix here identifies the repository.
4. All proof uses injected readers and enrichers; no live GitHub mutation or actual heal dispatch is needed. Record actual results during implementation, not assumed passes during preparation.

## Edge cases this change must handle

1. Untrusted text — n/a: the change only picks between two already-validated in-memory rollups; no card/PR/CLI text reaches a note, shell, argv or path (the refusal `why` string is unchanged).
2. Truncated reads — a snapshot of 100 runs or a REST read that omits required names is never treated as green: incomplete valid REST rows stay `unchecked`; a read error still falls back only to known red/pending snapshot rows (`[A2]`, `[A3]`).
3. Shared state files — n/a: the per-pass `cache` Map is local to one `runReconcilePass` call; no file is written.
4. Fail closed — a read exception, malformed row, invalid head SHA or unreadable conclusion still yields `check-read-failed` and an empty rollup (or known red/pending snapshot), never green (`[A3]`); missing required checks never become an inferred pass (`[A2]`).
5. Identity scoping — n/a: cache key stays `${repo}/${sha}`; no key change.
6. State over time — a stale snapshot older than the REST read must lose to the exact-head REST rows; the next tick re-reads, so no repeat-suppression state is added (`[A1]`).
7. Who wrote it — n/a: no comment, label or ref grants trust here.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/reconcile-pass.test.mjs -t 4792` (repo-relative path) fails before the fix and passes after: with snapshot smoke CANCELLED (or IN_PROGRESS) and valid REST rows that are incomplete (smoke success, another required name absent, or an empty array), the PR gets no `ci-heal`, its hydrated rollup equals the REST rows, and state is `unchecked`. Before the fix `we:scripts/conveyor/reconcile-pass.mjs:1665` selects the snapshot and dispatches `ci-heal`.
- [A2] **Executable** — same command, case "complete REST success supersedes a snapshot cancellation": every required name successful in REST gives green and `promote-draft` with no `check-read-failed`; and an incomplete REST read never grants green or promotion, parameterized across source, docs, configuration and data file inputs.
- [A3] **Executable** — same command, error paths: a thrown read, malformed row, invalid SHA and unreadable conclusion still emit `check-read-failed`, still schedule `ci-heal` from a known CANCELLED snapshot and still hold on a known pending snapshot, and a truncated green snapshot yields no dispatch. The existing `xxh4zw8` error cases keep passing; the old "absent evidence keeps cancelled snapshot" row is split out so it now asserts `unchecked` (fails before the fix, passes after).
- [A4] **Executable** — same command: an incomplete valid read on a PR labelled `review:changes` still dispatches the non-CI `fix`, and a conflicting head with no observed required name still skips the read and refuses nothing.
- [A6] **Executable** — same command: an incomplete read whose rows are NOT attested complete (truncated, `rowsComplete` false) with a snapshot CANCELLED still dispatches `ci-heal` (fails if the fix drops the snapshot unconditionally).
- [A5] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/reconcile-pass.test.mjs we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs` (repo-relative paths) and `npm run check:standards` pass after the build.

## Follow-ups

None required for this bounded fix. Pagination, freshness comparisons across snapshots, required-check policy changes, and renaming the existing refusal kind are outside scope; raise separate work only if implementation exposes an additional defect.
