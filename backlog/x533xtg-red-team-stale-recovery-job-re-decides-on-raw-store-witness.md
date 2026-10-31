---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:scripts/lib/review-red-team-on-skip.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/operations/__tests__/review-job.test.mjs", "we:scripts/lib/__tests__/review-red-team-on-skip.test.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# Red-team stale recovery: job re-decides on raw store (witness + CAS), split from #6056

Spawned review job re-decides red-team stale recovery itself on the raw store (readRecoveryWitness + CAS admission) so no plan snapshot crosses the process boundary; MVP is the #6039 dead-owner shape only. Split from #6056 (R283). Touches we:scripts/operations/review-job.mjs and we:scripts/lib/review-red-team-on-skip.mjs.

## Acceptance

- [A1] **Executable** - fail-first on #6056 head 79ff567f: matrix rows 9, 10, 12 and test A1 (dispatch argv round-trips to the job CLI parser with no `--red-team-plan`) are red; on the new PR the full matrix, plus the soak breaks `red-team-dead-owner-never-redispatched` and `red-team-skip-never-settles`, are green via the heavy queue. Codex audit: NOT WEAKENED.
- [A2] **Must refuse on error** - an unreadable, corrupt or wrong-schema admission handoff, or any change to the raw store between the daemon decision and the job decision (newer rejecting review, owner revived, status rewritten, marker removed, seat appended), makes the job refuse with no store write and no provider call; the next daemon tick re-plans.

## Non-goals

- [N1] Not the cut items: second bounded re-dispatch with backoff, no-restart claim, card-only head-move carry, daily-cap refund, policy-clear across re-stamp (each is a follow-up card).
- [N2] Does not land or close #6056; it stays parked, and the dead-owner block stays until this PR lands.

## Design

