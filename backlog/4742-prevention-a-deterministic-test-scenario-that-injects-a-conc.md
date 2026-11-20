---
bornAs: x7e5ilj
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-20"
preparedAgainstSha: "98e57b4c75e6202498fc613e547a5582240a5bae"
tags: []
---

# Prevention — A deterministic test scenario that injects a concurrent label addition exactly during the gh pr edit ex… (from chalbert/web-everything#3475 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-heal-mark.mjs:461` — A deterministic test scenario that injects a concurrent label addition exactly during the `gh pr edit` execution window to assert how the script recovers or reports the breach.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3475@442a00342e7fa9abb130bc1e62ff88283453c0a0

## Progress

Re-preparation found factual drift. The old scope paired
`we:scripts/conveyor/ci-heal-mark.mjs` with
`we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs`, despite expecting a test-only
change. The old premise placed both modes at the same direct write and promised
one heal comment and the same verification error for both modes. Corrected scope
is the existing test file alone; production files below are evidence, not planned
edits. Size remains 3: one subprocess harness, approximately 90–140 changed lines
for a twelve-case matrix, edit-time trace, mode-specific assertions and coverage
inventory. No runtime default, caller, persisted state or label policy changes.

Source evidence:

- `we:scripts/conveyor/ci-heal-mark.mjs:461` is now the direct restore-only edit;
  its verification is at `we:scripts/conveyor/ci-heal-mark.mjs:463` and its CLI
  reporting at `we:scripts/conveyor/ci-heal-mark.mjs:533`.
- Normal completion delegates at `we:scripts/conveyor/ci-heal-mark.mjs:503` through
  `we:scripts/conveyor/ci-heal-mark.mjs:400` to
  `we:scripts/conveyor/rearm-review.mjs:362`. The shared writer verifies at
  `we:scripts/review-set-label.mjs:2402`, including forbidden remaining labels
  from `we:scripts/review-set-label.mjs:571`. Its error differs from restore-only.
- The normal path posts a request comment before the swap
  (`we:scripts/review-set-label.mjs:2282`);
  `we:scripts/conveyor/rearm-review.mjs:294` explicitly describes this as a request,
  not verified success. Thus two comments survive a normal verification refusal.
- Existing races at `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:410`
  and `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:411` inject on reads,
  including the stale landing-signal scenario at
  `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:373`. The edit handler at
  `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:415` has no concurrent-label
  injection. This exact timing goal is still outstanding.

These are source observations; no runtime pass is claimed during preparation.
The existing preparation stamps are left for the runner to replace.

## Design

Extend the stateful fake CLI in
`we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs` with an explicit edit-window
scenario field. Apply the requested label additions, inject the competing label,
record a snapshot, then persist state and return from that same fake edit call.
Record view snapshots too: the last pre-edit view must lack both routing labels;
the next view must contain pending plus the injected label. Keep the head stable,
the PR open and non-draft, and initial labels empty. No sleeps or production hooks.

Run each of `review:human`, `review:changes`, `review:accepted`, `review:unknown`,
`ready-to-merge`, and benign `area:docs` through normal completion and
`--restore-routing-only` (twelve cases). Assert raw persisted labels before the
existing lifecycle simulation. All cases issue exactly one additive pending edit,
without removals, retries, rollback or acceptance restamping.

Conflicting normal cases exit zero with `restamped: false`, `rearmed: false`, no
`restored`, and a `carryReason` containing
`missing review handoff could not be verified: label transition was not observed`.
They retain one heal comment and one re-arm request comment; the latter explicitly
says completion reports verification. Conflicting restore-only cases exit one,
stderr contains `CI-heal routing restoration could not be verified`, stdout has no
success JSON, and no comments are posted. Both modes preserve the conflicting label
and pending hold. The benign control succeeds with `restored: review:pending`, no
failure diagnostic, and preserves `area:docs`: two comments in normal mode, one
routing-restoration comment in restore-only mode.

## MVP

