---
bornAs: xkvqtrc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "32fbad6f48ce3ccdfd1df70dd42ba1a5da64cf96"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2974's independent review

Track the two prevention debts from the approved independent review: warm shared-snapshot listing cost coverage, and discovery of a requested-base candidate beyond the raw open-PR cap. The original citations have moved to `we:scripts/merge-ai-prs.mjs:5308` (context reuse) and `we:scripts/merge-ai-prs.mjs:5662` (candidate listing).

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2974@231c3429288e74c55e0a4b1bfd364a20f379218d

## Progress

- **Premise correction (2026-11-18):** the old preparation assumed every repo used a sized `gh pr list`, escalating to 500, and that a warm snapshot only affected sizing. Named repos now use live GraphQL cursor pages with snapshot-seeded heavy fields at `we:scripts/merge-ai-prs.mjs:5711`; only unresolved cwd identity retains sized listing at `we:scripts/merge-ai-prs.mjs:5726`. The reader still stops at its row bound (`we:scripts/lib/pr-list-paged.mjs:276`), and the drain still passes `maxRows: OPEN_PR_LIST_LIMIT` (`we:scripts/merge-ai-prs.mjs:5724`). Thus pagination exists but does not deliver the past-cap guarantee. This is source inspection, not a claimed runtime reproduction.
- **Old scope → corrected scope:** replace the generic `we:scripts/__tests__/merge-ai-prs.test.mjs` with the actual `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs`; retain `we:scripts/merge-ai-prs.mjs`. The existing shim supports only legacy list calls (`we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:40`); extending it for GraphQL and heavy-field reads is necessary to exercise production behavior. Existing context tests at `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:76` and `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:106` already pin truncation and raw-row reuse, but do not exercise a warm shared snapshot or a past-cap requested-base candidate.
- **Estimate:** retain size 3 (old 3 → new 3): approximately 50–80 changed source lines for a bounded supplementary candidate read and error handling, plus 180–240 test lines for paged fixtures, snapshot setup, call accounting and negative cases, in the two scoped files. No shared reader API/default changes are needed.
- The previous proposal to prefer snapshot rows as context is withdrawn: current context deliberately reads the live open set because a snapshot can omit new blockers (`we:scripts/merge-ai-prs.mjs:5315`). Preserve that safety rule. Preparation stamps are left to the runner.

## Design

Keep the initial listing base-blind and live. When it is capped and an explicit base is requested, make one supplementary `gh pr list --base <base> --state open --limit OPEN_PR_LIST_LIMIT` through the existing throttled execution path. Use the same candidate/context field selection as the initial listing, without server-side label search. Parse with the existing strict list parser and resolve checks through the existing check-resolution path. This applies to both named-repo GraphQL listing and the unresolved-cwd legacy branch.

Union supplementary rows with initial rows by PR number for candidate selection only; prefer the later supplemental observation on duplicates. Apply the existing operator selector to that union, retaining release-label, requested-label, base and only-PR behavior. Return the original base-blind rows for context. Do not convert incomplete context into complete context merely because a base-filtered page was short. Retain the original degraded signal and warning; if the supplemental page is also full, additionally report that requested-base discovery remains bounded and may omit candidates. The operator fallback is to reduce the open backlog and rerun; never claim exhaustive discovery in that case. A failed or malformed supplementary read follows the existing per-repo listing error path, never an empty-success fallback.

For cost coverage, use an explicit fixture repo with RECONCILE enabled. Extend the existing fake executable to log every API/list/view request and implement cursor pages, totalCount, heavy-field reads, and base filtering before slicing. Unknown requests must fail the fixture. Seed a fresh shared snapshot using the format documented at `we:scripts/lib/pr-snapshot-store.mjs:15`, with matching updatedAt/head SHA and body/files. Snapshot hydration only reuses matching rows (`we:scripts/lib/pr-list-paged.mjs:339`). Isolate all stores under the task temporary directory. Compare snapshot-disabled, enabled-empty and enabled-warm runs; distinguish snapshot refresh calls from live candidate/context calls rather than counting only legacy `pr list` calls. A warm seed must reduce heavy hydration while retaining live page reads and identical candidate results.

No CLI, paging-setting or snapshot-default change. Existing callers continue using the same selector and raw context map (`we:scripts/merge-ai-prs.mjs:2523`); the supplementary request is restricted to capped explicit-base sweeps. Fast-drain round snapshots remain candidate evidence only and are not relabeled as complete live inventories.

