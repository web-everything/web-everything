---
bornAs: xuj2m36
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/ci-heal-escalation-mark.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs", "we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs", "we:scripts/conveyor/__tests__/ci-heal-escalation-base-rearm.test.mjs", "we:scripts/__tests__/multi-repo-checks.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-14"
preparedAgainstSha: "6d77e9169e764d4787a9348b5fafd81ee04b0fed"
tags: []
---

# A stand-down whose red is inherited from the stack base routes to the base fixer, not the operator

Held finding 234 reported that child PR #4880 stopped for a human because its red belonged to bottom PR #4797. Preserve the goal: route demonstrated base-owned failures to that base's fixer, keep the child waiting, and refresh the child after the base changes. Also verify the reported discrepancy between the base's green CI and the local multi-repository lint; do not assume a missing CI gate without reproducing the same tree and inputs.

## Progress

- Rechecked at 6d77e9169. Original premise: inherited red only had a human stand-down route; scope named `we:scripts/conveyor/reconcile-core.mjs` and `we:scripts/conveyor/ci-red-recovery-watch.mjs` without tests. That premise is partly obsolete. Commit f78d45bf1 added inherited-base escalation, the base note and base-head rearming; 866f5a08a made base reads repository-explicit and mapped the worker outcome. This is partial delivery, not completion of this card.
- Current evidence: `we:scripts/conveyor/ci-heal-escalation-mark.mjs:101` requires base identity, line 250 builds a base-fixer note, and line 540 posts it best-effort. `we:scripts/conveyor/reconcile-core.mjs:2932` recognizes inherited red and waits without describing it as a human decision. Existing preservation tests are `we:scripts/conveyor/__tests__/ci-heal-escalation-base-rearm.test.mjs:40` and `we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs:522`. The worker is already instructed to use this outcome by `we:skills-src/conveyor/fix-agent-ci-brief.md:279`.
- Remaining gap: the base note is prose plus identity, not a consumed fix request. Searching the inherited-base-note marker finds its producer and tests, but no planner consumer. A failed base-note write is only logged; it is not retried by that CLI. Base movement re-arms healing, which is not itself proof of an automatic restack. The existing guarded stack restacker is `we:scripts/conveyor/ci-red-recovery-watch.mjs:925`; reuse it rather than writing new Git plumbing.
- Corrected scope adds the escalation producer/parser, three existing matching source tests, existing rearm preservation tests, and the existing lint parity test. The alleged lint gate is `we:scripts/__tests__/multi-repo-checks.test.mjs:29`, not a standalone script. It is already included in unit tests (line 38); its local changed-file/full-tree inputs differ at line 17. No evidence yet supports editing a CI workflow or weakening that scanner. Historical run logs and exact trees are still needed to establish the incident cause.
- Size 2 → 5: approximately 100 changed escalation/evidence lines, 100 planner lines, 130 recovery-watch lines, 260 lines across the four conveyor test files, and 40 lint parity assertions. This covers durable retry and real-Git restack checks omitted from the two-file estimate. The standards scope check requires the existing matching core/watch test homes, so the new regressions belong there rather than in new focused files. Keep all other metadata unchanged; no dependency edit or preparation stamp.

## Design

Use the existing inherited-base escalation as the durable child-side request. Extend its structured evidence in `we:scripts/conveyor/ci-heal-escalation-mark.mjs` with the failed required-check identity and attributed paths, tied to repository, child PR/head and base PR/head. Retain compatibility when reading older markers, but an old free-text note without sufficient evidence must not authorize a new base fix. A trusted worker's diagnosis supplies the candidate attribution; complete live base/head and net-diff evidence must confirm it before dispatch. A filename in a log alone does not prove causality: require the same failure on the recorded base tree, and show the implicated change is outside the child's net diff. Source, docs, config and data are all subject to the same checks.

In `we:scripts/conveyor/ci-red-recovery-watch.mjs`, reconcile that durable request against current open PRs and complete trusted comments. Recheck the child/base relationship and both SHAs before side effects. Post an idempotent base fix-request note keyed by the full incident tuple, including its evidence; if posting fails, keep the child request pending and retry on a later sweep. Read-back of a matching trusted base note prevents repeated posts across restarts. An incomplete listing, ambiguous parent, fork or unavailable read defers without dispatch or mutation. Never infer authorization from quoted markers or a statement in an arbitrary PR body.

In `we:scripts/conveyor/reconcile-core.mjs`, consume a verified inherited-base request as a base-owned fix through the existing fix dispatch, claim, scope and round-cap gates. Do not impersonate an operator send-back or create an extra round allowance. A green base check does not erase a reproduced local failure; carry the exact reproducer into the fix brief. Represent the child as waiting on the named base until its evidence changes. Do not automatically erase an unrelated human question: only a stand-down whose entire blocking reason is this same verified inherited incident can be superseded. Missing attribution, mixed child/base edits or a genuine design question retains the existing refusal.

