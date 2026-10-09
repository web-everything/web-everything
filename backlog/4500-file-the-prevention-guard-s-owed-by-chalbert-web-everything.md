---
bornAs: xbha495
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/git-hook-surface.mjs", "we:scripts/lib/__tests__/git-hook-surface.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "b7f61e71234b717f8bbfc6ae0f544d5c0e65b7dd"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2954's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/git-hook-surface.mjs:268–272` — Have snapshotHookSurface record an explicit configState ('absent' | 'present' | 'unreadable') and act only on 'absent'. A unit test should cover the unreadable case.
2. `we:scripts/lib/__tests__/git-hook-surface.test.mjs:330–342` — Add a review-lens checklist item: every new try/catch that flips a status flag needs a test that drives the catch.
3. `we:scripts/lib/git-hook-surface.mjs:268–272` — Make `snapshotHookSurface` record `configBytes: null` only on ENOENT and mark other read errors (for example `configUnreadable: true`), then have reset skip the delete for the unreadable case. A lint rule flagging a bare empty `catch` whose result gates an `rmSync` would catch the wider class.
4. `we:scripts/lib/git-hook-surface.mjs:262–272` — A linter rule enforcing DRY principles (e.g., eslint-plugin-sonarjs no-identical-expressions or no-duplicate-string) or standard code review focused on scope reuse.
5. `we:scripts/lib/git-hook-surface.mjs:262–272` — A strict branch-coverage gate (e.g. 100% branch coverage required for new/touched lines) that would flag the `catch` block as uncovered.
6. `we:scripts/lib/__tests__/git-hook-surface.test.mjs:330–342` — A strict branch coverage gate enforcing 100% coverage on new code, ensuring catch blocks are executed by tests.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2954@3ce84db0d414861df0d5f4cf8c323e08c430792b

## Progress

Preparation research (revalidated 2026-10-09; runner owns stamping):

- **Original premise/scope:** the six approval observations above mixed a concrete absent-versus-unreadable config defect with suggested review/lint/coverage mechanisms. The original two-file scope was the hook-surface primitive and its existing test suite.
- **Corrected premise/scope:** retain that two-file scope for the executable prevention guard. Items 1 and 3 describe the same defect; items 2 and 4–6 are broader prevention proposals, retained under Follow-ups rather than silently introducing repository-wide policy. The old preparation cited reset at lines 232–236, reads at 114–120, and the absence regression at 244; those line references are stale after the Git prerequisite work. Current deletion is at `we:scripts/lib/git-hook-surface.mjs:268–272`, the read-error conflation is at `we:scripts/lib/git-hook-surface.mjs:150–156`, and the absence regression is at `we:scripts/lib/__tests__/git-hook-surface.test.mjs:330–342`. Neither file moved. Scope remains one source entry paired with its existing matching test; size remains 3.
- **Prior preparation observation (2026-10-01, not rerun during this preparation):** a real temporary directory with a self-referential config symlink makes the read throw ELOOP. The current snapshot returns null bytes; comparing two such snapshots returns `changed: false`. Replacing the symlink with a readable config before resetting from that baseline causes that file to disappear. The probe touched only its disposable directory and removed it afterward. Thus this goal is not already delivered: commit `3ce84db0d414861df0d5f4cf8c323e08c430792b` delivered the absence-deletion branch, not this unreadable-state prevention.
- **Related contract:** `we:scripts/lib/git-hook-surface.mjs:34–36` already promises fail-closed unreadable snapshots, but `we:scripts/lib/git-hook-surface.mjs:167–170` compares only hashes. Include that state check in the same source/test scope. Both launchers already refuse an unsuccessful reset: `we:scripts/operations/probation-build-run.mjs:333–337` and `we:scripts/operations/probation-heal-run.mjs:344–349`; no launcher edit is predicted.
- **Current verification:** the existing suite in `we:scripts/lib/__tests__/git-hook-surface.test.mjs` passed all 54 tests (exit 0) through `we:scripts/readiness/heavy-admission.mjs`. This verifies the existing baseline, not the proposed unreadable-state regression; the read catch at `we:scripts/lib/git-hook-surface.mjs:155` still discards error provenance.
- **Coverage correction:** `we:docs/agent/testing.md` documents the existing 80% per-diff trust-chain branch floor. The review's proposed 100% gate is not an established requirement of this card and is not needed to exercise this concrete failure branch.

## Design

In `we:scripts/lib/git-hook-surface.mjs`, make config read provenance explicit with `configState: 'absent' | 'present' | 'unreadable'`. Set present only after successfully reading bytes and computing the hash; classify only ENOENT as absent, and other read errors as unreadable. Null bytes/hash remain unavailable-payload values, never authorization to delete. Validate supplied baselines before mutation: present requires Buffer bytes (including an empty Buffer); absent requires null bytes; missing/unknown state or inconsistent payload is refused. Update the snapshot, comparison, and reset JSDoc together, including the synthetic snapshot returned on structural refusal. Never include config contents in diagnostics.

