---
kind: task
status: active
scaffoldedBy: "card-7526-sibling-advanced"
dateScaffolded: "2026-11-27"
scope: ["we:scripts/lib/pr-size-admission.mjs", "we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# open-pr sibling gate: leftovers after #7526 head 65bc0560 fixed the advanced-sibling carve-out (PR #7526 follow-up)

Problem: #7526 head 65bc0560 fixed the `we:scripts/lib/pr-size-admission.mjs` :143 carve-out. Shapes A and B are fixed there. Leftovers (F1 = leftover 2 below; F2-F4 from the 01:56Z review of #7526 head 65bc0560, all fail-closed false refusals at open-pr, low/degraded, none lets unmerged sibling work through): (1) Missing test: the fetched-creation rule at `we:scripts/lib/pr-size-admission.mjs:170-174` is untested, because the new test at :254 builds its child with `checkout -qb` (reflog "Created from HEAD"), so a child created from fetched `origin/lane/own` is never exercised. (2) Small fail-closed regression: a published stacked child that shares the head now gets `sibling-base-unknown` at :174 (inheritedByUs(head) is true and isAncestor(head, creation[1]=head)); on 0978c72c it was admitted. A legitimate published child must not be refused. (3) The test uses `process.env.TMPDIR` at `we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs:12` instead of `tmpdir()`.

F1 (:172/:174 published child) is the existing leftover 2. F2 `we:scripts/lib/pr-size-admission.mjs:183`: merging main into a lane hides that a sibling already squash-landed, so the gate refuses. F3 `we:scripts/lib/pr-size-admission.mjs:208`: a single squash landing of parent and child leaves the parent classed unmerged, so it is refused. F4 (no line): if the sibling fast-forwards through the submitted head, the shared merge-base pulls this PR's own commit into the landing check, so it is refused.

Scope:

- we:scripts/lib/pr-size-admission.mjs
- we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs

Fix direction: change the :170-174 fetched-creation rule so a published stacked child sharing the head is admitted (not `sibling-base-unknown`), while a real unknown base still fails closed; keep the shape A and shape B tests green. Add the fetched-creation test. Replace `process.env.TMPDIR` with `tmpdir()` at that test's line 12.

Acceptance:
- New green test in `we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs`: a child created from fetched `origin/lane/own` is admitted.
- A published stacked child sharing the head is admitted (red on the current 65bc0560 behaviour, green after).
- The shape A and shape B tests stay green.
- `we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs:12` uses `tmpdir()`.
- F2 test 'admits a lane after main is merged in when the sibling already squash-landed' (red on 65bc0560, green after).
- F3 test 'admits a child when parent and child landed in one squash' (red on 65bc0560, green after).
- F4 test 'admits a PR whose sibling fast-forwarded through the submitted head' (red on 65bc0560, green after).
- Full verify green.

Severity: not a security finding. main has no checkSiblingBase today; the regression fails closed (a legitimate child is refused with `sibling-base-unknown`), it does not admit anything unsafe.

Evidence: PR #7526 head 65bc0560 judge ruling (context in the handoff-state card-7526-sibling-advanced file), PR #7526 review comment 2026-11-28T00:46:55Z, Steward Opus judge ruling 2026-11-27 (handoff-state judge-7526r6), earlier ruling handoff-state judge-7526-ruling-2026-11-27 file (the --verbatim finding at :189 is fixed and holds). Citation form: we:backlog/xteoojb-open-pr-sibling-gate-an-advanced-sibling-containing-the-subm.md@pr7625.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/__tests__/open-pr-sibling-base.test.mjs` is green, including the new fetched-creation test and the published-stacked-child admission test (see the Acceptance list above).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
