---
bornAs: x3tksez
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs", "we:scripts/lib/required-check-workflows.mjs", "we:scripts/lib/__tests__/required-check-workflows.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/operations/__tests__/pr-status*.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "dd4c64fb449151d3c10b8e9e1a4eaf19026c14f6"
tags: []
---

# A required check that can never run on a PR is reported once, not re-read as unchecked every tick

Follow-up from the #3432 advisory (2026-10-02). A required check missing because its workflow excludes the PR base should produce one actionable configuration diagnostic per unchanged configuration, while the PR remains blocked. Avoid repeating exact-head REST hydration solely to rediscover that absence. Add a standards validation using the same workflow/base comparison; do not waive requirements or change workflow triggers.

## Progress

- Original premise/scope: the missing-required rule at `we:scripts/operations/pr-status.mjs:179` alone caused every affected tick to fetch checks and refuse; scope contained that reducer and its unit test.
- Corrected premise: `we:scripts/operations/pr-status.mjs#reduceCheckState` computes missing names but performs no IO. Pending and failing observed checks take precedence over missing names. A direct Node probe with successful `test` and required names `test, smoke` returned `unchecked` with `missing required checks: smoke`.
- Source evidence: `we:scripts/conveyor/reconcile-pass.mjs#hydrateChecks` creates a new cache per pass, hydrates on missing names or 100 rows, and emits `check-read-failed` for missing names only when no required red/pending evidence speaks. `we:scripts/conveyor/reconcile-pass.mjs#runReconcilePass` fetches requirements for `defaultBranch`, not each PR base. `baseRefName` is already in its PR list fields. Thus a stacked PR can inherit the default-branch requirements even when its base is excluded by CI; this is not proof that GitHub protects that stacked base with the same set.
- `we:.github/workflows/ci.yml` restricts `pull_request.branches` to `main` and defines the `test`, `smoke`, and `daemon-soak` jobs. `we:scripts/lib/required-status-checks.mjs` supplies live/cached requirements and repository-specific declared fallbacks. No workflow-eligibility comparison exists in the inspected hydration path or standards gate. These are checkout observations, not a claim about current live branch protection or an affected live PR.
- Corrected scope: implement the diagnostic and read suppression in the reconciliation IO shell, with a shared proposed workflow-analysis/cache module and standards integration. Keep reducer semantics unchanged; retain its tests as regressions. The scoped workflow helper and its matching test are planned new files; the other scoped test paths exist. The old line citation is replaced by symbol references above.

## Design

1. Add the shared analyzer and injected IO/cache boundary in proposed `we:scripts/lib/required-check-workflows.mjs`. Inputs identify repository, requirements and their provenance, policy branch, actual PR base, and immutable workflow revision. Read workflows from that repository and revision, never from an unrelated lane checkout. Return eligible, proven base-excluded, or unknown per required context, with workflow and filter evidence.
2. Prove exclusion only for unambiguously mapped literal job names (explicit job name or job ID) and understood `pull_request` branch filters. Support exact names, ordinary GitHub branch globs, ordered negation, `branches-ignore`, and unfiltered triggers with tests; unsupported syntax is unknown. Duplicate producers require every possible producer to be proven excluded. Dynamic/matrix names, external status producers, reusable indirection, alternative event producers, malformed YAML, or missing source evidence remain unknown, not proof of impossibility. Path filters and job conditions are not base-exclusion evidence.
3. In `we:scripts/conveyor/reconcile-pass.mjs`, attach a structured configuration finding before hydration. Preserve the full required set passed to the reducer. Skip hydration only when the snapshot is below the truncation boundary and every missing name is proven base-excluded; hydrate normally for any other missing name or a truncated snapshot. Preserve observed red/pending checks and non-CI planning. A configuration finding is not a successful check and must not enable promotion.
4. Persist deduplication through the helper's injected sidecar store, so separate tick processes share it. Key by repository, PR number, head SHA, base, policy branch, sorted required set with provenance, and workflow revision/filter digest. Emit the actionable diagnostic once per key, showing missing names, workflow/filter, and the distinction between applied conveyor policy and actual base protection. Keep the blocking fact in structured output on every tick without repeating a `check-read-failed` event for this known configuration condition. Include the new diagnostic in `we:scripts/conveyor/reconcile-pass.mjs#formatReport`.
5. Refresh workflow/protection evidence on a bounded interval (reuse the existing 15-minute requirements freshness convention), invalidate on head/base/configuration changes, and resume ordinary hydration when eligibility returns. Failed or stale evidence cannot authorize suppression. A sidecar read/write failure falls back to ordinary hydration/reporting; do not mark a diagnostic delivered before successful persistence. This is best-effort deduplication, not a distributed exactly-once delivery guarantee.
6. Wire the same analyzer into `we:scripts/check-standards.mjs`. The offline gate validates this repository's declared default-branch requirements against local workflow YAML; report its provenance honestly. Provide an explicit injected/live validation mode for fetched branch-protection requirements and a selected base, without making ordinary standards checks require credentials. Fail on a proven mismatch; report unknown/read failures distinctly and never call them verified compatibility. Main-only CI is compatible with default-branch requirements; do not require it to run on all branches. Runtime diagnostics cover stacked-base mismatches under the currently applied policy.

