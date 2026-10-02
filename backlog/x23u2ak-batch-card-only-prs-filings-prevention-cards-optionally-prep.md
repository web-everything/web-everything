---
kind: epic
parent: "4376"
status: open
dateOpened: "2026-10-02"
preparedDate: "2026-10-02"
preparedAgainstSha: "5c6afdb4253d148a2b3e162e61d94236d1e397a0"
tags: []
scope:
  - "we:scripts/lib/card-batch-policy.mjs"
  - "we:scripts/lib/__tests__/card-batch-policy.test.mjs"
  - "we:scripts/operations/card-batch.mjs"
  - "we:scripts/operations/card-batch-io.mjs"
  - "we:scripts/operations/__tests__/card-batch.test.mjs"
  - "we:scripts/operations/__tests__/card-batch-io.test.mjs"
  - "we:scripts/operations/land-prevention-card.mjs"
  - "we:scripts/operations/__tests__/land-prevention-card.test.mjs"
  - "we:scripts/operations/probation-build-run.mjs"
  - "we:scripts/operations/__tests__/probation-build-run.test.mjs"
  - "we:skills-src/file-item/SKILL.md"
---

# Batch card-only PRs (filings, prevention cards, optionally prepares) into rolling PRs, configurable in Plateau

Operator goal, 2026-10-02: reduce PR count by grouping new filings and prevention cards into rolling card-only PRs, with delivery-policy controls in Plateau. Prepares are a separate opt-in kind because they unblock builds. Preserve one commit per card, ordinary verification and review, source attribution, and extraction of a rejected card into its own PR. Proposed defaults remain filings/prevention enabled, 15 cards or 60 minutes, prepares disabled.

## Progress

Preparation premise check (2026-10-02):