Reset may restore bytes from a present baseline and delete a subsequently created config only from an explicitly absent baseline. An unreadable or incomplete supplied baseline must return `clean: false` before config deletion, writing, or the git-based hooks-path repair; leave the current config intact. Preserve the no-baseline cleanup behavior and the existing structural symlink guards. Require an unreadable final snapshot to make cleanup unsuccessful. Keep all filesystem failures within the existing never-throw contract.

Comparison must report changed if either snapshot explicitly records unreadable, even when both hashes are null. Preserve existing hash/file comparison behavior for other snapshots and existing hand-built comparison fixtures. This implements the already documented fail-closed contract, rather than expanding the traditional-hook threat model.

## MVP

1. Add the explicit read state and state-sensitive reset/comparison behavior in `we:scripts/lib/git-hook-surface.mjs`. Reuse one local config path within reset instead of duplicating it across the restore and delete branches.
2. Extend `we:scripts/lib/__tests__/git-hook-surface.test.mjs` with deterministic filesystem regressions for absent, present, and unreadable reads and their cleanup consequences. The existing source/test scope already covers every planned implementation entry.
3. Retain byte-exact restoration, no write-through on symlink replacement, absent-baseline deletion, and no-baseline hooks-path restoration. Do not add a linter dependency or change shared coverage thresholds as part of this local guard.

## Test plan

All added cases belong in `we:scripts/lib/__tests__/git-hook-surface.test.mjs`:

- Present config: assert present state, original bytes, and hash; retain whole-config restoration checks.
- ENOENT: assert absent state and retain the existing worker-created-config deletion regression.
- Non-ENOENT: use a self-referential config symlink to drive ELOOP through the real read catch, independent of user privilege. Assert unreadable state; replace the symlink with a valid config, reset from the unreadable snapshot, and assert `clean: false` plus byte-for-byte preservation. Include a hooks-path value whose modification would expose accidental git-based repair.
- Compare unreadable snapshots in both argument positions, including unreadable against unreadable: each must report changed. Keep ordinary unchanged and file-tamper cases passing.
- Supply incomplete or inconsistent baselines (null bytes without state, present without Buffer bytes, absent with bytes, and unknown state): assert refusal without deletion. Exercise a refused structural path and assert its snapshot cannot masquerade as a known-absent config.
- Preserve existing no-baseline, restoration failure, hook cleanup, and symlink-target sentinel cases. Assert failure results as well as reaching the catch; branch execution alone is insufficient proof.

## Proof plan

During implementation, first add the unreadable-baseline preservation regression and run the targeted Vitest suite for `we:scripts/lib/__tests__/git-hook-surface.test.mjs`; record its failure against the unchanged primitive. Apply the fix and rerun the same suite, recording successful assertions for all three states. Use Node to invoke `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` followed by `we:scripts/lib/__tests__/git-hook-surface.test.mjs`. Strip repository prefixes when forming executable checkout-relative arguments; all tests must run through this host queue.

Implement the temporary-directory ELOOP → readable-config → reset probe as a regression in the scoped test suite and execute it through the same queue: the recovered bytes must survive, cleanup must report false, and unreadable/unreadable comparison must report changed. Keep the probe outside real lane metadata and never print snapshot payloads. Run the standards gate through the same queue: invoke `we:scripts/readiness/heavy-admission.mjs` with `run -- npm run check:standards`.

Then, where required by the existing diff-coverage gate, generate fresh coverage through the heavy-run queue and use the actual review base. Record commands, exit statuses, and any unrelated failures without claiming a passing gate from an inconclusive run. Preparation itself does not implement these fixes or claim these future checks have passed.

## Follow-ups

Retain the other approval observations as explicit wider prevention debt: a review checklist requiring catch-driving tests for status changes (item 2); an empty-catch-to-destructive-operation lint investigation (item 3); scope reuse/duplication review or lint (item 4); and evaluation of a 100% touched-branch policy against the current 80% floor (items 5–6, one duplicated proposal). Any shared lint or coverage policy needs its own researched scope and decision; this card does not ratify a plugin, threshold, or repository-wide rule. The local regression supplies the executable guard for this defect. The broader config-controlled execution paths already excluded by `we:scripts/lib/git-hook-surface.mjs` remain outside this fix.

## Done when

The unreadable-baseline preservation test fails against the current primitive and passes after the fix; absent-baseline deletion and present-baseline restoration still pass. Unreadable snapshots cannot produce an unchanged comparison or authorize config mutation. The targeted suite and applicable standards/coverage checks have recorded results, and the broader approval suggestions remain visibly accounted for under Follow-ups.