Source: R283 judge pick SPLIT, design v2 (diagnosis from #6056 head 79ff567f).

Diagnosis: the daemon builds a plan, serializes it (`--red-team-plan`), and the job compares it with live store state in a different form. Round 11: `we:skills-src/conveyor/review-daemon.mjs`:1238 passes readRedTeamRecoveryStatus (dead queued becomes finished), so plan.status is normalized; admission (`we:scripts/operations/review-job.mjs`:396-401) re-reads the RAW queued record, and sameRecoveryWriter sees the status differ. Execution never re-decides (identity, supersession and seat rows only; it trusts plan.ownerStale).

One decision, made at execution, on the raw store:

1. The plan does not cross the spawn boundary. Delete `--red-team-plan`, its write (`we:scripts/operations/review-job.mjs`:1363) and its parse (:1518).
2. One reader, readRecoveryWitness(key): RAW writer (bytes, parsed, sha256), markers, seat rows, newest review run for the head of any verdict. Daemon and job both use it. Delete readRedTeamRecoveryStatus.
3. planRedTeamRecovery(witness, {now, probe, deadlineMs}) stays pure; it outputs rawWriter + executionPrior (no `status`).
4. One execution choke point in the job right before the queued admission write: re-read the witness and re-plan (re-probe owner, markers, newer rejecting review means refuse).
5. CAS admission: write only if the raw status digest equals w.rawWriter.sha256 (under the exclusive retry-claim plus atomic rename).
6. Daemon order: abandon first (staleAbandoned), then spawn.
7. Admission handoff job to runner via a versioned codec (schema:1); unreadable or mismatch means refuse.
8. Delete sameRecoveryWriter, recoverySupersessionRefusal, recoverySeatSnapshotMatches, the redTeamPlan fork, the detachedRecovery branch, readRedTeamRecoveryStatus. The PR body lists each deletion.

## MVP

New PR from main, under 600 lines including tests. Port from main using #6056's planner as reference.

- In scope: the #6039 shape only. Dead running owner (local dead PID, or foreign/unprobeable past WE_RED_TEAM_STALE_RUN_MS), truncated running payload, completed seat behind a dead owner (resume). One abandon plus one re-dispatch. Payload comes from the newest-run reader, never status.loopPayload.
- Cut (follow-up cards): second bounded re-dispatch with backoff, no-restart claim, card-only head-move carry, daily-cap refund, policy-clear across re-stamp.

## Test plan

- A. Spawn-boundary round-trips: (1) dispatch argv deep-equals the review-job CLI parser result, with no `--red-team-plan`; (2) admission file codec round-trip, and corrupt/missing/wrong-schema gives a refusal with no provider call; (3) persisted handoff: job1 status, dead, daemon tick, job2 arc, published; (4) gate: every flag('x') has a test naming `--x`.
- B. Choke-point mutations between the daemon and job decision: newer rejecting review, owner revived, status rewritten, marker removed, seat appended gives a refusal, no write, no call, and the next tick re-plans.
- C. Lint: the red-team-only path imports no store reader except readRecoveryWitness.

Matrix (daemon tick, argv, job, arc; ticks 1-2; never pending after tick 2):

1. e492d241 stale timeout differs from default: published
2. e492/effa/67c1 foreign owner past deadline: published
3. 921413f9 aged foreign owner plus daily-cap deferral: restored, published on tick 2
4. c98bf4ec payload findings.read only: published
5. 04d27192 replacement in the same second as the marker: published once
6. bfdb5352 completed seat behind dead owner: resume, published
7. 3d522cf9 transient guard failure after admission: status retained
8. 4ca0f15f resume truncated payload: published
9. 79ff567f dead QUEUED writer, null result, no rows (:401): published
10. 79ff567f newer same-head rejecting review (:154): refused, no call
11. 79ff567f plan-free CLI handoff (:1363): covered by A1-A3
12. 79ff567f live owner revived (security :393): refused
13. 3d522cf9 adv no-restart after newer review (:577): refused
14. control, live local owner within deadline: skip, in flight

## Proof plan

- Fail-first on 79ff567f: rows 9, 10, 12 and A1 red.
- New PR: matrix plus soak breaks `red-team-dead-owner-never-redispatched` and `red-team-skip-never-settles` green via the heavy queue. Codex audit NOT WEAKENED.
- Stop rule: max 2 red-team rounds on the new PR; a broken break outside witness plus CAS becomes a card and parks.

## Follow-ups

- we:backlog/xkjna3x-red-team-recovery-second-bounded-re-dispatch-with-backoff-fo.md
- we:backlog/x19xrqc-red-team-recovery-card-only-head-move-carry-follow-up-to-x53.md
- we:backlog/x3lkept-red-team-recovery-daily-cap-refund-on-deferral-follow-up-to.md
- we:backlog/x8szm3q-repo-wide-gate-every-cli-flag-has-a-test-naming-it-follow-up.md
- Close #6056 linking the new PR and this design, once the new PR lands (not done by this card).

Critical files: we:scripts/operations/review-job.mjs (:300, :310, :390-440, :1150-1232, :1363, :1518); we:scripts/lib/review-red-team-on-skip.mjs (:82, :154, :292, :400-590); we:skills-src/conveyor/review-daemon.mjs (:1238); we:scripts/operations/review-extra-seats.mjs; we:scripts/lib/drain-red-team-evidence.mjs.

## Edge cases this change must handle

1. **Untrusted text** - n/a: the witness is parsed from our own store files; parse failure refuses.
2. **Truncated reads** - truncated running payload is in scope; a corrupt or truncated witness or handoff refuses (A2).
3. **Shared state files** - CAS on the raw status digest under the exclusive retry-claim plus atomic rename.
4. **Fail closed** - any witness mismatch, unreadable codec or unprobeable state refuses with no write and no provider call.
5. **Identity scoping** - the witness is keyed per key and head; a newer review for another head does not count.
6. **State over time** - re-plan at the choke point right before admission; ticks 1-2 never leave pending.
7. **Who wrote it** - the raw writer bytes and sha256 are read, never a normalized status.
