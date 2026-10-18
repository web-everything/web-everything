---
bornAs: x6vzie0
kind: story
size: 2
status: open
scope: ["we:scripts/lib/numbering-carry.mjs", "we:scripts/review-set-label.mjs", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/lib/__tests__/numbering-carry-referral.test.mjs", "we:scripts/lib/__tests__/numbering-carry.test.mjs", "we:scripts/conveyor/soak/breaks/numbering-carry-unfinished-live-review.mjs", "we:scripts/conveyor/soak/breaks/numbering-carry-unfinished-live-review.soak.test.mjs", "we:scripts/operations/__tests__/parallel-judges.test.mjs"]
scopeRationale: "The shared guard's refusal codes are pinned directly and through the real re-stamp writer in we:scripts/lib/__tests__/numbering-carry-referral.test.mjs; its existing we:scripts/__tests__/review-set-label.test.mjs needs no edit. we:scripts/operations/__tests__/parallel-judges.test.mjs is a CI-heal on this PR: fake timers replace a wall-clock assertion that flaked under host load and blocked its CI."
dateOpened: "2026-10-17"
tags: []
---

# Numbering re-stamp checks referral evidence on the accepted prior head

Prove drain numbering, then check the accepted prior head whose review evidence exists and the live head for holds. Only the guard's explicit `MANDATORY_REFERRAL_NO_REVIEW_RUN` code permits carry from the clean prior head. A parked or pending live-head run retains its refusal without a referral record. Recheck proof and both heads before writes; failed reproof refuses even when referrals clear. This unblocks card-only numbering such as PR #5505 without clearing standing referrals. `review.numberingCarryReferralEvidence` defaults on, logs its source, and can restore previous behavior.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` (we:scripts/lib/__tests__/numbering-carry-referral.test.mjs; host heavy queue) proves clean prior-head carry, held/unproven refusal, #5505 card renames, write-time rechecks, and the setting off.

## Non-goals

- [N1] Change referral rulings, accept author edits, or broaden numbering proof to code, config, or unrelated data/docs edits.

## Edge cases this change must handle

1. **Untrusted text** — Existing referral authentication and exact numbering proof remain authoritative.
2. **Truncated reads** — Unreadable proof or referral evidence refuses carry.
3. **Shared state files** — n/a: no new persistent state or endpoint.
4. **Fail closed** — Held prior-head or live-head referrals, persistence failures, and unreadable referral evidence still refuse; unproven moves retain the live-head guard.
5. **Identity scoping** — Carry only the planned PR/repository and proven accepted-head → live-head pair.
6. **State over time** — Replan and recheck proof and referrals before each write.
7. **Who wrote it** — Keep existing acceptance and referral authorship checks.

## Risks

- A review on the numbered head can record a hold before re-stamping finishes. Checking the prior head alone would skip it; check both heads initially and before each write, including label-only recovery.
- A parked or pending live-head run without a referral record shares the missing-evidence message. Only the distinct no-run code permits carry; `we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` cases `refuses a %s live-head run without a referral record even when the prior head is clean`, `rechecks a %s live-head run that arrives before writing`, and `withdraws the new record if a %s live-head run arrives before labels` assert retry, zero writes or withdrawal, and no label write. `label-only recovery refuses an unfinished live-head run (arrives on recheck: %s)` asserts retry without writes on both checks.
- A live-head run that never finished `advise` (for example a failed referral publication) has no run evidence, yet it reviewed the live head. The guard reads every persisted `review-pr` run's head (`readReviewRunHeads`), so that run yields the unfinished-run code and blocks both carries. `persisted live-head run that never finished advise` cases replay it through the real run store before carry and before either write; `still carries numbering evidence when no run reviewed the live head` pins the positive path. A missing run store proves nothing either: it yields `MANDATORY_REFERRAL_RUN_STORE_MISSING`, which no carry overrides (`a missing run store is not proof that nobody reviewed the live head`). A run killed before `advise` blocks both carries until a finished review of that head exists.
  `we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` cases `default run readers refuse an unfinished %s live-head review through resolveRunsDir` omit both injected readers, set `OPERATION_RUNS_DIR` to a temporary real run store, and assert `MANDATORY_REFERRAL_UNFINISHED_REVIEW_RUN` for failed publication and absent verdicts before any diff carry. `default run readers carry clean prior evidence when no run reviewed the live head` pins the positive control through the same defaults.
- A proof can become unreadable after the initial check. A clearing referral guard must not replace that proof; retry without writing, or withdraw this pass's already-posted record before changing labels.
- Carry evidence only for the planned repository/PR and accepted-head → live-head pair. Setting-off and identical-net-patch paths keep their existing live-head guard without substituting numbering evidence.
  `we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` cases `identical-net-patch fallback guards only the live head before every write (numbering: %s)` and `identical-net-patch fallback refuses missing live-head evidence without writes (numbering: %s)` cover unproven numbering and disabled human numbering: `[TO, TO, TO]` on success, `[TO]` and zero writes on missing evidence. `identical-net-patch fallback refuses a live-head hold before write %s` checks both write-time guards and withdrawal before labels.
  `we:scripts/lib/__tests__/numbering-carry-referral.test.mjs` case `referral evidence %s guards the live head before every write` separately parameterizes `referralEvidenceSetting` enabled/disabled with clean current-head evidence. Both variants assert successful comment and label writes; enabled checks `[FROM, TO, FROM, TO, FROM, TO]`, disabled checks `[TO, TO, TO]`.

## Test plan

- `we:scripts/lib/__tests__/numbering-carry-referral.test.mjs`: held referrals on either head; live-head holds initially, before the comment, and before labels; label-only recovery; live-head persistence/read failures; clean current-head evidence.
- The same file pins unreadable, thrown, and negative write-time proof with clearing referral guards, zero writes before the comment, and withdrawal after the comment.
- The named identity-scoping test asserts every proof's exact `fromSha`/`toSha` and both guards' `{repo, pr}` context. The unreadable-initial-proof test asserts only the live head is guarded and no writes occur.
- `we:scripts/lib/__tests__/numbering-carry.test.mjs` retains the live re-read regression after both initial head checks.
- The parked/pending and net-patch cases named under Risks exercise the real referral guard through the re-stamp writer. The net-patch success uses the real identical-net-patch proof with fake read-only Git IO. `does not treat a matching error message as proof that no live-head review ran` pins refusal for an untyped error with the old message prefix.
- `we:scripts/conveyor/soak/breaks/numbering-carry-unfinished-live-review.mjs` replays parked/pending runs persisted before carry and before either write through the daemon's real run-store evidence reader and re-stamp writer. Its wrapper is discovered automatically by the soak registry. After the launcher commits the repair, run `we:scripts/conveyor/soak/red-green.mjs` with `--break=numbering-carry-unfinished-live-review` to prove both trees; this sandbox forbids the runner's Git writes.

## Prevention

Distinct no-run and unfinished-run error codes replace prose-prefix control flow here. Named fallback and unfinished-run regressions pin the repaired class. The broader deterministic Risks-to-tests validation requested in review is filed as `we:backlog/6272-require-named-observable-tests-for-backlog-risk-constraints.md`; it is not queued by this repair.

The production-default reader regression ships here; broader default-reader coverage enforcement is filed as [#6407](/backlog/6407-require-production-default-reader-coverage-for-security-guards/). The later advisory suggestions about card 6272's planned tests are filed as [#6408](/backlog/6408-name-rollout-and-diagnostic-tests-in-risk-validation-plan/), without implementing that follow-up in this repair.
