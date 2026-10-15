---
bornAs: x0dcjec
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs"]
dateOpened: "2026-10-14"
preparedDate: "2026-10-14"
preparedAgainstSha: "6742d1202f2de0350e0a5a6978cebaa385be8b43"
tags: []
---

# Daemon rebuild smoke launches a real Claude session (fix dry-run is wrapped)

The dispatch dry-run can bypass its injected spawner because fix and review wrapping default on outside tests. The fix capture then remains null, which the current placeholder check accepts. Isolate the dry-run from worker launches and require an actual nonempty captured brief.

## Progress

- Original premise: reported 332 real sessions on 2026-10-13/14 and roughly $200 cost; those are historical incident estimates, not measurements reproduced during preparation. Original scope included four production modules plus the smoke test.
- Source confirms the bypass: we:scripts/lib/daemon-live-smoke.mjs:584 injects a fix spawner without disabling wrapping; we:scripts/conveyor/reconcile-fix-dispatch.mjs:1330 defaults wrapping from policy. Review likewise defaults wrapping at we:scripts/operations/review-dispatch.mjs:580. All three worker roles default on at we:scripts/operations/worker-wrapper-launch.mjs:38; the test-only guard at :48 can hide this in unit runs.
- Corrected scope: change only the smoke and its matching test. Existing production switches already suffice; production dispatch and wrapper policy need no changes. The empty capture conversion is at we:scripts/lib/daemon-live-smoke.mjs:544, and the child environment is at :671 (replacing the original approximate :520/:645 citations).
- Size remains 2: approximately 25 changed source lines and 90 test lines across the two scoped files. No stamp or live worker launch performed.

## Design

Set `WE_WORKER_WRAPPER=off` after spreading the caller environment in the dry-run child options. Explicitly pass `wrapFix:false` and `wrapReview:false` in the embedded direct-dispatch calls too, so direct execution of the exported script cannot bypass the stubs. Capture review's prompt at its injected spawner, as fix already does; a returned prompt alone does not prove that the stub ran. Reject non-string, null, empty and whitespace-only captures before scanning required placeholders.

The dry-run must never become a real-worker probe because a caller supplied `WE_WORKER_WRAPPER=on`. Preserve the existing production wrapper setting and the separate deliberate real-worker overlay at we:scripts/lib/daemon-load-overlay.mjs. That existing opt-in path satisfies the incident's request to retain deliberate live exercise; no new smoke policy knob is needed.

## MVP

- Isolate both entry routes: the smoke child environment and exported direct-dispatch script.
- Require captured, nonempty prompts for review, fix and both CI-heal cases; retain required-placeholder detection and per-kind errors.
- Keep pass-level dispatch, labels, claims and ledger writes stubbed/isolated as today.

## Test plan

Extend we:scripts/lib/__tests__/daemon-live-smoke.test.mjs at its injected-child suite (:1120) and temporary-tree real-child suite (:1363). Assert the outgoing child environment overrides an incoming wrapper-on value. Execute direct dispatch with test-isolation environment flags removed, wrapper-on inherited, and a throwing/counting fake wrapper launcher in the temporary copy: wrapper calls must be zero and both injected spawners must capture nonempty prompts. Never use the real launcher as the failure sentinel.

Exercise null, undefined, empty, whitespace-only and non-string captures; valid filled text passes, required placeholders fail, documentation-only placeholders remain permitted. Run the scoped test through the host heavy-admission queue.

## Proof plan

First demonstrate that the new safe sentinel test detects the old bypass without launching a worker. After implementation, run one dispatch smoke with the repaired child and capture result rows, elapsed time, and process/launcher observations showing zero new real worker launches. Compare timings only with an existing recorded baseline or a safely intercepted old version; do not recreate the paid incident. A green test under the ordinary test-isolation guard alone is insufficient proof.

## Acceptance

All four direct cases capture real filled briefs through their stubs; missing captures fail; inherited wrapper-on cannot cause a dry-run launch. The new regression fails safely before the fix and passes afterward.

## Non-goals

No production wrapper default changes, real-worker overlay changes, billing reconstruction, or new settings cascade.

## Edge cases

Untrusted prompt contents are only checked for required placeholders, never executed. Missing captures fail closed. The temporary ledger remains isolated and cleaned up. Sentinel PRs stay confined to dry-run dispatch. No receive endpoint, shared production-state mutation, or author-trust decision is introduced.

## Follow-ups

Track deliberate overlay cost independently if needed. Measure historical spend from actual session/accounting records before presenting incident estimates as confirmed totals.
