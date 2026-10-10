---
bornAs: xeshb3g
kind: story
size: 8
parent: "3007"
status: resolved
dateOpened: "2026-08-21"
dateResolved: "2026-10-09"
graduatedTo: 0df402031197876446f2f2cfd35ab6573217f1ac
preparedDate: "2026-10-02"
preparedAgainstSha: "e7d2d9cad6017871fe726fa4a519534de741e8e5"
tags: []
scope:
  - we:scripts/lib/verdict-ledger.mjs
  - we:scripts/lib/__tests__/verdict-ledger.test.mjs
  - we:scripts/lib/git-transport-branch.mjs
  - we:scripts/lib/__tests__/git-transport-branch.test.mjs
  - we:scripts/lib/review-label-provider.mjs
  - we:scripts/operations/record-verdict-io.mjs
  - we:scripts/operations/record-verdict.mjs
  - we:scripts/operations/__tests__/record-verdict.test.mjs
  - we:scripts/operations/__tests__/record-verdict-integration.test.mjs
  - we:scripts/operations/effect-executor.mjs
  - we:scripts/operations/__tests__/effect-executor.test.mjs
  - we:scripts/operations/review-pr.mjs
  - we:scripts/operations/__tests__/review-pr.test.mjs
  - we:scripts/operations/review-pr-io.mjs
  - we:scripts/operations/__tests__/review-pr-io.test.mjs
  - we:scripts/review-set-label.mjs
  - we:scripts/__tests__/review-set-label.test.mjs
  - we:scripts/review-ledger-check.mjs
  - we:scripts/__tests__/review-ledger-check.test.mjs
  - we:scripts/pr-status.mjs
  - we:scripts/__tests__/pr-status.test.mjs
  - we:scripts/apply-review-request.mjs
  - we:scripts/__tests__/apply-review-request.test.mjs
  - we:.github/workflows/apply-review-request.yml
  - we:scripts/lib/verdict-ledger-io.mjs
  - we:scripts/lib/__tests__/verdict-ledger-io.test.mjs
  - we:scripts/lib/__tests__/verdict-ledger-io-integration.test.mjs
  - we:scripts/merge-ai-prs.mjs
  - we:scripts/__tests__/merge-ai-prs-drain-verdict-ledger.test.mjs
  - we:scripts/review-runner.mjs
  - we:scripts/__tests__/review-runner.test.mjs
  - we:backlog/3255-move-the-verdict-ledger-onto-the-ops-review-requests-git-tra.md
  - we:backlog/3007-make-the-review-verdict-ledger-the-merge-authority-labels-be.md
  - we:backlog/3215-ledger-the-holds-the-drain-applies-itself-not-just-the-revie.md
  - we:backlog/3216-revisit-the-ledger-write-miss-posture-before-the-authority-m.md
  - we:backlog/3217-the-shadow-reviewer-must-append-its-would-clear-decisions-to.md
scopeRationale: "The ledger write moves onto the ops/review-requests git transport (we:scripts/lib/git-transport-branch.mjs, we:scripts/operations/record-verdict-io.mjs's resolveTransportRoot pattern), which is a git push — we:.github/workflows/apply-review-request.yml currently declares contents:read only and may need contents:write for that push. Consumers/renderers of the ledger (we:scripts/review-set-label.mjs's durable-comment mirror, we:scripts/review-ledger-check.mjs, we:scripts/pr-status.mjs, we:scripts/operations/effect-executor.mjs, we:scripts/operations/review-pr.mjs, we:scripts/operations/review-pr-io.mjs, we:scripts/lib/review-label-provider.mjs) and their tests are included since the ledger's storage and read-back contract changes under them. we:backlog/ covers this item's own frontmatter plus the blockedBy retarget on #3007/#3215/#3216/#3217."
---

# Move the verdict ledger onto the ops/review-requests git transport, as #3214 ruled

