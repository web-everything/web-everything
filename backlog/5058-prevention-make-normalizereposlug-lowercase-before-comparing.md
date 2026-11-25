---
bornAs: x8dqd9a
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/poc-branches.mjs", "we:scripts/lib/__tests__/poc-branches-repo.test.mjs", "we:scripts/operations/__tests__/poc-land.test.mjs"]
dateOpened: "2026-10-04"
preparedDate: "2026-11-25"
preparedAgainstSha: "34f509ac7c74ef213c3c2bf6573212a07729e8f6"
tags: []
---

# Prevention — Canonicalize POC repository slug casing and strengthen sibling sync exclusion

Filed mechanically on approval of web-everything/web-everything#3917. Preserve the original goal: compare repository slugs case-insensitively and make sibling exclusion a deterministic regression gate even when that sibling opts into sync.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3917@8589945f129e73e8f7d2709a342b5780a784eb6b

## Design

Change `normalizeRepoSlug` in `we:scripts/lib/poc-branches.mjs:62` to lowercase the trimmed, suffix-stripped slug before legacy canonicalization. Keep normalization in this shared helper: registry normalization, lookup, filtering, upsert and removal already use it. Update its adjacent contract comment to state case normalization. Do not change the general constellation canonicalizer or duplicate normalization in the lander.

Repository identity becomes case-insensitive; branch identity remains case-sensitive. Preserve absent/null/empty repo defaulting to WE, legacy slug mapping, whitespace trimming and case-insensitive `.git` stripping. Persisted explicit mixed-case repo values become canonical on registry normalization; omitted repo fields remain omitted on serialization. Validation still drops malformed explicit repo values; unknown repositories must not gain access to another repository's branch.

The lander at `we:scripts/operations/poc-land.mjs:293` already passes its explicit or origin-derived key to shared lookup and filtering. Exercise that caller through injected keys; no lander production edit is needed. Preserve its current no-origin WE fallback and refusal before git activity for unregistered or wrong-repository branches. Lock-key behavior is outside this change.

In `we:scripts/lib/__tests__/poc-branches-repo.test.mjs:34`, use a local sibling fixture with `autoSync: true`, capture the sync return value, and assert exact WE-only calls and results. The production sync already filters by repository before checking the opt-in at `we:scripts/conveyor/poc-branch-sync.mjs:312`; no production sync change is needed.

## MVP

Must: shared slug lowercasing, regression coverage for WE and sibling lookups, mixed-case persisted registry entries and duplicate identity, caller success/refusal, and an enabled sibling absent from both sync calls and results. Keep the existing default, validation and branch-case contracts.

Touch set: `we:scripts/lib/poc-branches.mjs`, `we:scripts/lib/__tests__/poc-branches-repo.test.mjs`, and `we:scripts/operations/__tests__/poc-land.test.mjs`. Deliver as one small implementation change with hermetic tests. No runtime API additions, registry migration command, network operations or broader repo-key policy change.

Could: broader constellation-wide slug normalization, only as separately justified work.

## Acceptance

Each named test below is planned, not a claim that it already exists. Run commands from WE with repository prefixes removed from command path arguments; all referenced paths here retain their repository locus.

- [A1] Executable — Add `normalizes mixed-case WE and sibling identities while preserving defaults` in `we:scripts/lib/__tests__/poc-branches-repo.test.mjs`. Assert mixed-case queries and stored entries match, case-only duplicate repo entries collapse, default/legacy/trim/suffix behavior remains intact, omitted repo serializes without a repo field, upsert/remove use the same identity, and branch casing remains distinct. Run the queued unit command in Test plan. Mixed-case matching fails before the helper change and passes after.
- [A2] Executable — Add `lands mixed-case repo keys and refuses foreign or invalid evidence before git` in `we:scripts/operations/__tests__/poc-land.test.mjs`. Table-drive WE and sibling successful landings with mixed-case keys and exact expected pushes; assert foreign/unknown keys, null against a sibling, malformed dropped registry entries and an empty registry return `not-registered` with zero git calls. Retain null-key WE success. Run the queued unit command in Test plan. The combined test fails on mixed-case success before the fix and passes afterward; negative cases protect the existing fail-closed boundary.
- [A3] Executable — Strengthen `WE-only consumers never see the sibling-repo branch` in `we:scripts/lib/__tests__/poc-branches-repo.test.mjs` with an enabled sibling and a mixed-case explicit WE repo fixture. Assert both exact sync calls and returned results contain only the WE branch; retain delivery-target and prototype-guard exclusion assertions. Run the queued unit command in Test plan. Mixed-case WE inclusion fails before normalization and passes after. Additionally, temporarily removing the repository filter must fail this test on both sibling calls and results; restore the filter immediately after the mutation proof.