## MVP

- Deliver shared eligibility analysis, bounded evidence cache and cross-process diagnostic deduplication; wire reconciliation and standards validation in the scoped files.
- Keep the four existing reducer states and required-name completeness rule. No workflow edits, protection changes, new merge exemptions, or change from default-branch policy to per-base policy.
- Must: API, parse, mapping, freshness, or persistence errors retain ordinary fail-closed CI handling; known red/pending evidence survives, and missing required checks never become green.
- Must: docs-only, configuration-only, data-only, source, and mixed diffs obey the same requirements. Changed-file classification cannot bypass checks or establish workflow eligibility.

## Test plan

- Proposed `we:scripts/lib/__tests__/required-check-workflows.test.mjs`: literal names, job-ID fallback, base inclusion/exclusion, glob and negation ordering, duplicate producers, unsupported expressions/events, malformed YAML, missing workflows, provenance, TTL expiry, cache corruption/write failure, and invalidation keys. Use temporary stores and injected readers/clocks; no real credentials.
- `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs`: two passes and two fresh reader instances sharing a temporary sidecar yield one diagnostic and no redundant check hydration for proven excluded names. Assert the PR stays blocked; retargeting or changing workflow/requirements resumes hydration. Verify isolation across repositories, PRs and heads.
- `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: retain 100-row pagination, unknown/mixed missing names, REST failures, known cancellation/pending evidence, and non-CI dispatch behavior; assert formatted configuration diagnostics. Parameterize source/docs/config/data/mixed inputs.
- `we:scripts/operations/__tests__/pr-status.test.mjs`: run unchanged reducer regressions to prove missing names still block and pending/red precedence survives.
- `we:scripts/__tests__/check-standards.test.mjs`: compatible default-base fixture passes; excluded required producer fails with context/base/workflow evidence; unknown producer and unavailable live protection are explicitly unverified; offline mode makes no network call. Assert actual gate wiring, not only the helper.

## Proof plan

- Before implementation, add the two-tick replay in `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs` using main-only workflow evidence and a stacked PR whose required check is absent. Run `npx vitest run we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs` after translating the `we:` locus to the WE checkout-relative path. Record failure on repeated hydration/missing configuration diagnosis, then the passing result after wiring.
- Run the scoped helper, reconciliation, reducer and standards suites with Vitest (all paths listed above are WE-relative after removing their locus). Capture actual reader call counts, diagnostic counts, and absence of promotion; a helper-only green test is insufficient.
- Exercise the real reconciliation shell twice in separate processes with injected recorded PR/protection/workflow inputs and a temporary persistent store. Capture JSON and human output; change the base or workflow revision for a third pass and demonstrate invalidation. No GitHub writes or live PR mutation are needed.
- Run `npm run check:standards`; separately demonstrate the wired standards validator failing on an excluded-base fixture and passing the compatible fixture. Record live comparison only if a read-only protection fetch succeeds, including provenance and revision; do not substitute a fallback result for live proof.

## Acceptance

Paths carry the `we:` locus; drop the prefix when running from the WE checkout.

- [A1] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs`: the new two-pass case (main-only workflow, stacked PR, required `smoke` absent) fails on `main` today (second pass re-hydrates and re-reports `check-read-failed`) and passes after: one configuration diagnostic per unchanged key, zero extra hydration reads, PR still blocked and never promoted.
- [A2] **Executable** — `npx vitest run we:scripts/lib/__tests__/required-check-workflows.test.mjs` (new file; fails today because the module does not exist): literal name/job-ID mapping, glob/negation/`branches-ignore`, duplicate producers, unknown for dynamic/matrix/external/malformed/missing, TTL expiry and key invalidation on base, head, requirement or workflow-revision change.
- [A3] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/reconcile-pass.test.mjs we:scripts/operations/__tests__/pr-status.test.mjs`: new cases fail today and pass after: unknown/mixed/truncated (100-row) snapshots still hydrate; observed red/pending checks keep precedence; a sidecar read/write failure falls back to ordinary hydration and does not mark the diagnostic delivered; `formatReport` prints the diagnostic; docs/config/data/source/mixed diffs behave identically.
- [A4] **Executable** — `npx vitest run we:scripts/__tests__/check-standards.test.mjs`: the wired gate fails on an excluded-base fixture (naming context, base, workflow), passes the compatible default-base fixture, reports unknown/unreadable protection as unverified, and makes no network call offline; fails today because no such check is wired.
- [A5] **Executable** — `npm run check:standards` exits 0 on the repo after the change (main-only `we:.github/workflows/ci.yml` vs. declared default-branch requirements), and exits non-zero when run against the excluded-base fixture.

## Edge cases this change must handle

1. **Untrusted text** — workflow names, job names and branch globs come from YAML and are folded (`foldUntrusted`, `we:scripts/lib/jury-core.mjs`) before reaching the diagnostic or report; none reaches a shell, argv or path. Test with a newline/backtick job name.
2. **Truncated reads** — a snapshot at the 100-row boundary always hydrates; a failed or partial workflow/protection read is unknown, never "excluded". Test the boundary and a failed read.
3. **Shared state files** — the dedup sidecar is written with `writeJsonAtomic` and `withFileLock` (`we:scripts/lib/atomic-json-file.mjs`); two ticks racing may repeat a diagnostic but never lose one or corrupt the file. Test corrupt-file and concurrent-writer cases.
4. **Fail closed** — any read, parse, spawn or persistence failure keeps ordinary hydration and the blocked state, with a named reason; a missing required check never becomes green and a configuration finding never enables promotion.
5. **Identity scoping** — the key includes repo, PR number, head SHA, base, policy branch, requirement set with provenance, and workflow revision; test isolation across repos, PRs and heads, and that hash and NNN spellings resolve to one key.
6. **State over time** — a new head, retarget, requirement change or workflow-revision change invalidates the key; evidence older than the 15-minute freshness window cannot suppress; a restart mid-write leaves a readable or ignorable sidecar.
7. **Who wrote it** — workflow evidence is read from the target repository at the immutable revision, never from an unrelated lane checkout; evidence comes from the base revision, not the PR head, so a PR cannot waive a requirement by editing its own workflow.

## Done when

1. The two-tick executable regression fails before implementation and passes afterward: one actionable configuration diagnostic for unchanged evidence, no repeated absence-only REST hydration, and no promotion of the blocked PR.
2. Unknown/error/truncated inputs still take the existing cautious read path, and observed failing or pending checks retain their behavior.
3. The standards gate and runtime use the same tested branch-filter interpretation; reported findings identify the applied policy and evidence rather than asserting protection on an unqueried base.

## Follow-ups

- Any change to apply per-base rather than default-branch requirements is a separate policy decision, not part of this diagnostic fix.
- Extend producer resolution for dynamic names, reusable workflows, external contexts, path filters, or job conditions only with authoritative evidence and matching tests. They remain unknown in this slice.
- Broader cross-process concurrent exactly-once reporting is outside this sequential-tick deduplication goal; cache loss may repeat a diagnostic but cannot permit promotion.