Implement the ratified A′ storage migration: durable shared JSONL on the `ops/review-requests` branch, a replaceable git IO shell, bounded fetch–append–retry with loud exhaustion, and a durable comment rendered from the ledger record. The standing rule is [state lives where its nature dictates](we:docs/agent/platform-decisions.md#state-lives-where-its-nature-dictates), specifically `we:docs/agent/platform-decisions.md:3675-3701`; the comment-mirror requirement is decision lineage in `we:backlog/3214-where-the-verdict-ledger-lives-once-it-is-the-merge-authorit.md:71-84` under “A′ — what is actually ruled”. This preparation changes only this card; the scope lists the subsequent implementation touch-set.

## Progress

Premise checked against the current checkout on 2026-10-02:

- **Storage remains unbuilt.** The old premise called `verdictLedgerDir()` a JSONL path. It actually returns a directory, with environment/test overrides and a home-directory default; `verdictLedgerPath(repo)` adds the filename (`we:scripts/lib/verdict-ledger.mjs:809-853`). Append is still a local filesystem write, guarded by a machine-local lock, and read swallows filesystem errors as an empty ledger (`we:scripts/lib/verdict-ledger.mjs:870-899`). This cannot provide cross-host durability.
- **Ordering correction.** The old body attributed a blanket label-before-ledger rule to the CLI. The CLI actually appends before the swap, while the declared operation reconciles after its label effect (`we:scripts/review-set-label.mjs:1265-1288`, `we:scripts/operations/review-pr-io.mjs:693-725`). Preserve those distinct seams and the conditional comment/swap order (`we:scripts/review-set-label.mjs:1369-1410`); storage migration is not authorization to reorder effects.
- **Dependency correction.** The old claim that all four dependents are open behind only resolved #3214 is stale. #3007 already includes #3255 (`we:backlog/3007-make-the-review-verdict-ledger-the-merge-authority-labels-be.md:4-5`); #3216 already blocks on #3255 (`we:backlog/3216-revisit-the-ledger-write-miss-posture-before-the-authority-m.md:5-6`). #3215 and #3217 are resolved and retain #3214 (`we:backlog/3215-ledger-the-holds-the-drain-applies-itself-not-just-the-revie.md:6-7`, `we:backlog/3217-the-shadow-reviewer-must-append-its-would-clear-decisions-to.md:6-7`). Their implemented writers now also need coverage: `we:scripts/merge-ai-prs.mjs:2499` and `we:scripts/review-runner.mjs:202-216`.
- **Transport correction.** The reusable helper stages predetermined bytes and pushes once; it does not merge concurrent JSONL appends (`we:scripts/lib/git-transport-branch.mjs:112-146`). Repeatedly pushing the same stale bytes is insufficient. Repo ownership and branch genesis already have reusable seams (`we:scripts/operations/record-verdict-io.mjs:104-119`, `we:scripts/operations/record-verdict-io.mjs:138-185`).
- **Scope correction.** Retain the existing consumer/test coverage, add a proposed artifact IO shell plus unit/real-git integration suites and the two newer writers/tests, and replace the broad backlog directory with the five specific cards. The preserved frontmatter rationale describes the original scope; these evidence-backed corrections supersede its broad-directory and all-four-retarget assumptions.
- **Historical incident qualification.** The original filing reported PR #1523 round 2 losing a runner-local row after a credential-less label failure. That incident was not replayed during this preparation and is not proof of the current production state. The local append above and the workflow's main checkout/applier path (`we:.github/workflows/apply-review-request.yml:55`, `we:.github/workflows/apply-review-request.yml:91-114`) substantiate the storage failure mechanism without claiming a fresh live observation.

## Design

1. **One artifact boundary.** Introduce `we:scripts/lib/verdict-ledger-io.mjs` (proposed), owning repo-root resolution, git refresh/read, append, retry and cleanup. Keep record validation, parsing and folding independent of git; their current seams are `we:scripts/lib/verdict-ledger.mjs:361-418`, `we:scripts/lib/verdict-ledger.mjs:427-550`. Preserve the public ledger facade for callers, so the eventual shared-store replacement changes this shell. The destination remains the shared durable store under the existing migration trigger, not a permanent git database (`we:docs/agent/platform-decisions.md:3685-3701`).
2. **Branch-backed paths and fresh reads.** Store each repo's JSONL under a ledger-specific directory on its own transport branch, outside the request glob. Resolve the owning checkout explicitly using the existing refusal behavior (`we:scripts/operations/record-verdict-io.mjs:104-119`). A returned local path denotes a refreshed transport snapshot, never the caller's feature-branch file or the machine-global authority. Distinguish a successfully fetched branch with no ledger yet from fetch/read failure; do not inherit the current blanket empty-result catch (`we:scripts/lib/verdict-ledger.mjs:896-899`). Keep test storage explicitly isolated and avoid production fallback to a home ledger on transport failure.
3. **Append transaction.** Validate once, retain the same normalized record across attempts, fetch the latest explicit branch ref, read its JSONL, append one row, commit and push without force. On a confirmed non-fast-forward, refetch and reconstruct from the new remote bytes before a bounded retry. Preserve all preceding rows and concurrent request files. Exhaustion and non-contention failures report a durable-write failure, never `ok: true`; an uncertain push outcome requires read-back before retry to avoid duplicating that attempt. Use unique detached worktrees so writers in the same checkout do not share a checked-out branch or timestamp-only directory. The existing helper's shared branch checkout and one-shot tail are the extension seams (`we:scripts/lib/git-transport-branch.mjs:89-125`, `we:scripts/lib/git-transport-branch.mjs:130-146`); preserve existing request callers' behavior.
4. **One record, comment as projection.** Today the comment is built separately before the record, and the record lacks the write-up and carried-clearance rendering data (`we:scripts/review-set-label.mjs:1241-1260`, `we:scripts/review-set-label.mjs:1314-1333`, `we:scripts/lib/verdict-ledger.mjs:361-418`). Add optional, validated mirror data sufficient to reproduce the comment, retaining old-row readability. Build and size-check the projection before any write, persist that same record, and publish the projection from the returned normalized record. Preserve attribution, findings, coverage markers and human-clearance data; do not rebuild authoritative fields from separate arguments. Keep the Phase-1 visible failure posture and leave its Phase-2 policy change to #3216 (`we:scripts/review-set-label.mjs:1284-1288`); a failed append must remain explicitly non-durable, not be reported as a persisted mirror.
5. **All producers and consumers.** Route direct review, operation reconciliation, drain holds and shadow observations through the same facade; ensure reconciliation reads the refreshed ledger (`we:scripts/operations/review-pr-io.mjs:702-725`). Refresh checker and status reads (`we:scripts/review-ledger-check.mjs:185`, `we:scripts/pr-status.mjs:137`). Keep observed rows non-bearing and retain append-order identity rather than inventing content-hash identity (`we:scripts/lib/verdict-ledger.mjs:39-47`, `we:scripts/lib/verdict-ledger.mjs:412-416`).
6. **Runner integration.** Change the applier token's contents permission to permit the ledger push, retaining the main checkout and request-only trigger (`we:.github/workflows/apply-review-request.yml:33-38`, `we:.github/workflows/apply-review-request.yml:55`). Ledger-only pushes must not apply requests again. Use the existing board-genesis and ownership checks; deploy compatible executable/workflow code to the board as part of rollout, since the applier checks that the workflow rides the board (`we:scripts/operations/record-verdict-io.mjs:198-213`).

## MVP

Deliver the branch-backed shell, refreshed read facade, lossless retry loop, reproducible comment projection, and applier permissions together. Preserve the existing label-based merge gate and operation ordering; do not flip Phase 2 as part of this card (`we:scripts/lib/verdict-ledger.mjs:5-9`, `we:scripts/operations/review-pr-io.mjs:693-695`).

Recheck the four dependency cards at implementation time. Keep the already-present #3255 edges on #3007/#3216; replace the historical #3214 blocker with #3255 on #3215/#3217 as originally requested without reopening their completed writer work. Do not remove unrelated blockers. Their current states and exact files are cited in Progress.

No automatic import of historical home files or reconstruction from comments: the current store has only local append order (`we:scripts/lib/verdict-ledger.mjs:870-899`), so this migration must not manufacture a cross-host ordering. Retain any old files for inspection; new production writes and reads use the transport store.

## Test plan

- Capability (Red today): extend `we:scripts/lib/__tests__/verdict-ledger.test.mjs:494-598` for branch-path resolution and explicit isolated test storage, preserving serializer/fold regressions (`we:scripts/lib/__tests__/verdict-ledger.test.mjs:251-328`) and observed-row semantics (`we:scripts/lib/__tests__/verdict-ledger.test.mjs:670-721`). Add unit cases in proposed `we:scripts/lib/__tests__/verdict-ledger-io.test.mjs` for invalid input, retry classification, exhaustion, ambiguous-push read-back, missing file versus unreadable transport, and cleanup.
- Capability (Red today): add proposed `we:scripts/lib/__tests__/verdict-ledger-io-integration.test.mjs`: temporary bare origin, two independent clones/processes synchronized after reading the same tip, two real append calls, one forced push rejection, and a third clone reading both rows exactly once. Assert retry actually occurred, prior bytes/request files survived, and no home-ledger write occurred. Also exercise same-checkout concurrent writers, narrow clones, branch genesis, wrong-repo refusal and permanent push rejection. Reuse the real-git fixture approach at `we:scripts/operations/__tests__/record-verdict-integration.test.mjs:149`, not a mocked concurrency success.
- Preservation (GREEN today): extend scoped transport and operation suites for unchanged request staging and label-before-reconciler sequencing; cover failed append results without a false durable success. The production seams are `we:scripts/lib/git-transport-branch.mjs:62`, `we:scripts/operations/review-pr-io.mjs:696` and `we:scripts/operations/effect-executor.mjs:58`. Mutation proof: reverse the declared label/ledger effect order or bypass the unknown-target refusal; the preservation cases must fail.
- Capability (Red today): extend the scoped review-label/applier tests to compare posted bytes with the persisted-record projection, including full write-up, identity, coverage, carried clearance, oversize refusal, first accept, re-accept and append failure. Preserve the existing order and size guards (`we:scripts/review-set-label.mjs:1245-1260`, `we:scripts/review-set-label.mjs:1407-1410`). Assert workflow contents-write permission and that ledger-only changes miss the request trigger (`we:.github/workflows/apply-review-request.yml:33-38`).
- Capability (Red today): extend `we:scripts/__tests__/merge-ai-prs-drain-verdict-ledger.test.mjs` and `we:scripts/__tests__/review-runner.test.mjs` for transport durability of their existing producers (`we:scripts/merge-ai-prs.mjs:2499`, `we:scripts/review-runner.mjs:202`). Run all affected suites listed in scope, standards, then the required lane verifier; do not substitute only related-test discovery for the lane gate.

## Proof plan

Before declaring the implementation complete, retain real-git test output showing the rejected first push, successful retry and third-clone JSONL containing both rows. Demonstrate exhaustion produces a visible failure and no success result. Capture transport commit IDs and cleanup evidence; verify the caller's branch and worktree are unchanged. These prove the contention requirement in `we:docs/agent/platform-decisions.md:3694-3699`.

Then exercise one authorized review request end to end through the deployed applier: record its request commit and workflow run, verify the row is committed on the transport branch, remove the disposable runner checkout, and read that row from a fresh clone without a GitHub API token. Compare the posted comment with a projection of that row, and show the ledger-only push did not reapply the request. Public git read access is the credential-less condition, not a claim that arbitrary private origins need no authentication. The path being proved is `we:.github/workflows/apply-review-request.yml:74-114`. If live execution is unavailable, report that proof as pending; unit tests alone do not establish runner durability. This card-only preparation performs no live label mutation or transport push.

## Follow-ups

- #3216 owns the Phase-2 write-miss policy; #3007 owns the authority flip and agreement evidence (current dependency edges cited in Progress). Do not quietly change either policy while replacing storage.
- The shared-store migration remains tied to the standing trigger (`we:docs/agent/platform-decisions.md:3701`). Any historical home-ledger consolidation needs a separately reviewed ordering/provenance plan; this card supplies no inferred historical rows.
- Testing lesson for the implementation: synchronize real competing processes at the fetched-tip boundary and assert rejection/retry, not merely two eventual rows. Mocked successful pushes do not exercise the one-shot helper's non-fast-forward failure (`we:scripts/lib/git-transport-branch.mjs:145`). Keep this lesson here rather than editing shared agent documentation.
