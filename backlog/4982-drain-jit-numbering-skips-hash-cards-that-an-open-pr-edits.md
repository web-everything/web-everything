---
bornAs: xbmbmnf
kind: story
size: 5
status: open
scope: ["we:scripts/lane-drain.mjs", "we:scripts/__tests__/lane-drain-numbering.test.mjs", "we:scripts/backlog.mjs", "we:scripts/__tests__/backlog-number-stranded.test.mjs", "we:scripts/lib/open-pr-numbering-holds.mjs", "we:scripts/lib/__tests__/open-pr-numbering-holds.test.mjs"]
dateOpened: "2026-10-03"
preparedDate: "2026-11-24"
preparedAgainstSha: "a8ce0d12ae783831ae6384f9df0b22f688e0babb"
tags: []
---

# Drain JIT numbering skips hash cards that an open PR edits

Bulk numbering must defer a tracked hash card while an open PR touches its exact path. Unrelated eligible cards should still number; the deferred card becomes eligible on a later complete scan after the editing PR closes or lands.

The original report attributed a rename/modify conflict in PR #3771 to bulk-numbering commit 952011907 on 2026-10-03. Its example “4862 to 4862” does not identify a hash-to-number rename. Treat that incident as historical motivation, not a verified current reproduction or a claim that every rename conflicts.

## Progress

- Old premise/scope: all tracked hashes are safe to number because they reached main, with a fix confined to we:scripts/lane-drain.mjs and its numbering tests. Corrected premise: tracked presence does not prove absence of an open editor. The current candidate filter at we:scripts/lane-drain.mjs:708-714 uses only tracking and hash identity. Existing holds at we:scripts/lane-drain.mjs:911-940 cover unswept citations, and duplicate protection at we:scripts/lane-drain.mjs:959-1000 covers already-numbered identities; neither reads open-PR touch sets. The requested guard is not delivered in these paths.
- Corrected scope includes both bulk entry points: the automatic sweep at we:scripts/lane-drain.mjs:1282-1291 and manual number-stranded at we:scripts/backlog.mjs:1401-1406. Add a shared, injectable evidence reader and matching tests. Keep the new guard explicitly scoped to bulk sweeps: the same low-level numberer is used by landing and pre-push callers, including we:scripts/lane-drain.mjs:1369, we:scripts/lib/number-pending-hashes-before-push.mjs:66, we:scripts/merge-ai-prs.mjs:8166, and we:scripts/pr-land.mjs:1589. Applying an unconditional open-PR veto there could block the very PR being landed.
- Existing fixtures at we:scripts/__tests__/lane-drain-numbering.test.mjs:1252-1296 exercise the automatic sweep without a remote. Update them to inject explicit complete-empty PR evidence when hashes exist; absence of credentials must never stand in for an empty open-PR list. Preserve the no-pending fast path.
- Size changes from 3 to 5: approximately 100 changed lines in we:scripts/lane-drain.mjs, 20 in we:scripts/backlog.mjs, 140 in proposed we:scripts/lib/open-pr-numbering-holds.mjs, and 240 across their three scoped test files. The expansion follows the second caller above and the need to prove paginated evidence completeness, failure behavior, and the git merge outcome. This remains a story; no estimatedLoc field is added.
- Preparation used local source inspection only. No current PR state, historical conflict, or live mergeability was queried or asserted. Runner owns stamps and checks.

## Design

Introduce an explicit bulk-sweep option to the shared numberer, enabled by the automatic and manual sweep callers. Preserve the default at-land behavior for direct callers. Both bulk callers must acquire complete open-PR evidence before assignment, reservation, ledger changes, duplicate removal, or git writes; dry-run uses the same evidence and decisions.

The proposed reader in we:scripts/lib/open-pr-numbering-holds.mjs returns a discriminated complete result with PR numbers, head SHAs and normalized repository-relative touch paths, or an unavailable result with an actionable reason. Resolve repository identity from the checkout, never assume another constellation repository. Enumerate all open PRs including drafts, then all file pages for each PR. Protect both current and previous filenames for renames, and include added, modified and deleted paths. Match exact candidate paths, not title-derived item numbers. The fail-soft numeric-title reader in we:scripts/lib/open-pr-items.mjs:1-13 is not adequate evidence for this guard.

Use the shared throttled executor from we:scripts/lib/gh-throttle.mjs, argv arguments, injected IO, bounded output and timeouts. Cap the scan at 128 requests, including pagination and verification; disable extra reader retries so they cannot escape that budget. Use 100 entries per page, a 4 MiB per-response bound and a 60-second overall deadline. Verify file counts against PR metadata and reject truncation, missing pagination evidence, malformed rows, missing repository identity, changed heads, or a changed open-PR roster on verification. An API limit or exhausted budget is incomplete evidence, never an empty set. Emit a sanitized diagnostic telling the operator to restore evidence availability or reduce the open set and retry; there is no bypass switch. This is a bounded observation, not an atomic GitHub lock: PRs opened or changed after verification remain a residual race.