1. Add the twelve fixtures and edit/view trace snapshots to the existing incident
   replay. Give each new test a searchable `4742 edit-window` prefix and include
   its mode and label in its name.
2. Branch new-case expectations explicitly before the existing `scenario.pr` and
   failure shortcuts at
   `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:440` and
   `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:501`. Assert timing, labels,
   calls, diagnostics and comment bodies/counts; do not weaken old assertions.
3. Add a named `4742 edit-window matrix completeness` test over the fixture list:
   require exactly the six labels in each mode. Retain all existing pre-read,
   pre-write, unreadable-evidence, ignored-write and post-write failure cases.

## Acceptance

The executable probe for every criterion is the queued test-file run below,
preceded by a presence check for the named new test. Presence fails on the current
checkout; after implementation the presence check and assertions must both pass.
This is coverage debt: current production behavior is expected to pass new tests,
so do not represent it as a runtime bug with a naturally red baseline.

- [A1] Executable: `4742 edit-window matrix completeness` in
  `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs` asserts the twelve-case
  inventory; each `4742 edit-window` case asserts clean final pre-read → injection
  inside edit → verification read, exactly one additive edit, and preserved raw
  labels. The presence-and-test command below fails before these tests exist.
- [A2] Executable: the eight review-label conflicts and two ready-to-merge conflicts
  named `4742 edit-window <mode> <label>` in
  `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs` assert the mode-specific
  fail-closed output and comment contracts from Design. Run the same
  presence-and-test command; removal of either verifier's conflict predicate must
  also make its corresponding cases fail.
- [A3] Executable: the two `4742 edit-window <mode> area:docs` tests in
  `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs` assert successful restoration,
  preserved benign labels, exact comments, and no failure diagnostic. The same
  presence-and-test command fails before the matrix exists and passes afterward;
  rejecting all additions must fail these controls. The full file retains existing
  caller and fail-closed regression assertions. No defaults or callers change.

## Test plan

Run from the WE checkout. Prefixes below identify repository paths; the shell
removes the locus before passing a path to a tool. Use the host heavy queue only:

```sh
test_ref=we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs
queue_ref=we:scripts/readiness/heavy-admission.mjs
rg -q '4742 edit-window matrix completeness' "${test_ref#we:}" &&
node "${queue_ref#we:}" run -- npx vitest run "${test_ref#we:}"
```

For focused debugging, add `-t '4742 edit-window'` to the queued Vitest invocation.
A missing-test-name check alone is not sufficient proof; require the matrix count
and behavioral assertions too. Keep fixtures under the task's temporary directory,
with the fake executable first on PATH. Preserve the existing repository-target
assertion at `we:scripts/conveyor/__tests__/ci-heal-mark.test.mjs:450` and rejection
of unexpected fake commands. Never contact GitHub for this test.

## Proof plan

Capture the pre-build presence failure, then the post-build full-file result and
representative traces/raw state from both modes. The trace must demonstrate that
injection ran inside edit, not merely on a later view. Capture normal request
comments separately from the completion result so a request cannot masquerade as
verified restoration.

In an isolated validation copy under the task temporary directory, remove the
review-family conflict predicate and forbidden-removal-label predicate from
`we:scripts/review-set-label.mjs:2408`; normal conflict tests must fail. Separately
remove the conflicting-label predicate in
`we:scripts/conveyor/ci-heal-mark.mjs:466`; restore-only conflict tests must fail.
Benign controls must remain green in both experiments. Restore the production
sources and rerun the focused matrix through the queue. No mutation belongs in the
submitted diff. This proves sensitivity to breach reporting, not atomic remote
writes or automatic recovery.

The runner owns preparation checks, stamping and parked review. Implementation
validation includes the queued standards gate and the full matching test file.
If admission is busy, use the queue's bounded wait once, then stop and report.

## Follow-ups

No prerequisite or unresolved policy fork remains for this test-only goal.
Automatic reconciliation of mixed labels is a separate policy question; this card
records the current reporting behavior. A remote race experiment is outside scope.
No blockedBy change is proposed.
