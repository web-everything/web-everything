---
bornAs: xggb0ep
kind: task
status: open
scope: ["we:scripts/conveyor/review-status-tag.mjs", "we:scripts/conveyor/__tests__/review-status-tag.test.mjs", "we:scripts/lib/review-label-provider.mjs", "we:scripts/lib/__tests__/review-label-provider.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-15"
preparedAgainstSha: "1aba0878aeff904dec8963fee888b3bafcda48ca"
tags: []
estimatedLoc: 180
---

# Status label must say ci-red when required CI finished red (not awaiting-ci)

WE PR #2865 was reported to carry `review-status:awaiting-ci` for about an hour after required `soak-replay-gate` failed. Preserve the goal: an idle PR whose required CI has finished red must not misleadingly say it is still waiting for CI. This preparation concerns the remaining legacy label path.

## Progress

- **Old premise/scope:** the previous preparation correctly identified missing rollup data in the standalone provider, but treated the tagger as having no CI-aware status path. It proposed three files: we:scripts/conveyor/review-status-tag.mjs, we:scripts/conveyor/__tests__/review-status-tag.test.mjs, and we:scripts/lib/review-label-provider.mjs. Its claim that draft PRs are exempt from CI healing is stale.
- **Corrected premise:** we:scripts/conveyor/pr-status-label.mjs:62 and we:scripts/conveyor/pr-status-label.mjs:122 already derive `status:ci-red` from required failures. The tagger invokes that path when planner rows are supplied (we:scripts/conveyor/review-status-tag.mjs:290); the daemon supplies those rows and its PR snapshot (we:skills-src/conveyor/review-daemon.mjs:592). However, legacy labels remain enabled by default (we:scripts/conveyor/review-status-tag.mjs:49), and idle default-branch drafts still unconditionally derive `awaiting-ci` (we:scripts/conveyor/review-status-tag.mjs:177). This residual is not already delivered.
- **Corrected scope:** retain the three source/test entries and add the existing matching provider test, we:scripts/lib/__tests__/review-label-provider.test.mjs:21. The standalone field list still lacks `statusCheckRollup` (we:scripts/lib/review-label-provider.mjs:67). Reuse existing CI primitives; no daemon, dispatch-policy, or newer status-label implementation change is needed.
- **Behavior corrections:** drafts can receive CI healing (we:scripts/conveyor/review-status-tag.mjs:168). Preserve the card's previously specified completed-red outcomes: non-draft → `ci-red`, draft → `needs-human`. A draft does not become green merely by returning `null`: retain its current awaiting-CI fallback until the existing promotion flow changes its draft state. Preserve stacked-base waiting and withdrawal holds.
- **Estimate:** no previous `estimatedLoc` or `size` was present. Set `estimatedLoc: 180`: approximately 55 changed lines in we:scripts/conveyor/review-status-tag.mjs (derivation, shared fact preparation, enum/docs), 100 in we:scripts/conveyor/__tests__/review-status-tag.test.mjs (state matrix and IO transitions), 5 in we:scripts/lib/review-label-provider.mjs (field/documentation), and 20 in we:scripts/lib/__tests__/review-label-provider.test.mjs (argv and round-trip coverage). These are estimates of changed lines, not file lengths. Preparation stamps remain runner-owned.

## Design

1. Extend `PR_STATE_FIELDS` in we:scripts/lib/review-label-provider.mjs:67 with `statusCheckRollup`. Preserve the provider's read-failure behavior and single-read shape. The daemon already passes a snapshot; do not add a per-PR network read there.
2. In we:scripts/conveyor/review-status-tag.mjs, prepare the CI facts before deriving the legacy status, so standalone calls as well as calls with planner rows receive them. Reuse the injectable required-check input/cache reader and existing head-bound merge-gate excusal seam. Resolve them once per invocation and share the prepared facts with the newer status path. Preserve cache-only reads and the newer path's existing fallback behavior.
3. Pass an optional reduced CI state into `deriveReviewStatus`. Use `reduceCheckState` from we:scripts/operations/pr-status.mjs:170 with the known nonempty required set; it already collapses reruns, handles implied requirements, and gives pending precedence over failure. First collapse raw rows with `collapseRollupToLatestPerName` from we:scripts/lib/rollup-collapse.mjs:66, preserving its CheckRun-versus-StatusContext precedence. Locally map surviving legacy contexts to reducer inputs: `context` → `name`, `PENDING` → running, `SUCCESS` → completed/success, and `FAILURE` or `ERROR` → completed/failure; leave unknown states unreadable. The collapse utility itself does not normalize status contexts. Unknown requirements or absent/unreadable rollup must not manufacture completed-red evidence; preserve the previous legacy fallback in those cases. Do not use the reducer's unfiltered fallback to classify an optional failure as required.
4. Preserve precedence: existing head-scoped escalation, live reviewer/fix claim/fixer/CI healer, and stacked-base draft waiting continue to win. After those cases, reduced required CI `red` yields `{ role: 'draft', state: 'needs-human' }` for a draft and `{ role: 'ci', state: 'ci-red' }` for a non-draft. Pending, unchecked, or green retains the existing fallback: default-branch draft `awaiting-ci`, otherwise `null`. The proposed `ci` role is informational and must not masquerade as a live fixer.
5. Add `ci-red` to the legacy enum and return-type documentation in we:scripts/conveyor/review-status-tag.mjs. Reuse `planStatusLabelChange` to remove stale labels, including `ci-red` after a rerun, without touching unrelated labels. Its durable withdrawal override remains authoritative. With legacy writes disabled, continue removing legacy labels except withdrawal; keep `status:*` derivation unchanged.

## MVP

Must deliver the provider field, CI-fact plumbing, legacy derivation/enum change, and matching tests in the four scoped files. The observed failure must transition from `review-status:awaiting-ci` to `review-status:needs-human` on an idle default-branch draft, or to `review-status:ci-red` on an idle non-draft. A later pending rerun must clear that completed-red signal. Preserve active-worker status, head-scoped escalation, withdrawal, stacked-base waiting, idempotency, and the existing newer `status:*` output.

Could follow separately: historical label backfill and eventual legacy-label retirement. Neither is required to correct future tagger passes.

## Test plan

- Extend we:scripts/conveyor/__tests__/review-status-tag.test.mjs: cover completed required failures for both draft states; pending plus failure; empty/missing rollup; unknown requirements; all-green; optional failure with required green; legacy status contexts; stale failure superseded by a newer success/pending run; and excused versus unexcused merge-gate failures. Assert existing precedence for live agents, fix claims, escalation, stacked drafts, and durable withdrawal.
- Exercise `tagReviewStatus` with an injected provider and with a supplied PR snapshot. Assert exact label additions/removals, no redundant PR read, one required-check resolution, no second write on an unchanged pass, red-to-pending/green transitions, failed reads preserving labels, and legacy-disabled cleanup. With planner rows, assert newer `status:*` output remains consistent with its existing behavior.
- Extend we:scripts/lib/__tests__/review-label-provider.test.mjs to pin the added JSON field and round-trip a rollup through `createGhProvider` using injected execution. Preserve its import-boundary coverage.
- Run these two scoped test files plus the existing regression suite we:scripts/conveyor/__tests__/pr-status-label.test.mjs through the host heavy-run queue, using the `run -- npx vitest run` mode of we:scripts/readiness/heavy-admission.mjs. Run `npm run check:standards` through the same queue. Repository prefixes here identify files; strip `we:` when supplying filesystem arguments to the command.

## Proof plan

1. In the scoped IO tests, replay a current-head snapshot with all required checks completed and `soak-replay-gate` failed, no live agent/claim/escalation, and an existing awaiting-CI label. Capture the actual provider writes and returned label for draft and non-draft variants. Then replay pending and green reruns to prove stale red labels clear. This is deterministic evidence, not a claim about the historical PR's current state.
2. At implementation verification, capture a read-only real PR snapshot and the required-check set with provenance. Replay that snapshot through `tagReviewStatus` with an injected recording provider; compare expected label changes against the captured CI evidence. Do not blindly reuse historical PR #2865 or mutate an unrelated PR to obtain proof.
3. When an authorized live target is available, observe a normal daemon pass and read labels back to confirm the stale legacy label is replaced. Record repository, PR/head, required checks, prior/final labels, and whether a live worker took precedence. The standalone CLI requires both PR number and repository (we:scripts/conveyor/review-status-tag.mjs:381); it does write labels and does not derive newer `status:*` labels without planner rows. A mocked write is not proof of live delivery.

## Follow-ups

- Retire legacy status readers/writes under the existing migration described in we:scripts/conveyor/review-status-tag.mjs:26; do not expand this fix into that migration.
- Backfill historical labels only if a current observation shows stale labels surviving normal daemon reconciliation.
- Keep recovery eligibility and dispatch policy out of scope. This card corrects an informational label and preserves the draft outcome already specified by its earlier preparation; it does not disable draft CI healing or introduce a new human-approval gate.