Merge protected hashes into the existing held-hash mechanism before its stale-ledger filtering and duplicate checks at we:scripts/lane-drain.mjs:940-1000. Report a distinct open-PR hold reason and PR numbers. A protected card must not be renamed or duplicate-dropped; do not promise byte-for-byte immutability of references when other cards legitimately number. If all candidates are held, return an observable no-write deferral. If evidence is unavailable, refuse the entire numbering pass with an error. Preserve unrelated citation and identity protections.

Manual output must distinguish “all held” from “no stranded files.” The automatic sweep must log holds and evidence failures even when it creates no commit. Keep the mutex around the complete decision/write sequence. Do not modify at-land/pre-push policy or bypass their existing refusals in this item.

## MVP

Must deliver the complete paginated reader, fail-closed bounds, both bulk caller integrations, protected-card ledger handling, diagnostics, and executable tests below. No new setting or policy cascade is required: bulk behavior is fixed at its two explicit entry points.

Could later optimize repeated scans or coordinate open-PR creation with numbering. Neither is needed for the bounded-snapshot guarantee. This change prevents numbering-induced renames of observed protected cards; it does not guarantee every PR remains conflict-free for unrelated reasons.

## Acceptance

- [A1] **Executable** — proposed test “bulk sweep holds an open editor while numbering an unrelated card” in we:scripts/__tests__/lane-drain-numbering.test.mjs fails before the guard and passes after. Assert exact-path protection, stale-ledger suppression, no duplicate deletion, an open-PR hold reason, and numbering of the eligible sibling; include the all-held no-write case and dry-run parity.
- [A2] **Executable** — proposed test matrix “incomplete open-PR evidence refuses before mutation” in we:scripts/lib/__tests__/open-pr-numbering-holds.test.mjs and we:scripts/__tests__/lane-drain-numbering.test.mjs fails before implementation and passes after. Cover command failure, malformed data, missing identity, incomplete file counts/pages, changed heads/roster, output overflow, deadline, and request-budget exhaustion. Assert no reservation, ledger mutation, commit or publish, plus an operator-visible retry reason.
- [A3] **Executable** — proposed test “later pages and renamed previous paths protect hash cards” in we:scripts/lib/__tests__/open-pr-numbering-holds.test.mjs fails before implementation and passes after. Include draft PRs, more than one PR/file page, add/delete/rename entries, and PRs containing docs, config and data files. An unrelated title or same hash under another path must not create an exact-path hold. Assert the shared request cap includes verification reads.
- [A4] **Executable** — proposed tests “automatic sweep requires evidence but direct at-land numbering keeps its default” in we:scripts/__tests__/lane-drain-numbering.test.mjs and “number-stranded enables holds and reports all-held in dry-run and write mode” in we:scripts/__tests__/backlog-number-stranded.test.mjs fail before integration and pass after. Assert both production bulk callers enable the guard, complete-empty evidence permits numbering, no-pending makes no API calls, and direct at-land invocation does not acquire the bulk veto. Update existing remote-free fixtures explicitly.
- [A5] **Executable** — proposed test “open editor merges across bulk pass and numbers after closure” in we:scripts/__tests__/lane-drain-numbering.test.mjs fails before the guard and passes after. Create a real temporary git base and editor branch, change a hash card, run the real bulk numberer with injected PR evidence, and prove the editor branch merges with its content intact. Then provide complete evidence with that editor closed and assert exactly one number and correct references. Assert absence of the protected rename before merging so git rename heuristics cannot hide the original defect.

## Test plan

Add the three scoped test groups and run only those files using the host heavy-admission runner at we:scripts/readiness/heavy-admission.mjs with Vitest, or the authorized test:unit command. Test repositories belong under the task TMPDIR, with injected remote evidence and no real GitHub calls. The manual CLI test must execute the caller with hermetic IO rather than merely grep its source. Existing numbering fixtures remain regression coverage for citations, identity handling and locks; do not weaken those assertions.

Each Acceptance test is a planned regression, not an assertion that it already exists or passes. First demonstrate the relevant failing assertion on the pre-build implementation, then run the same test after the build. If admission is busy, wait once using the runner's supported wait option, then report the deferral. The launcher owns the standards check and capped review loop for this preparation.

## Proof plan

Retain focused test output showing the A1–A5 red/green results and the local git graph, path list and merge result from A5. This gives reproducible proof without relying on the historical PR still being open. After implementation, an authorized operator can observe a current open editor's head/base and touch set, run a bulk pass, and compare the protected path and mergeability afterward. Do not reopen or mutate historical PR #3771 for proof. Report any unavailable live observation explicitly; local merge proof must not be labelled a live GitHub result.

## Follow-ups

- Consider shared per-tick evidence caching only with explicit freshness and invalidation tests; the MVP takes a fresh bounded snapshot per bulk invocation.
- A cross-system lock or reconciliation protocol for PR changes after verification is outside this snapshot guarantee.
- Assess protection of open-PR edits to other files rewritten by numbering separately. This item guards hash-card renames, not every possible reference-rewrite conflict.
