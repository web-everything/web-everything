---
bornAs: xfwi0hm
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core-exhaustion-notes.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-notes.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-16"
preparedAgainstSha: "1ca5edb490fbc03fe55aee05985107d6272c4628"
tags: []
---

# Advisory-fix cap note parks to the operator once takeovers are spent

Held finding 246: terminal advisory-fix exhaustion should request the same operator parking as terminal ordinary-fix exhaustion, after the existing takeover and owed-review paths have had their turn.

## Progress

- Revalidated at checkout 1ca5edb490 on 2026-10-16: the fix-only predicate remains; corrected the moved planner citations below. Existing scope and size 1 remain appropriate. This preparation changes no runtime behavior.

- Rechecked at 37d55ee65. Original premise: only generic fix exhaustion requests parking, so advisory exhaustion never reaches the operator queue; original scope was only `we:scripts/conveyor/reconcile-core.mjs`. The first part remains true at `we:scripts/conveyor/reconcile-core.mjs:2250`; the queue claim was too broad. Advisory repairs commonly already carry review:human, and the consumer explicitly skips relabeling those PRs at `we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:422`. Parking is an idempotent intent, not a guarantee that every exhausted PR is immediately merge-ready in the operator queue (`we:scripts/operations/operator-queue.mjs:168`).
- Corrected scope adds the canonical planner suite, its exhaustion suite and the daemon note-consumer suite. The standards gate requires the canonical matching test `we:scripts/conveyor/__tests__/reconcile-core.test.mjs` in scope as well as the focused exhaustion suite. The focused exhaustion suite explicitly pins the old fix-only behavior at `we:scripts/conveyor/__tests__/reconcile-core-exhaustion-notes.test.mjs:463`; the daemon suite already tests the injected parking port at `we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-notes.test.mjs:199`. No consumer implementation change is needed.
- Retain size 1: about 5 source lines, 65 planner-test lines and 30 consumer-test lines. Takeover selection precedes terminal exhaustion at `we:scripts/conveyor/reconcile-core.mjs:2163`; awaiting-review refusal returns before the note at `we:scripts/conveyor/reconcile-core.mjs:2243`. Preserve those boundaries.

## Design

Set parkToHuman for terminal capKind advisory-fix as well as fix in the shared exhaustion-note builder. Keep capKind, attempts, cap, takeover reason and note identity unchanged. Do not move parking before takeover selection or past-cap review grants. The existing daemon consumes the flag and performs its checked label transition only when review:human is absent; an already parked advisory PR remains parked without another write.

## MVP

Extend the terminal note predicate, update the existing cap-kind matrix, and add enabled-takeover and consumer regressions. Review, conflict-fix and stacked-rebase retain their existing parking behavior. No cap, allowance, label-transition policy or operator-queue classification changes.

## Test plan

In `we:scripts/conveyor/__tests__/reconcile-core-exhaustion-notes.test.mjs`, expect parking for fix and advisory-fix only. Build a trusted advisory-fix fixture at its durable cap with automatic takeovers enabled: eligible takeover dispatches without a terminal park; spent budget and nonconvergence refuse and emit the parking note; awaiting a takeover review must not park early. Preserve disabled/person-mode terminal exhaustion. Include no-findings and below-cap controls.

In `we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-notes.test.mjs`, feed the advisory note to the injected consumer. Assert exactly one checked parking call when unparked, none when already review:human or dry-run, and visible failure on a rejected label transition. No real forge calls. Preserve the broader advisory-routing assertions in `we:scripts/conveyor/__tests__/reconcile-core.test.mjs`; run all three scoped suites via the host heavy queue, followed by the queued standards gate.

## Proof plan

Show the existing planner fixture producing advisory-fix exhaustion without the flag before the change and with the flag afterward. Retain injected-consumer output showing the label transition request and the already-parked no-op. Demonstrate that the eligible takeover still dispatches and no terminal note appears. This proves the planner-to-consumer contract; it does not claim that an advisory:changes PR passes the operator queue's readiness gates. Do not modify a live PR for proof.

## Acceptance

Terminal advisory-fix exhaustion requests operator parking. Takeovers and owed reviews retain priority, no extra worker is authorized, and repeated parking is idempotent.

## Non-goals

No new takeover entitlement, queue rewrite, automatic human clearance or cap reset.

## Edge cases

Untrusted or truncated evidence must not gain a new allowance; existing planner refusals remain authoritative for source, docs, config and data findings. Preserve repo/PR/head identities and durable episode deduplication. No new state store or receive/write endpoint is introduced; existing label-port error handling remains required.

## Follow-ups

If queue visibility remains missing for an already parked PR, diagnose its actual queue gates separately. Do not weaken advisory or CI readiness to make this parking test pass.
