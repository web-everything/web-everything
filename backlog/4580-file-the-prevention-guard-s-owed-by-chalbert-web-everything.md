---
bornAs: xvw0m6h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-rebuild.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-10-02"
preparedAgainstSha: "f37a8934197efdf0a1f41d56d8e4af0b5c18d13d"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3063's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/daemon-overlay.mjs:198` — Add a test where the replacement lock at re-check time is also gone but has a different token (for example a dead-pid owner written mid-recovery). More generally, run a mutation check on every compound guard the diff describes in prose.
2. `we:scripts/lib/daemon-rebuild.mjs:2273` — Add a direct unit test of `parseMergeTreeConflictFiles` with message-only output (no stage lines) containing a path with ` in ` and a later ` in HEAD.`.
3. `we:scripts/daemon-overlay.mjs:183` — After renaming `.recover` aside, read the owner token inside `aside` and put it back if it is not the stale one, as the old code did for the main lock. Or extend the named residual in the header comment.
4. `we:scripts/daemon-overlay.mjs:236` — Add a test for owner-write failure that asserts a replacement holder's lock survives. Make the catch remove the dir only if the owner is still empty or our own token.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3063@2dee2f0cb09ee4c6fba8fedc3616aa59021aa7f0

## Progress

Preparation research against `f37a8934197efdf0a1f41d56d8e4af0b5c18d13d`:

- **Old premise/scope:** four prevention debts from the approval, citing we:scripts/daemon-overlay.mjs:193, we:scripts/daemon-overlay.mjs:163, we:scripts/daemon-overlay.mjs:232 and we:scripts/lib/daemon-rebuild.mjs:2214; two source files and their two existing test files.
- **Corrected premise/scope:** the debts remain, but the compound recovery predicate is now at we:scripts/daemon-overlay.mjs:198, stale recovery-mutex rename/delete at we:scripts/daemon-overlay.mjs:183, owner-write failure cleanup at we:scripts/daemon-overlay.mjs:236, and the private parser at we:scripts/lib/daemon-rebuild.mjs:2273. The four-file scope remains sufficient and already pairs each source with its matching test. No implementation or preparation stamp is written by this preparation.
- **Source evidence:** we:scripts/__tests__/daemon-overlay.test.mjs:277 covers concurrent contenders; we:scripts/__tests__/daemon-overlay.test.mjs:333 replaces an owner with a live PID, so `gone` becomes false and does not independently exercise token inequality. The stale recovery-mutex test at we:scripts/__tests__/daemon-overlay.test.mjs:367 pauses the main-lock recovery, not the recovery-mutex stat-to-rename window. No owner-write fault test exists in that suite. The real-Git rename/delete test at we:scripts/lib/__tests__/daemon-rebuild.test.mjs:1226 receives stage lines, which take precedence and therefore bypass the message-only fallback. The parser is not exported or directly imported by that suite.
- **Delivery check:** the current source still unconditionally deletes the renamed recovery mutex and unconditionally removes the main lock on owner-write failure. This is not already delivered. The latest overlay-source change is the reviewed commit `2dee2f0cb`; it is the debt's origin, not its discharge.

## Design

Keep the existing per-clone mkdir mutex, stale thresholds, CLI behavior and stage-first conflict reporting. Implement the review's bounded prevention work in the scoped files:

1. In we:scripts/__tests__/daemon-overlay.test.mjs, exercise the compound recovery predicate one condition at a time. For the owed token case, change only the owner token to another dead-PID token after inspection, keeping the directory inode and mtime unchanged. Assert preservation immediately at the `removed` phase, before the next acquisition attempt may legitimately inspect and recover that replacement.
2. Export the existing pure `parseMergeTreeConflictFiles` from we:scripts/lib/daemon-rebuild.mjs for a direct test in we:scripts/lib/__tests__/daemon-rebuild.test.mjs. Preserve its best-effort message semantics: the first prose ` in ` is the delimiter, and the entire remaining suffix is retained, including spaces and later ` in HEAD.` text. This item does not invent a grammar to distinguish arbitrary filenames from Git prose. Stage records remain authoritative.
3. Use the review's explicitly permitted documentation remedy for the recovery-mutex race: extend the named residual at we:scripts/daemon-overlay.mjs:130 to include `takeRecoverMutex`'s age-check-to-rename gap. A replacement recovery mutex can be renamed and deleted after another breaker has replaced the stale one; the current code does not revalidate its owner after rename. Also correct the constant name in the comment to `ADD_GUARD_RECOVER_STALE_MS`. Do not imply this residual is closed by the main-lock predicate tests or broaden it into a guarantee of atomic removal.
4. In we:scripts/daemon-overlay.mjs, replace unconditional owner-write error cleanup with an ownership check: remove only when the observed owner is empty or equals this acquisition's token, then rethrow the original write error. A different nonempty owner survives. This is a check-before-remove guard, not atomic compare-and-remove; document that limit alongside the existing residual. Use a narrow optional synchronous owner-write fault seam in the existing hooks argument so tests can install a replacement and throw at the exact boundary; production continues to use the real atomic owner writer.

