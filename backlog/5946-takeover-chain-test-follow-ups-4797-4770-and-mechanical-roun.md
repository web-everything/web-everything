---
bornAs: x55mese
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/__tests__/ruling-not-addressed.test.mjs", "we:scripts/conveyor/__tests__/fix-takeover.test.mjs", "we:scripts/conveyor/__tests__/mechanical-rebase-rounds.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-18"
preparedAgainstSha: "13aeeba0dcceb3bb339ac0d408cd672c797d3ec7"
tags: []
---

# Takeover-chain test follow-ups (#4797/#4770) and mechanical rounds for drain rebases

Held finding 233 requested enabled-takeover negative authorization tests, launch-attempt coverage for borrowed and wrapped launchers, and exclusion of mechanical base refreshes from review-round spend. The last behavior is now implemented; finish the two remaining coverage gaps and retain that mechanical regression.

## Progress

- Rechecked against 37d55ee65: the prior test-only premise remains correct. The production launch sites moved to `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1527` and `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1591`; the current failure harness at `we:scripts/conveyor/__tests__/fix-takeover.test.mjs:439` still injects only the ordinary launcher. The disabled negative cases remain at `we:scripts/conveyor/__tests__/ruling-not-addressed.test.mjs:160` and `we:scripts/conveyor/__tests__/ruling-not-addressed.test.mjs:228`. Scope and size 2 stay unchanged; this recheck does not refresh runner-owned stamps.