After the base head moves, the recovery watch uses the existing same-repository, claim-aware stack restacker. Refresh against newly read tips, respect the existing expected-head push protections, and wait for the new child checks before declaring recovery. A changed base is a retry trigger, not evidence that its defect is fixed. Failed or conflicting restacks remain visible and retry under existing caps; do not fall back to editing base-owned files on the child. The planner must not launch child healing concurrently with an owed restack for the same incident.

For CI parity, compare the original base and child tree SHAs, workflow revision, test selection and scan environment with the reported local run. `we:scripts/__tests__/multi-repo-checks.test.mjs` already exercises the scanner in unit CI. Pin the incident violation in its negative controls and verify that both full-tree and scoped local runs reject it when in scope. Do not claim the cause was a missing gate. If the evidence instead reveals a workflow-selection defect, record the exact failing fixture and correct the touch set before implementing that additional fix; do not silently add a speculative workflow edit.

## MVP

- Structured, head-bound attribution on the existing child escalation, with trusted parsing and unchanged refusal on incomplete proof.
- An idempotent, retried base fix request consumed by normal planner authorization and budgets; child waiting state names the base.
- Automatic guarded restack after base movement, followed by fresh CI rather than immediate success.
- Incident-specific lint parity evidence and regression, preserving the existing scanner policy.

## Test plan

Run all scoped tests through Node on `we:scripts/readiness/heavy-admission.mjs` using `run -- npx vitest run` followed by filesystem paths; strip documentation-only repository prefixes for execution. Run the standards gate through the same queue. Preparation itself does not claim these planned tests pass.

In `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`, an eligible trusted base request yields one base fix and no child fix/human handoff. Cover a green base with a reproduced local lint failure, a spent cap, an active base claim, duplicate requests and an unchanged incident on the next pass. Negative controls include forged authors, stale child/base SHAs, quoted markers, incomplete comments, unrelated stand-downs, ambiguous attribution and child-owned changes. Parameterize source/docs/config/data paths. Removing the evidence guard must fail these negatives; removing routing must fail the positive control.

In `we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs`, use isolated real-Git parent/child refs plus injected forge calls. Fail the first base-note post, restart the sweep and observe one successful retry; an existing trusted exact-tuple note suppresses duplicates. Advance the base, restack once and prove the new base is an ancestor of the child while child-owned content remains. A third sweep does no duplicate work. Cover concurrent head movement, claims, forks, ambiguous parents, truncated listings, missing refs and merge conflicts: no unsafe push and no false recovered status. Observe the updated child's check result before completing the incident.

Extend `we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs` for structured evidence round-trips and malformed identity rejection. Preserve `we:scripts/conveyor/__tests__/ci-heal-escalation-base-rearm.test.mjs` for old marker compatibility and base-head rearming. In `we:scripts/__tests__/multi-repo-checks.test.mjs`, reproduce the actual incident pattern in isolated full-tree and changed-file scan fixtures; do not weaken allowlists to make the fixture green.

## Proof plan

Record producer → request retry → base planner → waiting child → moved base → restack → fresh check observations, including exact repo/PR/head tuples and before/after Git ancestry. Show the current implementation fails the new end-to-end routing regression despite its already-green escalation tests. Keep simulated forge evidence separate from live delivery evidence.

For the historical CI discrepancy, capture the base run's tested SHA, workflow SHA, job/test selection, and the failing local tree and scan inputs. Replay the lint on matching trees through the heavy queue. If the original evidence is unavailable, say the historical cause is unproven and retain the independently reproducible regression; do not report the incident diagnosed. Before claiming operational recovery, observe an authorized real stacked failure proceed through base repair and child refresh. Do not mutate production PRs during preparation.

## Non-goals

No human-question auto-answering, new takeover allowance, increased fix budget, broad stand-down clearing, scanner relaxation, or edits of base-owned files in the child's lane. No new receive endpoint or network API is introduced.

## Edge cases this change must handle

- Untrusted text and identity: trusted leading markers plus current repository/PR/head and net-diff evidence; text is never shell input or sufficient authorization.
- Truncated reads and failures: defer on unknown ownership, missing comments or failed probes, preserving the pending child request for retry.
- Shared state and restart: reuse durable comments and existing claims; read-back deduplication must survive crashes before/after posting and restacking.
- Time: changed heads invalidate old authorization; base movement requests reevaluation, never declares a fix successful.
- Refusal: unrelated questions, caps, forks, conflicting writes and mixed attribution remain refused, including non-source inputs.
- Endpoint controls: not applicable to this polling consumer of existing forge APIs; use the existing bounded reads and write/claim protections.

## Follow-ups

Any proven CI workflow-selection defect must gain its specific workflow and matching test scope before implementation. Broader historical stand-down migration and cross-repository stack support are separate work. Measure duplicate-request and restack outcomes before introducing a new persistent incident store.
