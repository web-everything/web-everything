---
kind: story
size: 3
status: active
scaffoldedBy: "missing-required-check-recovery"
dateScaffolded: "2026-11-12"
dateOpened: "2026-11-12"
tags: []
related: ["6684"]
---

# Reinforce missing-run CI dispatch: merge-ref coverage, exact-SHA lease, atomic one-per-head reservation, strict run-path evidence

When a missing-run recovery commit still gets no `pull_request` run, `we:scripts/conveyor/missing-run-push.mjs` dispatches the CI workflow (`we:.github/workflows/ci.yml`) once on the branch (live #6684/#6633). PR #6703 delivered the guards: complete run evidence, a final exact-head re-check, an atomic one-per-head reservation, a case-insensitive key, strict run-path evidence, and a stuck-run window taken from the `ciMissingAfterPushMin` setting. A pull_request run that is merely slow (queued inside that window) is a free deferral, so it cannot spend the recovery retries before CI is dispatched. What remains open is listed under Non-goals.

## Acceptance

- [A1] **Executable** — the unit tests in `we:scripts/conveyor/__tests__/missing-run-push.test.mjs` pass, and each fails if its guard below is removed.
- [A2] **Executable** — a young queued CI run is a deferral for every tick inside the window (a deferral, which the sweep never counts; no reservation taken, no POST), and the same run reserves and dispatches exactly once after it ages past the window. The reservation spy is asserted uncalled on every young tick and called once on the aged one, and the same for the through-the-sweep case in A9. Test: `a slow (still young) pull_request run costs no retry, and the stuck window comes from the setting, not a constant`.
- [A3] **Executable** — the window is the configured one: a 6 min old run is young at the 10 min default and stuck under a 5 min option or `WE_FIX_CI_MISSING_AFTER_PUSH_MIN=5` (same test).
- [A4] **Executable** — incomplete or malformed run evidence is a deferral with no reservation and no POST. Test: `fails closed on incomplete or malformed run evidence`.
- [A5] **Executable** — the PR head and state are re-read right before the POST. Test: `re-checks the exact head and state right before the dispatch POST`.
- [A6] **Executable** — one dispatch per head and repo, whatever the slug's case; the reservation survives a failed POST. Tests: `reserves the dispatch per head`, `keeps the reservation when the dispatch POST fails`.
- [A7] **Executable** — a run whose workflow path cannot be read is treated as a possible CI run. Test: `treats a run whose workflow path cannot be read`.
- [A8] **Executable** — every gh/git child is bounded by the shared `WE_CHILD_TIMEOUT_MS` setting, not a private constant. Test: `bounds every gh/git child by the shared child-timeout setting`.
- [A9] **Executable** — through the real sweep, five slow ticks post no attempt marker and dispatch nothing; the aged run dispatches once and is then counted. Test: `sweep wiring: a slow young run spends no recovery attempt across ticks`.

## Non-goals

- [N1] `we:scripts/conveyor/ci-red-recovery-watch.mjs` does not forward its own injected `thresholdMs` to the trigger. In production both read the same `ciMissingAfterPushMin` setting, so they agree; only a test injection could differ.
- [N2] The dispatch API takes a branch name, not a SHA, so the dispatch cannot be pinned to the checked commit. The final PR re-read and the reservation narrow the window; they do not close it. Follow-up card, not this one.
- [N3] Dispatching against the merge ref is not done here.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no run text reaches a command; only `path`, `event`, `status` and `created_at` are compared.
2. **Truncated reads** — a run listing with `total_count` >= 100, or not matching the runs returned, is a deferral.
3. **Shared state files** — the reservation is an exclusive file create (`wx`), atomic across ticks; it is never released.
4. **Fail closed** — an unreadable path, an undatable queued run, a running or finished run, or any earlier dispatch blocks (counted, ci-heal's job). An unwritable reservation fails the attempt.
5. **Identity scoping** — the key is `repo.toLowerCase()@headSha`: one key per head whatever the slug's case.
6. **State over time** — a young queued run is a free deferral until it ages past the setting's window; then one dispatch.
7. **Who wrote it** — n/a: the reservation is local daemon state; run evidence comes from the GitHub API with the pinned credential.

## Duplicate admission

residuals of the missing-run workflow_dispatch fallback (R896+R903): dispatch checks the branch tip not the merge ref; no exact-SHA lease between final GET and POST; one-per-head guard is a listing check not a reservation; malformed run paths are ignored

new residual card for lane/missing-required-check-recovery