- Current-checkout recheck at 6d77e9169: retain test-only scope and size 2. Some negative cases now use the enabled harness, but the partial/old-head pair at `we:scripts/conveyor/__tests__/ruling-not-addressed.test.mjs:160` and forged/auto-policy pair at `we:scripts/conveyor/__tests__/ruling-not-addressed.test.mjs:228` still use disabled defaults. Preserve the enabled withdrawn-ruling and truncated-thread regressions already present. Borrowed/wrapped launch-attempt assignments remain at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1527` and `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1591`; this remains a coverage task, not an implementation rewrite.

- Checked at 17242a56d. Original scope was `we:scripts/conveyor/mechanical-round-cap.mjs` and `we:scripts/conveyor/reconcile-core.mjs`, with no tests. Corrected scope is test-only: the remaining work is in `we:scripts/conveyor/__tests__/ruling-not-addressed.test.mjs` and `we:scripts/conveyor/__tests__/fix-takeover.test.mjs`; include `we:scripts/conveyor/__tests__/mechanical-rebase-rounds.test.mjs` for preservation coverage. No production behavior change is justified by the observed gaps.
- Mechanical-round delivery is commit 9596b78f1, subsequently hardened by ba1c61683, d152470dc and 6aa1cdfaa. `we:scripts/conveyor/mechanical-round-cap.mjs` now exports `readRoundCommits`; `we:scripts/conveyor/reconcile-core.mjs:515` distinguishes real work from a mechanical merge. Existing real-Git tests at `we:scripts/conveyor/__tests__/mechanical-rebase-rounds.test.mjs:229` cover clean/drain merges versus repair, reverted-upstream and manifest edits. This is partial delivery, not grounds to stop the whole card as already done.
- Negative ruling cases still call `planAt` with takeover defaults off (`we:scripts/conveyor/__tests__/ruling-not-addressed.test.mjs:228`), while `planOn` at line 136 enables them. The new-head case at line 264 also directly invokes the planner without enabled takeover settings. Those tests can pass without exercising the intended authorization guard.
- `launchAttempted` is already set before borrowed launch at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1527` and wrapped launch at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1591`. Existing failure coverage in `we:scripts/conveyor/__tests__/fix-takeover.test.mjs:439` principally injects `spawnAgent`; it does not pin those two branches.
- Retain size 2: about 60 changed ruling-test lines, 130 launch-test lines and 25 mechanical-test lines (only if a named refresh scenario needs an explicit preservation assertion). All scope entries are tests. No stamps or dependency edits.

## Design

Make each negative authorization test explicitly enable takeovers using the existing `planOn` harness, or the same `TAKEOVER_ON` settings for tests needing a different head. Assert both absence of a directed takeover and the precise refusal/reason where available. Pair negatives with the same otherwise-eligible trusted ruling so the fixture proves it can dispatch. Keep the intentional disabled-setting test separate; enabling takeovers must not accidentally make forged, stale, partial or policy-authored rulings authoritative.

Parameterize the existing `dispatchFix` failure harness in `we:scripts/conveyor/__tests__/fix-takeover.test.mjs` for borrowed and wrapped paths, using the actual route-selection inputs and injected `spawnBorrowed`/`launchWrapped`. Assert the intended launcher was reached and the others were not. Pin the current contract: pre-launch failure or a proven-not-started failure voids the takeover marker; a timeout/indeterminate launch preserves it so another takeover cannot start; the claim is released and the original error remains visible. A successful handle preserves the marker and the live claim. No production router-policy change is part of this test addition.

Keep mechanical-round behavior as preservation: clean drain rebases, base refresh merges and restacks spend no real fix round when Git proves they bring no new work. An edit hidden in a merge, a repair branch, incomplete history, unreadable evidence or untrusted marker cannot earn that exemption. Use the existing real-Git harness, not subject-name-only fixtures.

## MVP

- Enable takeover settings in all negative authorization cases intended to exercise ruling guards, with a positive eligible control.
- Cover pre-launch, proven-not-started, indeterminate and successful borrowed/wrapped launch outcomes, asserting marker and claim effects.
- Run the existing mechanical-round regression, adding only an uncovered refresh/restack assertion if needed; do not reimplement the delivered counter.

## Test plan

Run the three scoped files through Node on `we:scripts/readiness/heavy-admission.mjs`, using `run -- npx vitest run` followed by filesystem test paths (without documentation repo prefixes).

Ruling matrix: forged login, auto-policy actor, wrong head, incomplete finding coverage, no ruling, spent directed grant and valid eligible ruling, all with automatic takeovers enabled. Verify refusal behavior for source, docs, config and data findings alike; authorization is not file-type dependent.

Launcher matrix: borrowed and wrapped, each with a setup error before launch, definitive non-start, timeout without proof of non-start, and success. Count marker, void, release and launch calls and assert ordering. Stub filesystem, prompts, session IDs and claims into isolated fixtures so no actual worker or forge action occurs. Existing ordinary-fix/no-marker cases stay green.

These are coverage repairs and some tests may already pass on correct production code. Demonstrate sensitivity with temporary mutations: bypass the ruling guard, and separately remove each branch's `launchAttempted = true`; the respective negative and timeout tests must fail. Restore mutations before finishing. Mechanical tests must fail if a clean drain rebase is counted as work or a repair hidden in a merge is refunded. Run the standards gate through the same heavy queue.

## Proof plan

Retain test output for each launcher branch and each enabled authorization negative, plus mutation failure/restoration results. Record the real-Git mechanical fixture's observed round count. No live takeover is necessary or authorized for this coverage-only change. Report already-green preservation distinctly from tests that expose missing guard coverage; do not claim every new test fails on the unmutated implementation.

## Non-goals

No extra takeover entitlement, cap increase, launch-policy change or new interpretation of mechanical work. No production edits unless a failing test exposes a separately reviewed defect.

## Edge cases this change must handle

Forged markers/rulings remain untrusted. Truncated threads and shallow Git history refuse additional allowances. Test state and claims are isolated; no live shared files are touched. Identity stays bound to repo, PR, head and ruling; old-head evidence grants nothing. Timeout is not proof of non-launch. Replayed markers cannot create a second entitlement. No new endpoint or state-reset trigger is added, so endpoint body/rate/CSRF requirements are not applicable.

## Follow-ups

If a new negative fails on current production code, retain its reproducer and review the narrow production fix rather than weakening the expectation. Further launcher families should reuse the outcome matrix when introduced; mechanical-round policy changes remain separate.

revalidated: The diff only pins two historical planner fixtures to serial timing; takeover authorization, launcher outcome coverage, and mechanical-round preservation premises and proof plans remain unchanged.
