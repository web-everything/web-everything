---
bornAs: xh8442i
kind: task
parent: "5767"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/conveyor/__tests__/fix-procedure.test.mjs", "we:scripts/lib/__tests__/drain-skip-reasons.test.mjs", "we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs"]
dateOpened: "2026-10-10"
preparedDate: "2026-10-13"
preparedAgainstSha: "b00263a49d03d1c6a676c6f9c6c36d5e67175745"
tags: []
---

# Drain: no merge while a fix or ci-heal claim is live

Slice S6a of the async-daemons epic (S3t needs it). we:scripts/merge-ai-prs.mjs merges with `--match-head-commit` (around :5950) but ignores live fix claims. Add a read-only claim check (no claim write, per R4) next to the existing `--match-head-commit`: a live fix or ci-heal claim defers the merge with a `claim-held` skip reason.

## Acceptance

- [A1] **Test (a)** — a push races a merge and `--match-head-commit` refuses it.
- [A2] **Test (b)** — a live claim defers the merge with a `claim-held` skip reason (J2-10, J2-22).
- [A3] **Live** — one `claim-held` skip seen in `daemon.log`.

## Non-goals

- [N1] Writing or taking the claim from the drain (R4 keeps the drain read-only here).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the claim file is daemon-written; no external text is read.
2. **Truncated reads** — `readLockEntry` (we:scripts/readiness/file-locks.mjs:244-250) returns null for a missing or unparseable claim entry file, so a corrupt entry reads as "no claim". The build adds a fail-closed check in `readLiveDispatchClaim`: a claim directory that exists but whose entry does not parse counts as held (placeholder `who`). A test writes a truncated entry and asserts the PR is skipped.
3. **Shared state files** — Read-only access to the claim store; no write, no lock taken.
4. **Fail closed** — A throwing reader defers (placeholder claim, existing behaviour); a corrupt entry defers via the check in line 2. A dead dispatcher claim blocks merging for up to the full `DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES`; accepted cost, visible through the existing `fix-claim-held-no-progress` smell.
5. **Identity scoping** — The claim is keyed by repo and PR number.
6. **State over time** — A claim past its TTL does not block. Quarantined-claim handling is n/a until O15 of epic 5767 lands (no claim quarantine exists on `main`); tracked in Follow-ups.
7. **Who wrote it** — n/a: the drain only reads claims written by the fixer.

## Design