## MVP

- Extend the scoped CLI harness to exercise both production GraphQL and legacy cwd listing paths deterministically.
- Add the two owed guards and the bounded base-filtered supplementary read.
- Cover cost, duplicate elimination, unchanged ordinary-call behavior, raw context preservation, and failed/incomplete supplemental evidence.
- Keep all storage and subprocess calls hermetic; no real GitHub or host cache access.

## Acceptance

All named tests below belong in `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs`. Executable acceptance includes presence of the named cases: a missing case is a failure, never a successful empty selection. The builder must first add each assertion and record its result against unchanged source. Past-cap discovery must be behaviorally RED; preservation/cost cases may already be GREEN and require the explicit mutation RED described below, rather than a fabricated before-build failure.

- [A1] Executable — test `4529 past-cap base discovery`: more than 500 off-base rows precede one labeled requested-base row; both paged and legacy CLI modes discover that exact PR once. Fails on unchanged source, passes after the fallback.
- [A2] Executable — test `4529 warm shared snapshot cost`: disabled, enabled-empty and warm modes yield identical considered/candidate results; warm mode performs one live page sequence per swept repo, no second context sequence and fewer heavy reads than disabled mode. Before the test build the required named coverage is absent; additionally prove RED by disabling seed reuse or duplicating the context read, then GREEN after restoring source.
- [A3] Executable — test `4529 fallback preserves callers and defaults`: capped explicit-base input makes exactly one supplemental request, with correct fields and no label search; overlapping rows are considered once; ordinary under-cap and no-base inputs make none. Assert original cross-base context rows remain present and truncated context remains incomplete. Required coverage is absent before build; mutation RED removes the base/cap guard or substitutes filtered context rows; restored implementation is GREEN.
- [A4] Executable — test `4529 fallback fails closed`: malformed JSON, non-array response and command failure produce the existing listing-failure outcome with no candidate action; a full supplemental page retains visible incomplete-discovery warning and incomplete context. Required coverage is absent before build; mutation RED swallows the read error or clears completeness warnings; restored implementation is GREEN.

## Test plan

Run the four named cases and existing tests in the scoped harness via the host heavy queue. Define the shell command below with repository-qualified paths, stripping only the locus for execution from the WE root:

`queue=we:scripts/readiness/heavy-admission.mjs; suite=we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs; node "${queue#we:}" run -- npx vitest run "${suite#we:}"`

For each acceptance case, the same command with `-t '4529 <case name>'` is its focused run; verify the report contains the named executed test, not merely exit zero. Cover both listing branches for A1/A4. Use fixture files for the oversized payload rather than environment JSON. Keep existing raw-row, field-set, no-base and no-label tests; adapt only their explicitly chosen listing mode, never weaken assertions to accommodate the fake executable.

For A2, include a changed-head snapshot row and a live PR absent from the snapshot: both require live evidence/hydration and must remain visible. Count only hydration requests separately from commit/check reads. Make fixture repo discovery deterministic so a test cannot accidentally exercise only the unresolved-slug path. Existing related coverage is in `we:scripts/lib/__tests__/pr-list-paged.test.mjs` and `we:scripts/__tests__/merge-ai-prs.test.mjs`; these are reference coverage, not planned edit targets.

## Proof plan

Capture baseline source SHA, new-test output against that unchanged source, implementation output, and focused mutation results. Do not use a moving remote branch as the before image. Report behavioral RED separately from missing-coverage and mutation RED. Save argv logs showing GraphQL cursors, the single supplementary base request, hydration counts, and unchanged base-blind context. All probes use the real CLI with the fake executable and isolated temporary state; no live GitHub probe is required or authorized for this preparation.

The builder runs the scoped queued tests; the preparation runner owns stamping and checks. If admission is busy, use the queue's own bounded wait once, then stop and report. This card-only preparation does not claim the planned tests have been run or the fix has shipped.

## Follow-ups

- Complete discovery beyond a full requested-base supplemental page would require a separately bounded pagination design; the MVP keeps that limitation operator-visible.
- Revisit removal of the unresolved-cwd legacy listing only with repository-identity caller coverage.
- Label-only past-cap discovery remains outside this item; do not introduce search-backed label filtering as a shortcut.