## Test plan

Use the host queue only. Execute `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/poc-branches-repo.test.mjs we:scripts/operations/__tests__/poc-land.test.mjs we:scripts/lib/__tests__/poc-branches.test.mjs` after stripping the `we:` path prefixes for shell execution. The existing general registry suite guards validation and defaults alongside the targeted new regressions. All git/sync effects use existing injected fakes; no remote access.

Add tests first and record the expected mixed-case failures, then apply the helper change and rerun the same command. Exercise case variants on both query and stored sides, including the same branch name in different repositories. Do not replace existing refusal assertions with weaker status-only checks. If admission is busy, use one bounded admission wait, then stop and report as instructed by the runner.

## Proof plan

Record the queued red and green test results and the A3 filter-mutation failure, distinguishing existing passing safety checks from newly failing regressions. Inspect the final diff for only the three scoped files during implementation. The runner owns preparation stamping and checks; this preparation does not claim that tests ran or that the feature shipped. No live push is required: exact injected git argv and zero-call refusals provide deterministic evidence for this narrow identity fix.

## Follow-ups

No required follow-up or unresolved policy fork. Broader normalization of lock keys or unrelated constellation consumers is excluded; it would require its own caller analysis and scope. Do not change the existing no-origin default under this prevention item.

## Progress

- Original premise/scope: the card cited `we:scripts/operations/poc-land.mjs:293` as the normalization fix site, scoped that production file plus two tests, and cited `we:scripts/lib/__tests__/poc-branches-repo.test.mjs:38` for sibling exclusion.
- Corrected premise/scope: `we:scripts/operations/poc-land.mjs:293` selects the key; normalization actually lives at `we:scripts/lib/poc-branches.mjs:62`. Its current trim/suffix/legacy pipeline does not lowercase ordinary slugs. `we:scripts/lib/constellation-repos.mjs:117` returns non-legacy slugs unchanged. Shared comparisons at `we:scripts/lib/poc-branches.mjs:176` and `we:scripts/lib/poc-branches.mjs:185` therefore remain case-sensitive. Replace the lander production path in scope with the shared helper; retain the lander test path as caller coverage.
- The exclusion test starts at `we:scripts/lib/__tests__/poc-branches-repo.test.mjs:34`; its sibling fixture at line 17 has `autoSync: false`, and its call at line 39 discards returned results. `we:scripts/conveyor/poc-branch-sync.mjs:312` already excludes sibling entries before resolving auto-sync, so strengthen the test rather than changing sync production behavior.
- Caller evidence: `we:scripts/operations/__tests__/poc-land.test.mjs:110` covers sibling landing and refusal but uses lowercase keys. Shared normalization also feeds registry deduplication at `we:scripts/lib/poc-branches.mjs:140`, upsert at `we:scripts/lib/poc-branches.mjs:248`, and removal at `we:scripts/lib/poc-branches.mjs:263`; the plan explicitly covers these effects and old omitted-repo state.
- Size remains 3: estimated touch set is one helper/comment change (about 4 changed lines), registry/sync tests (about 65 changed lines), and caller tests (about 35 changed lines), roughly 104 changed lines across three files. This is a story, so no task-only estimatedLoc is added. Research was source inspection; tests and implementation are left to the build and runner. No preparation stamp authored.