- **Old premise:** the filing writer could append cards to a rolling PR. **Corrected:** the writer validates and persists card content; delivery is a separate operation. The scaffold sink calls the guarded writer at `we:scripts/operations/scaffold-io.mjs:65-73`; isolation, secret and locus checks are at `we:scripts/backlog/guarded-write.mjs:55-66` and `we:scripts/backlog/guarded-write.mjs:107-125`. The filing operation explicitly leaves commit/verify/open-PR to callers (`we:scripts/operations/file-item.mjs:26-37`). Introduce a delivery coordinator, not batching inside the writer.
- **Observed delivery seams:** prevention jobs acquire a lane, file one card, stage that exact path, commit, verify and submit (`we:scripts/operations/land-prevention-card.mjs:324-399`). Prepare delivery constructs an item-specific branch and opens a PR (`we:scripts/operations/probation-build-run.mjs:656-660`). These paths still require integration; neither cited path implements a rolling batch.
- **Old scope:** no predicted touch-set, tests or executable acceptance. **Corrected scope:** the file-level scope above predicts the WE delivery-adapter MVP and its tests; new card-batch modules are proposed, not existing APIs. Plateau controls and the parent policy standard/engine remain required epic slices, with their own repo-specific scopes before implementation. Do not treat this WE scope as authority to build the product settings UI here. The parent explicitly separates standard, engine and product (`we:backlog/4376-delivery-policy-as-configurable-dimensions-product-shape.md:29-33`); placement authority is [we:docs/agent/platform-decisions.md#constellation-placement](../docs/agent/platform-decisions.md#constellation-placement).
- The original 236/300, 160 prevention and 105 prepare counts are **operator-supplied historical measurements**, not reproduced evidence. Do not use them as a current baseline or claim measured CI savings. Measure PRs, CI runs and prepare latency during proof.
- Preserve isolated automated writers and integrator landing per [we:docs/agent/platform-decisions.md#pr-flow-rollout-mechanism](../docs/agent/platform-decisions.md#pr-flow-rollout-mechanism), lines 2702-2723. Batching changes delivery granularity, not who may write main or the required gates.

## Design

Proposed delivery sequence: guarded card write → durable batch admission → append one card commit → seal on count/age → verify the sealed head → ordinary PR review/landing. Keep filing, prevention and prepare batches separate, keyed by repository, project and delivery kind. These are delivery kinds, independent of the card's story/task/epic kind.

A coordinator owns each accumulating branch with a lease and expected-head comparison. Producers submit an immutable card change plus card ID, base SHA, delivery kind and source (source PR/head/finding for prevention; request/run for filing/preparation). Persist accepted membership and commit SHAs before acknowledging success; retries reconcile that record against Git instead of duplicating commits. Recover after crashes at admission, commit, push and PR creation. Never retain a scarce build lane for the full age window: durable branch/state survives temporary lane release. A timer must seal idle batches even when no new card arrives.

Validate actual changed paths and change kinds, not a title or declared scope: only explicit card additions or approved prepare edits are eligible. Reject deletions, renames, symlinks, mixed implementation changes and multiple versions of the same card within a batch. Every admitted card still traverses the existing guarded writer. Existing queue eligibility is separate from admission (`we:scripts/operations/file-item.mjs:97-109`); pending cards must not be represented as merged/build-ready by batch receipts.

While accumulating, keep the PR draft and ineligible for review/landing; seal it before invoking ordinary gates. Subsequent arrivals start another batch. This prevents every append from paying the full review cycle; CI trigger behavior must also be measured, since a draft alone does not establish that CI is skipped. A batch body is generated from durable membership and lists every card, source and commit. Any change after sealing invalidates prior head-specific verification/review.

When review identifies a failing card, preserve its commit in a standalone PR, rebuild the remaining batch without it, update both manifests and rerun verification/review on the changed heads. No silent deletion and no reuse of the old approval. If a finding cannot be attributed to a card, hold the batch for diagnosis; do not guess which card to discard. A rejected card never blocks unrelated cards once attribution is established.

Policy exposes enabled delivery kinds, positive maximum card count, positive maximum wait and high-priority bypass. Retain the operator's proposed defaults; high-priority bypass is an explicit setting, evaluated from trusted card metadata, never prose. Snapshot resolved policy on each batch; edits govern subsequent admission, without silently extending an existing deadline. Plateau must show effective values, validation errors, batch membership/deadline and save/read-back state. Consume the parent's shared policy contract when available; do not create a competing generic policy engine in this adapter.

## MVP

1. **Must:** deliver new filings and prevention cards through the shared coordinator, with one commit per card, separate batches, count/age sealing, durable retry recovery and ordinary reviewed landing. Default prepares remain on their existing fast path.
2. **Must:** refuse admission/publication on unknown policy, invalid limits, lease/head conflict, failed content guard or unverified sealed head. Preserve recoverable pending work and expose the reason; never label uncertain delivery as landed.
3. **Must:** assess docs, config, data, tests and source changes identically for card-only eligibility: any non-card path disqualifies the change, regardless of extension. Card markdown itself still passes content and review gates.
4. **Must:** extract an attributed failed card to its own PR and allow the newly verified remainder to proceed; preserve sources and prevent duplicate delivery.
5. **Epic completion requires:** a scoped Plateau settings slice with persistence and browser tests, the parent-owned policy integration, and opt-in prepare batching preserving stamps and latency/bypass behavior. These are subsequent slices, not features this card silently drops. The WE MVP alone does not resolve this epic.

## Test plan

Add proposed `we:scripts/lib/__tests__/card-batch-policy.test.mjs` for defaults, kind separation, invalid values, bypass and policy snapshots. Add proposed `we:scripts/operations/__tests__/card-batch.test.mjs` for exact count/age boundaries, idle expiry, same-card conflicts and path/type refusals. Add proposed `we:scripts/operations/__tests__/card-batch-io.test.mjs` using temporary real Git repositories and controlled remote/clock adapters: simultaneous producers, stale leases, head races, retries at every publication boundary, source manifests, failed-card extraction and approval invalidation. Assert resulting commits/trees and receipts, not only mocked call counts.

Extend `we:scripts/operations/__tests__/land-prevention-card.test.mjs` to exercise the real admission handoff and retention/retraction behavior on deferred or failed delivery; existing landing behavior is in `we:scripts/operations/land-prevention-card.mjs:304-318`. Extend `we:scripts/operations/__tests__/probation-build-run.test.mjs` for unchanged default prepare delivery and opt-in routing without losing preparation stamps. The Plateau slice must test save/reload, invalid settings, effective policy display and keyboard access in a running browser; assign exact product test files when that slice is prepared.

## Proof plan

For implementation, first make the proposed batch acceptance suite fail against the current per-card delivery seams; then pass it through the production adapter. Run `npx vitest run` with the three proposed batch test files plus the two existing integration suites named above, followed by `node we:scripts/verify-lane.mjs` (strip the documentation locus prefix when executing).

Before enabling production batching, perform an isolated end-to-end driver/observer trial: file three cards, include two concurrent producers, expire a partial batch without a new arrival, restart during publication, and reject one card in review. Observe actual Git history, PR membership, remote heads, checks and final landed trees. Record that the remaining cards land once and the rejected card survives separately. Exercise opt-in prepare plus priority bypass and Plateau policy save/read-back. Record commands, timestamps, heads and outputs in this card. Unit tests alone do not prove the live delivery path.

Compare equal workloads with batching disabled/enabled: card count, PR count, CI executions, review rounds, oldest pending age and prepare-to-build latency. A reduction in PR count without reduced CI executions is partial success and needs explicit follow-up; do not advertise unmeasured savings.

## Follow-ups

- Slice the required Plateau controls, shared policy integration and optional prepare path with concrete file-level scopes including tests; retain parent links so epic completion tracks all three.
- Check actual CI triggers before promising one CI run per batch; adjust draft/publish scheduling in a separately scoped slice if every append still runs CI.
- Carry the testing lesson here: prove durable multi-card delivery and crash recovery with real Git/remote observations; preserve the exact failing/then-passing acceptance output rather than inferring success from a mocked writer call.

## Done when

The proposed batch acceptance suites demonstrate admission, sealing, recovery, rejection extraction and unchanged default prepare delivery; lane verification passes; the live proof records fewer PRs with no lost or duplicate cards; required Plateau/shared-policy/prepare slices are complete. Preserve ordinary review and landing authority throughout.