## MVP

- Add the token-only replacement regression and isolated predicate cases to we:scripts/__tests__/daemon-overlay.test.mjs using existing phase hooks and temporary lock directories.
- Add the owner-write fault seam, conditional cleanup, and accurate residual comment in we:scripts/daemon-overlay.mjs. Cover empty, own-token and different-token cleanup outcomes in we:scripts/__tests__/daemon-overlay.test.mjs; the protected callback must never run after a write error.
- Export the parser in we:scripts/lib/daemon-rebuild.mjs and add direct fallback and precedence cases in we:scripts/lib/__tests__/daemon-rebuild.test.mjs. No new files, dependency, lock backend, or operational configuration is required.

## Test plan

- **Recovery predicate:** cover a vanished directory, a no-longer-gone owner, a different dead-owner token with identical inode/mtime, a changed inode with identical token/mtime, and changed mtime with identical token/inode. Hold the original directory aside while creating an inode replacement so inode reuse cannot mask the case. Observe each result before retry; bound and settle all contenders. Include an unchanged dead-owner control proving recovery still succeeds.
- **Write failure:** inject the same sentinel error with an empty owner, this acquisition's owner, and a replacement owner. Assert original-error identity, zero callback executions, expected cleanup for the first two, and exact replacement token plus directory survival for the third. Use temporary filesystem state only.
- **Message-only parser:** directly pass `CONFLICT (content): Merge conflict in folder in name in HEAD.` with no stage records and expect the single suffix `folder in name in HEAD.`. This fails if the delimiter regex becomes greedy. Also cover a plain message, duplicate messages, empty output, and stage records mixed with misleading messages, expecting only deduplicated stage paths.
- Run the affected suites with `npx vitest run` and arguments we:scripts/__tests__/daemon-overlay.test.mjs and we:scripts/lib/__tests__/daemon-rebuild.test.mjs (strip the `we:` reference prefix when executing). Retain their existing real-Git CLI and preview integration coverage.

## Proof plan

During implementation, first add the regressions and demonstrate the replacement-owner write-failure case fails on the old cleanup. The token-only case should already pass on current code; prove its sensitivity by removing only the token equality conjunct and observing failure.

Run one temporary mutation at a time in we:scripts/daemon-overlay.mjs: remove each recovery predicate conjunct independently, make failure cleanup unconditional, and alter each empty/own-token cleanup branch. In we:scripts/lib/daemon-rebuild.mjs, make the message regex greedy and disable stage precedence separately. Record the specific failing test for each mutation; restore every mutation and rerun both full affected suites. A surviving mutation requires a stronger isolated fixture, not a claim that the guard is covered.

Review the residual comment against the actual recovery-mutex stat/rename/delete sequence. The documentation remedy discharges that explicitly allowed review alternative; it is not evidence that the race is fixed. Finish implementation with `npm run check:standards` and a diff proving no temporary mutations remain. The preparation runner owns preparation stamping and checks; none of these planned implementation results are claimed as already observed.

## Done when

The two affected suites pass; the new replacement-owner fault regression fails against the old unconditional cleanup; each named guard/parser mutation is killed by its intended test; and the header explicitly names the remaining recovery-mutex race. Scope still contains both source files and both matching test files.

## Follow-ups

No additional work item is required to deliver this bounded prevention debt. Eliminating the named non-atomic filesystem races would require a separate lock-primitive design and validation effort; this item neither chooses that primitive nor claims to provide it. Do not expand the parser into a complete Git diagnostic grammar as part of this work.
