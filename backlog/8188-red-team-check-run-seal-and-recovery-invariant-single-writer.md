---
bornAs: xiwp9jq
kind: story
size: 5
status: active
scaffoldedBy: "card-6535-redteam"
dateScaffolded: "2026-11-13"
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/lib/red-team-check-run.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/__tests__/red-team-check-run.test.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs"]
dateOpened: "2026-11-13"
tags: []
related: ["6535"]
---

# Red-team check-run seal-and-recovery invariant (single writer)

Carded from #6535 (non-convergent at round 13/13, R903+R907). Break (confirmed, broken, fail-closed so it holds the merge and is not on main): we:scripts/operations/review-extra-seats.mjs:2084 - The parent job's final write can undo finish-time sealing and supersede success with an unfinished check (sealFinished publishes success; the parent review-job rewrites finished/result=ran without a sealFinished callback; keepSeal drops sealedBreaks; recordRedTeamStatus publishes a newer in_progress check). Findings: (1) degraded we:scripts/lib/drain-red-team-evidence.mjs - no test for the all-GitHub-writes-fail case (add a we:scripts/lib/__tests__/merge-gate-ci.test.mjs row 'all GitHub writes failed, older success, hosted leg with no local store' and reword the PR text). (2) degraded we:scripts/lib/red-team-check-run.mjs - policy-clear writer has a fail-open window pinned as passing by test 'reports a superseding post that also fails'; put every red-team check writer behind one per-identity publish lock (PR-A #6606 design). (3) degraded we:scripts/lib/red-team-check-run.mjs - duplicated policy-clear reader lacks a named test for read bounds; add 'bounds policy-clear reads before and after publication' in we:scripts/lib/__tests__/red-team-check-run.test.mjs asserting per_page=100, maxBuffer=4 MiB, timeout=60s, preferably sharing the bounded acquisition implementation. Also the broken codex-correctness finding: policy-clear publication can leave a success authoritative over an unfinished round; same single-writer fix.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/red-team-check-run.test.mjs we:scripts/lib/__tests__/merge-gate-ci.test.mjs` fails on the sealed-then-parent-rewrite case before this lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing is excluded beyond the findings in the digest.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new untrusted input; results are already stored sealed.
2. **Truncated reads** — pin policy-clear read bounds (per_page=100, 4 MiB, 60s) with a named test.
3. **Shared state files** — one per-identity writer owns the status file; the parent review-job write must not drop sealedBreaks.
4. **Fail closed** — keep holds fail-closed; pin the all-writes-fail residual with a test.
5. **Identity scoping** — the publish lock is per identity (head).
6. **State over time** — a later write must never undo finish-time sealing or supersede success with in_progress.
7. **Who wrote it** — every check writer, including the parent job, goes through the one writer.

## Duplicate admission

carded from PR 6535 red-team round cap
