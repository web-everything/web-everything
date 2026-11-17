---
kind: task
status: open
dateOpened: "2026-11-17"
tags: [daemon, probation, prevention]
related: ["8409"]
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-rebuild/probation.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs", "we:scripts/conveyor/soak/breaks/"]
---

# Prevention: classify boot rollback refusals and retry transient contention

PR #6882's 2026-11-17 advisory requests this follow-up. In
`we:scripts/lib/daemon-self-sync.mjs:1138`, boot recovery is memoized. A
`rollback-lock-timeout` with HEAD still at the failed SHA skips every later tick
without another attempt, even after a reader releases. The existing injected
case `boot rollback runs once before any read lease and refusals skip ticks: refused`
in `we:scripts/lib/__tests__/daemon-self-sync.test.mjs` pins this behavior.
The current fail-closed stall remains in S2a; this card changes retry policy.

## Design

Classify results before deciding whether to retain the memoized boot result.
The table is the intended policy for this follow-up, not current behavior.
Re-read adoption identity, marker bytes and HEAD on every recovery attempt.

| Result | Class | Required action |
| --- | --- | --- |
| `probation-lock-held` | Transient | Retry at a later tick with bounded backoff. |
| `rollback-lock-timeout` | Transient | Retain evidence, skip failed-head ticks and retry after backoff. |
| `head-unresolved` | Transient evidence failure | Bounded retry; keep evidence and needs-you on exhaustion. |
| `rollback-request-unreadable`, `rebuild-state-unreadable`, `proven-good-unverified` | Persistent evidence refusal | Keep evidence, skip and alert once until operator repair/restart. |
| `rollback-failed` or unknown refusal | Unclassified; persistent by default | Fail closed; do not infer retry safety from an exception alone. |
| Thrown hook or malformed result | Persistent evidence refusal | Retain evidence, skip and alert once; an exception cannot admit a failed-head tick. |
| `adoption-changed`, `rollback-request-changed`, `superseded` | Identity changed | Discard the stale attempt and revalidate the current adoption and loaded HEAD. |
| `ok: true` or `restartRequired: true` | Recovery requires retirement | Use the caller's drain and lease release before restart. |

Use a capped next-attempt time checked at tick entry, without an independent
timer or an overlapping recovery task. Keep unknown/expired readers intact.

## Acceptance

- A1: Planned `boot rollback refusal policy covers every result and unknown reason`
  in `we:scripts/lib/__tests__/daemon-self-sync.test.mjs` must assert each table
  row's retry/skip/restart action, and persistent fallback for unknown reasons.
- A2: Planned `released reader permits boot rollback on a later tick after timeout`
  in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must hold a
  reader through a timeout, assert failed HEAD/marker/reader remain unchanged
  and a `probation-needs-you` alert names `rollback-lock-timeout`, release it,
  advance the controlled clock through backoff and assert rollback applies once
  on a later tick without running failed code.
- A3: Planned `boot rollback backoff prevents overlap and preserves a newer adoption`
  in `we:scripts/lib/__tests__/daemon-self-sync.test.mjs` must assert no retry
  before backoff, one in-flight attempt, and no C mutation/restart when B's
  recovery becomes stale during the wait.
- A4: Planned `reader contention clears without an operator restart` in
  `we:scripts/conveyor/soak/breaks/probation-boot-rollback-retry.soak.test.mjs`
  must exercise a real held reader and its release through the boot hook,
  assert bounded recovery, no lease reclamation, and caller-owned drain before
  the single restart. Register the scenario in the soak break index.

## Test plan

- Preservation (GREEN today for persistent refusals): `boot rollback refusal policy covers every result and unknown reason`
  in `we:scripts/lib/__tests__/daemon-self-sync.test.mjs` covers
  `rollback-failed` and unknown refusal defaults: assert evidence is retained,
  no tick runs and no retry is scheduled. Mutation proof: treating an unknown
  reason as success or a transient retry must fail these assertions. The
  transient rows are capability cases and must fail on S2a's memoized timeout.
  Thrown-hook and malformed-result rows are capability cases (Red today):
  assert neither can authorize a failed-head tick.
- Capability (Red today): `released reader permits boot rollback on a later tick after timeout`
  in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` fails on S2a
  because no retry occurs. Assert the later successful reset, single restart
  and named alert, as specified by A2.
- Capability (Red today): `boot rollback backoff prevents overlap and preserves a newer adoption`
  in `we:scripts/lib/__tests__/daemon-self-sync.test.mjs` asserts A3's bounded
  retry ordering. Mutation proof: remove backoff or adoption revalidation and
  require the timing or unchanged-C assertions to fail.
- Capability (Red today): `reader contention clears without an operator restart` in
  `we:scripts/conveyor/soak/breaks/probation-boot-rollback-retry.soak.test.mjs`
  fails on S2a's permanent skip and proves A4's recovery and shutdown ordering.

Keep the existing persistent-refusal no-restart assertions; split transient
expectations deliberately rather than loosening them. PR #6882 also adds the
missing alert assertion to the current live-reader lock-timeout regression.

## Proof plan

Run the new released-reader case and soak scenario against S2a to show the
missing retry, then demonstrate bounded recovery with the policy implemented.
No current retry fix or green execution is claimed by filing this card.

## Non-goals

No timer-owned exit, force reset, reclamation of unknown readers or automatic
acceptance of unreadable evidence.
