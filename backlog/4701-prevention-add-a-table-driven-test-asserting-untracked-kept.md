---
bornAs: x1ufaw9
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare*.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-01"
dateResolved: "2026-10-07"
preparedDate: "2026-10-06"
preparedAgainstSha: "6bdc91ca614745e7caf4fdc9a47d7e90cc0924c3"
tags: []
---

# Prevention — Preserve untracked-kept alerts across preparation terminal returns

The approval of chalbert/web-everything#3295 requested a table-driven regression test preserving the `untracked-kept` alert contract when sidecar cleanup moves a side effect. Exercise every preparation terminal branch after a successful `ensureSafeToMove` inventory, while distinguishing files actually retained from sidecars proven landed and pruned.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3295@5ecd130b7ebb991c79ceb9ffe8503327277106e9

## Progress

- Original premise/scope: add a terminal-reason table at `we:scripts/lib/daemon-rebuild.mjs:1365`, with tests in `we:scripts/lib/__tests__/daemon-rebuild.test.mjs`. That source citation no longer exists: commit `b8fde2f52` split the implementation; `we:scripts/lib/daemon-rebuild.mjs:110` is now the compatibility re-export.
- Corrected premise/scope: preparation owns the inventory and emission at `we:scripts/lib/daemon-rebuild/prepare.mjs:175-214`. Replace the compatibility source entry with this implementation and retain its existing matching test file. This is a regression matrix plus the minimal alert-preservation fix it exposes, not a rebuild redesign.
- Source evidence: `head-unresolved` and `overlay-state-corrupt` return before either emission (`we:scripts/lib/daemon-rebuild/prepare.mjs:182-202`). Successful fetch now prunes sidecars and refreshes the inventory before emitting; refresh failure returns `status-failed` without an emission (`we:scripts/lib/daemon-rebuild/prepare.mjs:206-214`). Therefore emitting the original inventory indiscriminately would falsely label deleted sidecars as kept.
- Existing coverage is partial: adoption asserts the alert at `we:scripts/lib/__tests__/daemon-rebuild.test.mjs:701-717`; the cleanup failure table asserts it only for fetch failure at `we:scripts/lib/__tests__/daemon-rebuild.test.mjs:2466-2516`. The refresh case explicitly expects a deleted sidecar, so preserve that distinction. No terminal-reason alert matrix is present in the inspected tests.
- Size remains 3: one existing integration test file and a bounded alert-flow correction in the preparation module; no new runtime interface or policy choice is needed. Preparation is source-inspected; no runtime test result is claimed.
- Validation repair: the previous scope listed only the existing integration suite as test coverage. Add the required matching pattern `we:scripts/lib/daemon-rebuild/__tests__/prepare*.test.mjs` for the planned preparation regression suite; that directory does not yet exist. Place the new matrix in `we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs`, reusing the fixture approach from `we:scripts/lib/__tests__/daemon-rebuild.test.mjs:35-95`, and retain the existing integration suite for pruning/adoption coverage. The reporting gaps remain visible at `we:scripts/lib/daemon-rebuild/prepare.mjs:182-214`. Size remains 3; this changes test placement, not the behavior or matrix scope.

## Design

Use the existing real temporary Git repository fixtures and injected command runner in `we:scripts/lib/__tests__/daemon-rebuild.test.mjs:35-95`. Add a named table whose rows identify the terminal branch, setup/fault injection, expected reason, and retained paths. Each row plants an ordinary untracked sentinel before preparation, proves its target branch was reached, and checks both the alert payload and surviving bytes.

The contract begins with a **successful** safety check and a known untracked inventory. Safety refusals themselves and recovery/not-on-main exits preceding that point are boundary controls, not evidence that an inventory succeeded (`we:scripts/lib/daemon-rebuild/local-state.mjs:102-163`; `we:scripts/lib/daemon-rebuild/prepare.mjs:167-180`). Keep those refusal reasons unchanged.

Preserve one retained-path notification per preparation pass. Before cleanup, the successful safety inventory is usable for early refusals. After cleanup, report only paths verified retained; never reuse the original inventory wholesale after deletions. On refresh failure, keep the `status-failed` refusal, use read-only verification of previously inventoried survivors if needed for the alert, and never claim an absent or unverifiable path was kept. Limit any implementation change to this reporting flow in `we:scripts/lib/daemon-rebuild/prepare.mjs`.

