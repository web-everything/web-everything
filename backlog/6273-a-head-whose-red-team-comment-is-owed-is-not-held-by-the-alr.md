---
bornAs: x9jlvy0
kind: story
size: 3
status: active
scaffoldedBy: "redteam-comment-retry"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/review-dispatch.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/conveyor/soak/breaks/owed-red-team-release-consumed-by-planner.mjs", "we:scripts/conveyor/soak/breaks/owed-red-team-release-consumed-by-planner.soak.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# A head whose red-team comment is owed is not held by the already-reviewed hold

When a post-accept red-team result is saved but its PR comment is missing, the review daemon's 'already reviewed N time(s)' hold keeps the head from re-running, so the drain's red-team hold never clears (live: PR #5461, head 3373a33). Allow one review dispatch per repository/PR/head when a saved scorecard evidence row exists but no trusted we:red-team-advisory comment for that head is on the thread, so the run reaches resumeRedTeam. Planning checks eligibility without writing state; the dispatcher claims the allowance immediately before spawning, after CI, stack, capacity and cool-off gates. Setting redTeam.reArmOnMissingComment, default on. No job-log reader is added.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` fails before this item lands (owed head lifts once; comment present holds; other heads hold; setting off holds) and passes after.
- [A2] **Must** retain the hold on unreadable comments, settings, platform preferences, evidence or reservation state. Named cases in `we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs`: `keeps the hold when the comment snapshot is unavailable`, `keeps the hold if fetching the full capped comment thread fails`, `keeps the hold on a %s read error`, `keeps the hold when the tool setting is off and logs its source`.
- [A3] **Executable** — `applies owed-comment identity checks across file types` in `we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` pins trusted-author, repository, PR and exact-head checks for source, documentation, configuration and data changes (the example file for each is in the `acceptance-tests` manifest below). Each variant covers owed/posted/untrusted markers, mismatched evidence identities and markers for another PR/head. The exception depends on saved evidence and readable comments, never the changed file type.
- [A4] **Executable** — `does not spend the release through the fix daemon defaultReadNotesForRepo path` and `does not spend the release during non-review reconcile planning or ledger decisions` in `we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` assert repeated planning leaves no reservation; `releases on the first decision in a real Node process without asynchronous reader warmup` pins cold startup.
- [A5] **Executable** — `keeps the hold when a prior reservation exists with no receipt`, `keeps the hold after %s fails inside the reservation`, and `writes a temporary receipt before atomically renaming it at dispatch` in the same test file pin exclusive reservation and atomic receipt failure behavior.
- [A6] **Executable** — `reposts saved red-team evidence after hold release without invoking the model` in the same test file joins dispatch, review-job replay input and resumeRedTeam; it asserts the pinned comment posts and both model and recheck call counts stay zero.
- [A7] **Executable** — `we:scripts/conveyor/soak/breaks/owed-red-team-release-consumed-by-planner.soak.test.mjs` replays #5461 with repeated notes-only planning, a refused CI gate, one successful dispatch, and saved-row reposting.
- [A8] **Executable** — `preserves ledger-authorized releases that do not request an owed-comment exception`, `keeps ledger sameHeadToday decisions without a redTeam option read-only and fail-closed`, and `claims a standalone daemon tick by fetching comments when shared readers are absent` in `we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` pin both decision sources and both daemon read modes.
- [A9] **Executable** — `carries the owed-comment exception through the real reconcile planner` in `we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` covers pending and accepted labels, with and without an acceptance marker, and missing fast CI checks. `does not dispatch an accepted PR with an unavailable owed-comment exception` covers absent/spent evidence, posted comments, mismatched identity, holds and drafts. Acceptance remains on the planned row.
- [A10] **Executable** — the card-only variant of `reposts saved red-team evidence after hold release without invoking the model` and `defers saved card-only effects until acceptance during speculation` in `we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` cover restoring the card-only skip after evidence was saved. Saved effects resume before new-probe skip policy; speculative effects still wait for acceptance.
- [A11] **Executable** — `dispatches saved-result completion without running a review panel` and `refuses saved-result completion without a fresh model fallback` in `we:scripts/conveyor/__tests__/review-referral-hold-owed.test.mjs` pin job/session dispatch to deterministic replay, with no lane, jury, extra seats or verdict write. Missing/foreign evidence and moved/closed/draft/unreadable live heads refuse. `keeps the allowance unspent while %s is disabled` pins both red-team kill switches.
- [A12] **Executable** — `the runner refuses tokenless owed-head CLI reviews on every tick` exercises the runner's real review loop in job and session modes against an accepted owed head. Both CLI branches must use `dispatchCliReview`; repeated ticks spawn no full review and leave the allowance for the token-aware daemon. A7 also replays this consumer. `the plain CLI refuses unreadable or mismatched spawn authorization` and `the plain CLI preserves ordinary new-head reviews and explicit trusted re-arms` cover read failures, CI-head movement, and trusted versus untrusted wake events.
- [A13] **Executable** — `rejects owed-red-team dispatch identity independently of the claim guard` stubs the claim permissive and pins `owed-red-team-identity` for repo, PR, head, malformed head and CI-head mismatches with zero spawns. `retains the hold when capped-thread expansion reveals the posted marker` puts the trusted marker after comment 100 and requires enrichment and claiming both to refuse without reserving.

This is a local dispatcher receipt, with no HTTP receive endpoint or state-reset endpoint. Existing PR/comment and scorecard readers provide the inputs. The one-shot reservation bounds automatic dispatch attempts.

## Non-goals

- [N1] Does not change the drain red-team hold, or run any new model call.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only trusted marker authors count as posted; no comment text becomes a filesystem path.
2. **Truncated reads** — a capped comment snapshot is expanded; a failed expansion retains the hold, including dispatch revalidation.
3. **Shared state files** — only dispatch writes; exclusive mkdir arbitrates two dispatchers, followed by temporary receipt write and atomic rename. Empty reservations remain spent.
4. **Fail closed** — unreadable evidence, policy, comments or state keeps the hold. A failed receipt write, rename, or spawn leaves the attempt spent.
5. **Identity scoping** — filter evidence by repository and compare PR/head; hash repository, numeric PR and exact head into the receipt directory. CI must still name that head before dispatch.
6. **State over time** — repeated planning never spends an attempt. A reservation survives process restart, while another head has a separate allowance.
7. **Who wrote it** — trusted PR comment authorship uses the existing marker-authorship reader; only token-bearing review dispatches claim local state. Ledger/no-option decisions never consult the exception; independently authorized ledger reviews receive no claim callback.
8. **Tokenless consumers** — the runner's plain review-dispatch CLI cannot resume an owed effect. Both CLI modes re-read PR identity, comments and run evidence immediately before spawning and apply ordinary referral/same-head holds without the owed-comment exception. Unreadable inputs refuse; a token-aware daemon still owns completion.

## Review prevention coverage

PR #5510 round 5: A12 pins both CLI consumers of review plan rows so dropping the owed token cannot start a full panel. A13 tests the dispatcher identity guard independently of the daemon claim guard and pins successful capped-thread expansion. `keeps the A3 acceptance-to-test manifest aligned with its named cases and required variants` deterministically checks this manifest against A3's actual parameterized test cases and the four required input classes:

```acceptance-tests
{"A3":{"test":"applies owed-comment identity checks across file types","variants":[{"kind":"source","file":"src/example.mjs"},{"kind":"documentation","file":"docs/example.md"},{"kind":"configuration","file":"scripts/settings/example.json"},{"kind":"data","file":"src/_data/example.json"}]}}
```

## Risks and test plan

The critical race is a planning consumer or a second dispatcher taking the same allowance. A4/A5 pin those boundaries; dispatch skip and daemon wiring tests cover CI, stack, lane capacity, live jobs, cool-off, and a head that moves after planning. A6/A7 pin saved-result replay. A crash after reservation remains a deliberate fail-closed hold requiring operator recovery; it never grants an unlimited automatic retry.
