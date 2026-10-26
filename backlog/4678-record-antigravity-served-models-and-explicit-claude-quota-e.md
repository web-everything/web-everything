---
bornAs: xtmprx7
kind: story
size: 5
status: resolved
scaffoldedBy: "agy-model-provenance"
dateScaffolded: "2026-09-30"
scope: ["we:scripts/__tests__/gemini-direct-task.test.mjs", "we:scripts/conveyor/run-quality-record.mjs", "we:scripts/gemini-direct-task.mjs", "we:scripts/lib/__tests__/antigravity-judge-spawn.test.mjs", "we:scripts/lib/antigravity-judge-spawn.mjs", "we:scripts/lib/probation-launcher.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/probation-heal-run.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/run-record.mjs", "we:scripts/lib/antigravity-run-evidence.mjs", "we:scripts/lib/__tests__/antigravity-run-evidence.test.mjs"]
dateOpened: "2026-09-30"
dateResolved: "2026-10-25"
tags: []
---

# Record Antigravity served models and explicit Claude quota exhaustion

Investigate the 2026-09-30 operator exhaustion report using read-only local evidence; record requested and served model provenance for agy seats and workers, explicitly hold or skip exhausted Claude requests, and verify recording and exhaustion regressions.

## Done when

- Requested and reported model/backend provenance survives judge telemetry, extra-seat rows and probation worker rows.
- Claude quota errors (including partial answers) persist a hold until the reported reset; subsequent calls skip with a note. Backend substitutions cannot count as successful requested-model verdicts.
- Regression tests and `node we:scripts/verify-lane.mjs` pass.

## Progress

2026-09-30 — Filed first through `node we:scripts/operations/run.mjs file-item`.
2026-10-25 — Gap: holds were already per backend folder, so a Claude hold never blocked an explicit gemini model; only a run with no model hit the global scan, and the refusal did not say which family set the hold. Refusal now names the holding backend and model; the global scan covers every backend and legacy root-level hold files; tests added for claude-vs-gemini isolation and no-model global.

**Before: read-only machine evidence.** Matched the daemon review records to saved agy judge transcripts by `sessionId`, selecting transcript modification dates of September 30 in the machine timezone. Exactly 114 `antigravity-review` rows matched: every stream had `init.init.model = gemini-3.1-pro` and terminal `SUCCESS`. The observed interval was 01:28:54–19:29:27 EDT. Example sessions: `b9ba70d0-9869-4bda-a772-e2d76abb2bc5` and `c1e66940-32c2-4e0a-a3b8-c1fdf9c98bcb`. These rows had no telemetry model; the enclosing operation's `sonnet` is not evidence of the agy backend. The saved streams are under the machine's `.antigravity-judge-transcripts` home directory; daemon records were read from the operator-specified external checkout and never modified.

The CLI log `cli-20260930_190147.log`, lines 156–174, resolves `claude-sonnet-4-6`, labels it Claude Sonnet 4.6 (Thinking), then lines 216–218 report `RESOURCE_EXHAUSTED (code 429): Individual quota reached` and `Resets in 90h29m27s`, with no response. The `190024` log also reports exhaustion after a partial response. Earlier Claude failures at 06:46 and 13:08 had short resets, so those alone do not establish the afternoon cutoff. The `192234` file contains interleaved conversations and cannot safely attribute its error by filename alone. The separate `192301` log resolves Gemini 3.1 Pro High. Thus the 114 seat streams report Gemini throughout the day; there is no evidence that these seats silently switched from Claude after exhaustion. CLI-reported configuration is observable; server-side routing beyond that is not attested by these artifacts.

**Launch trace.** The judge seat uses `we:scripts/lib/antigravity-judge-spawn.mjs`, pinned to Gemini 3.1 Pro, through `we:scripts/operations/cli-adapter.mjs`. Probation Claude/Gemini workers are chosen in `we:scripts/lib/provider-routing.mjs` and launched through `we:scripts/lib/probation-launcher.mjs` into `we:scripts/gemini-direct-task.mjs`; extra review seats use that same worker wrapper. Local `agy --help` exposes models, stream JSON and log-file output, but no quota subcommand. A read-only binary scan confirmed the `FetchQuotaStatus` symbol; its presence is not a callable documented CLI contract; logs show `quota_manager` refreshing, not a usable numerical quota response. The observed error/reset text is the reliable exhaustion signal used here.

**After: implementation.** Shared `we:scripts/lib/antigravity-run-evidence.mjs` reads only CLI init identity and error channels, never answer/tool prose. It records requested model, served model/backend, evidence source, quota state/reset and fallback decision. Unknown identity stays unknown. Quota state is unknown unless exhaustion was observed, never invented as available. Holds are shared across seats/workers, scoped by backend and expire at the observed reset (one hour when absent); no successful Gemini call clears a Claude hold. An exhausted partial answer is rejected. A different reported model/backend is rejected with a skip decision (effort suffix aliases are normalized). Concurrent exhaustion observations are immutable, so a shorter reset cannot overwrite a longer hold. The policy is skip-with-note, with no automatic substitute.

Telemetry normalization now retains provenance and transcript pointers; worker reports, extra-seat scorecards and probation launch scorecards preserve it. Historical external records remain unchanged. Source tests replay the observed shapes and the real partial-error wording; they exercise persistence, expiry, backend isolation, wrapper refusal and telemetry retention.

**Verification.** The focused nine-suite run passed 498 tests. `npm run check:standards` passed with zero errors. A later read-only replay matched 115 transcripts (one additional review arrived during the investigation), all recording Gemini/Google provenance through the new parser without modifying any source evidence. Final `node we:scripts/verify-lane.mjs` rerun: 185 suites passed, three failed; 9,127 tests passed, 16 failed, eight skipped. All 16 failures are in the real process-table suites `we:scripts/lib/__tests__/daemon-jobs-runtime.test.mjs`, `we:scripts/operations/__tests__/clear-stuck-session-io-real.test.mjs`, and `we:scripts/operations/__tests__/restart-runner-io-real.test.mjs`. The direct probe `ps -o pid= -p $$` also returned Operation not permitted (exit 126). These tests remain intact; changing production liveness handling or weakening their assertions would not fix the denied platform capability. The lane verification marker remains red. **Story remains active until the required gate can run with process-table access; not resolved as if green.** No commit, push, or PR was made.

## Follow-ups

- Rerun `node we:scripts/verify-lane.mjs` where process-table access is permitted, then resolve this card once green. The current sandbox cannot grant that access, and no test was skipped or weakened to manufacture a passing result.

- Init identity is CLI-reported, not server attestation. If agy exposes per-response backend identity or a supported quota RPC surface, add that evidence source without treating requested aliases as proof.
- Preserve sanitized event/error fixtures and session IDs when diagnosing future provider substitutions; do not infer served identity from an operation-wide model label.
