---
bornAs: x3tksez
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs", "we:scripts/lib/required-check-workflows.mjs", "we:scripts/lib/__tests__/required-check-workflows.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/operations/__tests__/pr-status*.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "06856e20dc622c8425e46c4d6c7e56039093bdcc"
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

- Re-prepare 2026-11-21 (premise check vs current `main` 06856e20dc): not delivered — `git log` shows no commit implementing it; `we:scripts/lib/required-check-workflows.mjs` and its test do not exist. Drift corrected: `we:.github/workflows/ci.yml:46` now reads `pull_request.branches: [main, 'lane/**']`, so lane-stacked PRs are eligible and the "main-only CI" fixtures above must use a base outside both patterns (e.g. `release/x`). `we:scripts/conveyor/reconcile-pass.mjs#hydrateChecks` is now exported (line ~1561), already reads `readStackedPrCheckPolicy()`, and requirements still come from `readRequiredChecks({branch: defaultBranch})` (~line 1838). `we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs` already exists (182 lines, #4708 coverage): extend it, do not recreate it. Size unchanged (2).

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

## Edge cases this change must handle

1. Untrusted text — PR base/head names, workflow names and filter strings reach the diagnostic and cache key: fold newlines/backticks (`foldUntrusted`, `we:scripts/lib/jury-core.mjs`), reject a branch value starting with `--` before any argv use, NFKC-normalize; test with a base named `x\n--evil`.
2. Truncated reads — a 100-row rollup (`runs.length >= 100`) or a workflow/protection read at a limit is treated as incomplete: hydrate normally, never suppress (test in `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`).
3. Shared state files — the sidecar is written with `writeJsonAtomic` under `withFileLock` (`we:scripts/lib/atomic-json-file.mjs`), compare-and-set on re-read; two concurrent ticks may both report once but never corrupt the file or suppress a changed key.
4. Fail closed — workflow read/parse failure, sidecar read/parse/write failure, or stale evidence yields unknown → ordinary hydration and `check-read-failed`; never "eligible", `[]` or green. The refusal reason is named.
5. Identity scoping — key includes repo + PR number + head SHA + base + policy branch + required-set digest + workflow digest; a different repo or PR never shares a record (keys are PR-based, so hash/NNN spellings of the card are not involved).
6. State over time — a new head, retarget, requirement change or workflow revision invalidates the record; TTL (15 min) with clock skew (a future timestamp is stale); restart mid-tick re-reads the sidecar and at worst repeats one diagnostic.
7. Who wrote it — workflow YAML is read only from the repository at the immutable revision under evaluation, never from a PR-authored path or unrelated lane checkout; a PR comment or label cannot mark a check eligible/excluded.

## Acceptance

- [A1] Executable: `npx vitest run we:scripts/lib/__tests__/required-check-workflows.test.mjs` — fails before the build (module absent), passes after: analyzer returns proven-excluded only for literal job names with an understood `pull_request.branches` filter that excludes the base, covering globs, negation order, `branches-ignore`, unfiltered triggers; everything else (dynamic names, duplicates not all excluded, malformed YAML, missing file) is unknown.
- [A2] Executable: `npx vitest run we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs -t "excluded base"` — fails before (every tick re-hydrates and emits `check-read-failed`), passes after: two passes and two fresh readers over one temp sidecar give exactly one configuration diagnostic and zero hydration reads, and the PR is never promoted.
- [A3] Executable: same file, `-t "invalidation"` — fails before, passes after: changing the head, base, required set or workflow digest, or expiring the TTL, resumes hydration and re-emits once.
- [A4] Executable (fail-closed paths): same file, `-t "fail closed"` — unreadable/corrupt sidecar, workflow read error, truncated (100-row) snapshot and a mixed proven+unknown missing set all take the existing hydration path; red/pending evidence still wins.
- [A5] Executable (reducer default unchanged): `npx vitest run we:scripts/operations/__tests__/pr-status.test.mjs we:scripts/conveyor/__tests__/reconcile-pass.test.mjs` — green before and after (regression guard: missing names still `unchecked`; changed-file class never bypasses checks).
- [A6] Executable (standards caller): `npx vitest run we:scripts/__tests__/check-standards.test.mjs -t "required check workflow"` — fails before (no such rule), passes after: excluded-base fixture fails with context/base/workflow evidence, compatible default-base fixture passes, unknown/unavailable live protection is reported unverified, offline mode makes no network call; and `npm run check:standards` exits 0 on this repo (main + `lane/**` CI vs declared requirements).
- [A7] Executable (formatter caller): same `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs` with `-t "formatReport"` — fails before, passes after: the configuration diagnostic appears in `formatReport` output.

Red-first rule for A2–A4 and A7: write each named test first and record a real assertion failure (not a "no tests found" result) before wiring; A4 additionally pins the diagnostic is NOT emitted and hydration IS called on unknown/error inputs, so it is red until the analyzer exists. `npm run check:standards` in A6 is a regression guard only; A6's red-before is the `-t "required check workflow"` rule.

Interaction with the existing stacked policy (`we:scripts/conveyor/reconcile-pass.mjs#hydrateChecks`, the `await-base` skip near line 1569): the analyzer runs first and only adds the diagnostic and read suppression for a proven base-excluded name; when `stackedPolicy` is `await-base` and that existing skip fires, the skip itself (a deliberate policy: a stacked PR awaits its base) is NOT widened or relied on as a fail-closed guarantee of this card — the card's guarantees hold on the non-`await-base` path — but the analyzer still runs there so a proven base-excluded name gets the one-time diagnostic, and an unknown/eligible result adds no diagnostic and no new suppression. [A8] Executable: `npx vitest run we:scripts/conveyor/__tests__/reconcile-pass-required-checks.test.mjs -t "await-base"` — pins both: under `await-base` a proven-excluded base yields exactly one diagnostic, and an eligible `lane/**` base or unknown analyzer result leaves the pre-existing skip behaviour byte-identical (red before: the diagnostic is absent). Whether the `await-base` skip should itself require workflow-exclusion proof is a separate policy change (Follow-ups). A2's fixture must use a non-`await-base` policy so it is red before the build. CAS (Edge 3) = under `withFileLock`, re-read the sidecar, compare the record key, write only if unchanged or absent (`writeJsonAtomic` alone is not CAS).

(Run commands after translating the `we:` locus to the WE checkout-relative path.)

## Done when

1. The two-tick executable regression fails before implementation and passes afterward: one actionable configuration diagnostic for unchanged evidence, no repeated absence-only REST hydration, and no promotion of the blocked PR.
2. Unknown/error/truncated inputs still take the existing cautious read path, and observed failing or pending checks retain their behavior.
3. The standards gate and runtime use the same tested branch-filter interpretation; reported findings identify the applied policy and evidence rather than asserting protection on an unqueried base.

## Follow-ups

- Make the existing `await-base` stacked-PR hydration skip in `we:scripts/conveyor/reconcile-pass.mjs#hydrateChecks` require workflow-exclusion proof (today it skips on any all-missing, under-100-row stacked PR, including `lane/**` bases CI does cover). Policy change, deliberately not in this card (codex-audit 2026-11-21 flagged it).

- Any change to apply per-base rather than default-branch requirements is a separate policy decision, not part of this diagnostic fix.
- Extend producer resolution for dynamic names, reusable workflows, external contexts, path filters, or job conditions only with authoritative evidence and matching tests. They remain unknown in this slice.
- Broader cross-process concurrent exactly-once reporting is outside this sequential-tick deduplication goal; cache loss may repeat a diagnostic but cannot permit promotion.