Premise check against `main` (832e98ad): the goal is **partly delivered, not done**. The fix half landed with fix.pushBeforeGate (PR #4771 and earlier): `attachLiveFixClaim` (we:scripts/merge-ai-prs.mjs:872) is called from the merge-site fresh re-read `fetchFreshPrForRevalidation` (we:scripts/merge-ai-prs.mjs:4478), and `classifyPr` skips on `pr.fixClaim` (we:scripts/merge-ai-prs.mjs:965). It is read-only (`readLiveFixClaim`, we:scripts/conveyor/fix-procedure.mjs:135) and fails closed on a throwing reader. The `--match-head-commit` pin is at we:scripts/merge-ai-prs.mjs:6431 (`matchHeadCommit: traceHeadSha`, now at :6466). Three gaps remain:

1. `readLiveFixClaim` reads only kind `fixing` (`FIXING_KIND`, we:scripts/conveyor/fix-procedure.mjs:68). The dispatcher's own spawn claims, kinds `fix` and `ci-heal` (`readFixDispatchClaim`, we:scripts/conveyor/fix-claim-store.mjs; `liveForeignDispatch` already loops both at we:scripts/conveyor/fix-procedure.mjs:183), are never read by the drain, so a live dispatched fixer or ci-heal session that has not yet taken a `fixing` claim does not defer a merge.
2. The skip text is `fix claim held by …`; `classifySkipReason` (we:scripts/lib/drain-skip-reasons.mjs:22, an ordered regex chain) has no rule for it, so it falls to `unrecognized-reason` and there is no stable `claim-held` kind to grep in `daemon.log` (A3).
3. Tests: the fix-claim skip is tested (we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs:176-200); there is no ci-heal test and none naming `claim-held`. A1 (a push races the merge and the head pin refuses it) is covered only as argv shape (we:scripts/__tests__/pr-merge-gate.test.mjs:35-47), not as a refused race.

Mechanism: add `readLiveDispatchClaim` (read-only `readFixDispatchClaim` over kinds `fix` and `ci-heal`, TTL via `isLeaseExpired` with `DEFAULT_FIX_DISPATCH_CLAIM_TTL_MINUTES`) and a combined reader `readLiveDrainClaim` = `readLiveFixClaim` then `readLiveDispatchClaim`, next to `readLiveFixClaim`; the merge-site call (we:scripts/merge-ai-prs.mjs:4485) passes the combined reader, and `attachLiveFixClaim` keeps its injected-reader shape (`data.fixClaim` plus `kind`). An unreadable store of any kind still attaches the placeholder (fail closed). Keep `classifyPr`'s skip arm but start the reason with `claim-held:`, and add `claim-held` to `SKIP_KINDS` plus a `^claim-held` rule at the TOP of `classifySkipReason`, beside `red-main-hold` (the reason embeds a holder name, so a later pattern could otherwise catch it first). No claim is written (N1, R4).

## MVP

Musts only:
- Drain reads the live dispatcher `fix` and `ci-heal` claims as well as the live `fixing` claim: read-only, keyed by repo + PR number, fail closed.
- Skip reason starts `claim-held:` and classifies to the stable kind `claim-held`.
- Tests A1 (race refused by the head pin) and A2 (live claim defers with `claim-held`), written RED first.

Out of scope (see Follow-ups): quarantined-claim handling, any claim write from the drain.

## Test plan

**Dispatch-claim shape (must).** Dispatcher `fix`/`ci-heal` entries carry `meta {repo, pr, kind, headSha}` and no `who` (we:scripts/conveyor/fix-claim-store.mjs:85,97), but `attachLiveFixClaim` attaches only when `claim?.meta?.who` is truthy (we:scripts/merge-ai-prs.mjs:877). The combined reader therefore normalizes a dispatch entry to `{meta:{who: <entry owner or "dispatch:<kind>">, claimedAt}}`. Every claim test below runs the REAL `attachLiveFixClaim` then `classifyPr` on a real dispatch-shaped entry, never only the reader's return value.

RED-first cases (each fails before the change):
- **claim-held for ci-heal and fix dispatch claims** — write a live `ci-heal` (and a live `fix`) entry into a temp lock root and call the new combined reader `readLiveDrainClaim`: returns the claim (RED: the function does not exist; the old `readLiveFixClaim` returns null for those kinds). Then `classifyPr` on the attached PR returns `skip` with a reason starting `claim-held`.
- **claim-held kind** — `classifySkipReason` / `buildSkipReasons` (we:scripts/lib/__tests__/drain-skip-reasons.test.mjs) map `claim-held: …` to kind `claim-held`, including a reason whose holder name contains words matching a later rule. RED: today it is `unrecognized-reason`. The existing fix-claim case in we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs also asserts the `claim-held` prefix (RED: prefix is `fix claim held`).
- **A1 race at the merge-site seam (characterization, passes today; not RED — the pin already exists at :6466)** — fresh read returns head H2 while the pass-start decision was H1: the revalidation refuses (`head moved since…`) and `mergePr` is not called; with H1 == H2, `mergePr` receives `matchHeadCommit` equal to the fresh-read head, never a later one. Asserts the code's calls, not a fake's behavior. RED if the seam test cannot be written without exporting the call site: the build exports a small pure helper for it.

Guard cases (pass today, must stay green; not RED):
- **holder name matching a later classifier rule** — a `claim-held: …` reason whose holder text matches a later rule still classifies `claim-held` (regression guard for the top-of-chain placement).
- **expired claim does not block** — a dispatch entry past its TTL returns null and `classifyPr` returns `merge`.
- **unreadable store fails closed** — a throwing store of any kind attaches the placeholder and the PR is skipped as `claim-held`.
- **read-only** — the readers never call acquire/release (inject throwing stubs).

## Proof plan

(1) Dry-run the classification with a recorded `ci-heal` claim file under a temp `WE_COORDINATION_ROOT` against a green `ready-to-merge` PR fixture: show `merge` before the change, `skip / claim-held` after. (2) On the live daemon, capture one real `claim-held` row in `we:.drain-daemon/daemon.log` (A3) and quote it in the build PR. If no claim is live during a drain pass within the build session, the builder takes a throwaway claim on a scratch PR fixture with the real claim CLI, runs one drain dry-run pass against it, quotes that log line, and releases the claim; the dry-run replay in (1) is then the accepted proof. (3) A1 is proven by the seam test above, plus the argv assertion in we:scripts/__tests__/pr-merge-gate.test.mjs.

## Follow-ups

- Quarantined-claim handling (edge case 6: a quarantined claim blocks, an expired unquarantined one does not). No claim quarantine exists on `main` yet (O15 in epic 5767); wire the drain read in once it does.
- Surface stale-claim age in the drain skip line (a health smell `fix-claim-held-no-progress` already exists).

## Progress

- 2026-10-12 prepare: premise check found the fix half delivered. Old scope: we:scripts/merge-ai-prs.mjs only. Corrected scope adds we:scripts/conveyor/fix-procedure.mjs and we:scripts/lib/drain-skip-reasons.mjs (plus their tests), per the code above. Goal unchanged.
- 2026-10-13 review: adversarial pass found a fail-open hole (dispatch claims lack `meta.who`), an overstated corrupt-file claim, and mislabelled RED cases; all fixed above.
- 2026-10-13 re-prepare: premise re-checked against current `main`; claim code unchanged (`readLiveFixClaim` reads kind `fixing` only; no `claim-held` kind). Citations refreshed: merge-site call now we:scripts/merge-ai-prs.mjs:4485, head pin at :6466. Goal, scope and plan unchanged.
- 2026-10-13 re-stamp: re-checked against b00263a4; in-scope files unchanged since c696f93 (only ci-red-recovery-watch moved, not in scope); plan unchanged, stamp refreshed.