## MVP

1. Add the terminal matrix to the planned `we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs`, reusing the fixture approach and per-test state directories of `we:scripts/lib/__tests__/daemon-rebuild.test.mjs`. Reach branches through real setup and narrowly injected command failures, rather than mocking the function under test or manufacturing its result.
2. Cover pre-emission exits, post-plan short circuits, both collision return sites, and the ready-candidate delegated terminal route. Assert retained-path notifications independently of other legitimate alerts.
3. Correct only the emission gaps demonstrated by red rows in `we:scripts/lib/daemon-rebuild/prepare.mjs`; preserve refusal reasons, pruning eligibility, smoke behavior, and checkout movement rules.

## Test plan

The table must cover these preparation branches, with separate rows where the same reason has distinct control flow:

- `head-unresolved`, `overlay-state-corrupt`, `fetch-failed`, and post-cleanup `status-failed` (`we:scripts/lib/daemon-rebuild/prepare.mjs:182-214`). For refresh failure, include an ordinary retained sentinel alongside a successfully pruned sidecar; assert only the sentinel is reported kept.
- Plan refusals: `main-unresolved`, `pinned-overlay-conflict`, and `pinned-overlay-unavailable` (`we:scripts/lib/daemon-rebuild/plan.mjs:105-126`; forwarding at `we:scripts/lib/daemon-rebuild/prepare.mjs:232-253`).
- `up-to-date`, `smoke-harness-broken-backoff`, `still-rejected`, and `rebuild-in-progress` (`we:scripts/lib/daemon-rebuild/prepare.mjs:266-276`, `we:scripts/lib/daemon-rebuild/prepare.mjs:352-395`).
- Ordinary and ready-candidate `untracked-collision`, plus `ready-adopted` and delegated finalization refusal/failure results (`we:scripts/lib/daemon-rebuild/prepare.mjs:316-348`, `we:scripts/lib/daemon-rebuild/prepare.mjs:377-381`). Enumerate the delegated outcomes from `we:scripts/lib/daemon-rebuild/adopt.mjs:223-293`; prove the preparation alert survives the alert-array concatenation.

For each row assert the expected terminal reason, exactly one preparation `untracked-kept` notification for known survivors, its paths, unchanged sentinel bytes, and the expected HEAD/moved behavior. Include an empty-inventory control with no kept alert, a successful continuation/adoption control, and safety-refusal controls that still refuse. Existing pruning tests must continue excluding deleted paths. Use deterministic state/clock setup for rejection, lease, and ready-candidate cases; inject Git failures by command and phase so the fixture cannot accidentally stop earlier.

## Proof plan

At implementation time, run the new named matrix through the host heavy queue, first against the unchanged implementation to capture the missing-alert failures, then after the reporting correction. Run the complete matching suites and standards gate through that same queue. The commands below execute from the WE checkout; their source/test targets are `we:scripts/readiness/heavy-admission.mjs`, `we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs`, and `we:scripts/lib/__tests__/daemon-rebuild.test.mjs`.

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs -t 'untracked-kept terminal matrix'
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/daemon-rebuild.test.mjs
node scripts/readiness/heavy-admission.mjs run -- npm run check:standards
```

Mutation-check the regression locally during implementation: suppress the pre-cleanup notification and then the post-cleanup notification separately; the corresponding rows must fail. Restore each mutation before the final queued suite. Record actual failing/passing rows and command outcomes rather than treating source inspection as execution proof.

## Done when

- The matrix detects a missing retained-path alert on each covered terminal branch, including the formerly silent early exits.
- Kept alerts name surviving untracked files and exclude pruned sidecars; failed inventory/refusal paths remain fail-closed and never move the checkout merely to obtain an alert.
- The queued focused suite and standards gate pass with the regression and minimal fix in place.

## Follow-ups

No prerequisite edge change is proposed. Broader smoke/fallback alert contracts after nonterminal preparation remain separate work. When preparation gains a terminal branch, extend this matrix with its setup and retained-path expectation; keep the delegated ready-candidate branch coverage aligned with its finalization outcomes.
