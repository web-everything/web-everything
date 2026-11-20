---
bornAs: xh0f3u1
kind: story
size: 3
parent: "4075"
status: open
scope: ["plateau:src/wip/payload-leak-check.ts", "plateau:src/wip/payload-leak-check.test.ts", "plateau:src/wip/progress-read.test.ts", "plateau:src/wip/wip-publish.test.ts", "plateau:src/wip/wip-agent.test.ts"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "fbeca8e4d4d485e39aded3226c60f4b4941e9a04"
tags: []
---

# Prevention — Add a payload-redaction assertion to the progress-runs and wip-publish test list. Better, add a shared… (from chalbert/web-everything#3327 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4624-show-actual-executors-and-standalone-jobs-in-plateau-running.md:95-106` — Add a payload-redaction assertion to the progress-runs and wip-publish test list. Better, add a shared leak-check helper that every publisher fixture test runs against the serialized payload.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3327@c57098509c4ea43995028750603a59c912694ebf

## Progress

Preparation refreshed on 2026-11-20 against plateau-app revision `af64fef954a9c77bf3cfdf63c9f0bea7d228bc5e`. Source inspection only; no runtime or live publication proof is claimed. The existing preparation stamps are left for the runner.

- **Old premise/scope:** the earlier preparation already scoped a new shared helper, its tests and three existing projection/publisher suites. It cited the WebSocket serializer at outdated lines 151–167, treated fallback as if the agent serialized HTTP itself, and had no labeled executable Acceptance. The approval's original parent-card line 79 was stale.
- **Corrected premise/scope:** retain those five files, all in the live plateau-app product (the `plateau:` alias), not the abandoned Plateau prototype. `plateau:src/wip/progress-read.ts:52-64` still explicitly projects runs without transcriptPath; `plateau:src/wip/progress-read.test.ts:25-35` still supplies null transcript paths. Neither proposed helper nor standalone run adapter exists in the inspected tree; searching the WIP sources finds no shared payload-leak assertion. This prevention is not already delivered.
- **Transport evidence:** `plateau:src/wip/wip-publish.ts:49-64` serializes HTTP bodies and catches fetch errors; `plateau:src/wip/wip-publish.test.ts:22-52` checks parsed equality and error results, not contaminated source projections. `plateau:src/wip/wip-agent.ts:162-185` serializes WebSocket frames but delegates HTTP fallback as an object to publishHttp. Its send wrapper catches exceptions. Consequently guards must execute after capture, outside these caught callbacks; a guard thrown inside a fake send/fetch alone can silently pass the suite.
- **Caller evidence:** `plateau:scripts/wip-publish.ts:130` wires HTTP publication and `plateau:scripts/wip-publish.ts:188-192` wires the agent fallback through publishOnce. Exercise that real composition in the fallback fixture, not just JSON.stringify on its argument. No production defaults or callers change; the changed test default is that every captured snapshot publication is guarded, including failure-response and command-triggered fixtures.
- **Existing contract:** `we:docs/agent/plateau-progress-view.md:132` excludes credentials, absolute transcript paths and raw transcripts. `we:backlog/4624-show-actual-executors-and-standalone-jobs-in-plateau-running.md:95-106` retains integration proof requirements. This card adds fixture prevention, not a universal sanitizer or a claim of an observed production leak.
- **Estimate:** retain size 3. Expected touch set: new helper about 45 lines; matching unit tests about 85; projection tests about 35; HTTP tests about 40; agent tests about 60 (about 265 changed lines). Existing seams above support test-only changes without a runtime rewrite. As a story, this card has no estimatedLoc.

## Design

Add a test-only `assertPayloadHasNoLeaks` helper (proposed) in `plateau:src/wip/payload-leak-check.ts`, accepting the actual serialized JSON string and an explicit list of forbidden synthetic values. Validate JSON and require a nonempty marker list containing only nonempty strings; reject missing/non-string payloads and invalid marker inputs with sanitized diagnostics; inspect decoded string values and keys recursively so JSON escaping cannot conceal a fixture marker. Return no transformed payload. Failure messages identify the marker category or index without echoing its value or the full payload.

Use distinct deterministic markers for a credential, raw prompt/tool transcript content, and absolute transcript paths (POSIX and Windows forms). This is a fixture regression oracle, not a universal secret detector: do not invent regex rules that reject legitimate URLs, public descriptions, or repository-qualified paths. Authentication headers remain required and are outside the snapshot-body assertion.

In `plateau:src/wip/progress-read.test.ts`, feed `readMoving` a populated row with a non-null private transcriptPath and extra private source fields, keeping legitimate public metadata populated. Check its serialized projection with the helper and assert the expected public fields and counts survive. Carry that real projection into populated publisher fixtures instead of constructing only an empty snapshot or passing raw source records straight to transport.

In `plateau:src/wip/wip-publish.test.ts`, inspect the captured fetch body before parsing or normalizing it. In `plateau:src/wip/wip-agent.test.ts`, retain raw fake-socket sends alongside the existing parsed representation and check snapshot frames before parsing. Capture raw sends and requests, then run the guard in test assertions or a shared afterEach outside production catch blocks. Apply it to every snapshot-publishing fixture in those suites, including HTTP fallback; exclude non-snapshot protocol messages. Preserve existing behavior assertions so an empty or dropped payload cannot satisfy the guard alone. Wire the agent fallback fixture through real publishOnce with an injected capturing fetch; assert the body and call count after awaiting refresh. Shared fixture builders and marker constants may live in the proposed helper module to keep this five-file scope; never import a test suite as a fixture module.

## MVP

One shared test helper, its own positive/negative tests, a contaminated-source projection regression and guard calls at both serialized transport boundaries. Cover credentials, raw transcript text and absolute transcript paths using synthetic fixtures only. No production sanitizer, schema change, live credential read, relay deployment or standalone run adapter is included. If a test exposes a real runtime leak, record the exact synthetic reproduction and prepare a separately scoped runtime fix rather than silently expanding this test-only item.

## Acceptance

The following are proposed named tests. Add the tests and guard imports first: before implementation the missing helper must make these tests fail; after implementation all must pass. For already-safe projection/transport behavior, also demonstrate the mutation failures below rather than claiming production redaction newly changed.

- [A1] Executable: `plateau:src/wip/payload-leak-check.test.ts` — “rejects leaked markers in nested values, keys and escaped JSON” and “accepts safe populated payloads without alteration”. Table-test credential, raw transcript, POSIX path and Windows path markers, including markers embedded in longer strings. Removing marker detection must turn these tests red.
- [A2] Executable: `plateau:src/wip/payload-leak-check.test.ts` — “fails closed on missing or malformed payload and invalid marker inventories” and “never echoes payload or marker in diagnostics”. Cover undefined/non-string payloads, malformed JSON, missing/empty inventories and empty/non-string entries. Failure is a test failure requiring fixture repair, never a skipped guard; catch parser errors without reproducing their input. No new size bound is introduced.
- [A3] Executable: `plateau:src/wip/progress-read.test.ts` — “projects contaminated working and unknown runs without private fields”. Assert expected public identifiers, descriptions, timestamps, state and counts as well as the guard; adding transcriptPath to the projection must fail this test.
- [A4] Executable: `plateau:src/wip/wip-publish.test.ts` — “guards every captured HTTP snapshot body and preserves authentication”. Use a populated readMoving projection; cover success, rejected responses, network failure and timeout captures. Unreadable snapshot must send nothing. Shared post-capture assertions cover existing callers; inject a marker into a captured body to demonstrate failure. Bearer header remains present and excluded from the body check.
- [A5] Executable: `plateau:src/wip/wip-agent.test.ts` — “guards every raw snapshot frame including refresh and keepalive” and “guards disconnected fallback through real publishOnce”. Cover initial, changed, reconnect and command refresh sends via the common capture assertion. Assert populated run identity and send counts. Injecting a marker independently into a frame or fallback body must fail outside the caught send/fetch callbacks. Non-snapshot messages remain outside this guarantee.

## Test plan

- `plateau:src/wip/payload-leak-check.test.ts` is the matching test for the new `plateau:src/wip/payload-leak-check.ts`. Table-test each marker category, nesting, JSON escaping, safe payloads and invalid helper inputs. Assert diagnostics do not reproduce sensitive marker text.
- `plateau:src/wip/progress-read.test.ts` covers the current source-to-public-run boundary with populated hostile input and positive output assertions. Test unknown states as well as working rows so private extras cannot escape through alternate projections.
- `plateau:src/wip/wip-publish.test.ts` checks the real serialized HTTP body and preserves the bearer-header assertion separately. Keep existing error-result tests; they cover a different boundary.
- `plateau:src/wip/wip-agent.test.ts` checks raw serialized snapshot frames and the disconnected HTTP fallback fixture with the same marker inventory. Assert the expected snapshot is actually sent and contains the populated run.
- Run only through the host heavy queue: invoke `node` with `we:scripts/readiness/heavy-admission.mjs`, then `run --wait-ms 60000 -- npx vitest run` from the plateau-app working directory, resolving the queue script from the WE checkout. Test arguments are: `plateau:src/wip/payload-leak-check.test.ts`, `plateau:src/wip/progress-read.test.ts`, `plateau:src/wip/wip-publish.test.ts`, and `plateau:src/wip/wip-agent.test.ts` (strip the repository prefixes when passing filesystem arguments). Wait once using that queue budget; if unavailable, stop and report without polling. Add the helper tests first: the missing helper should produce the initial red result. Existing runtime omission behavior may already pass; the mutation checks prove the new regression sensitivity.

## Proof plan

1. Record the tested Plateau revision and exact targeted command, exit status and test totals. Use only in-memory synthetic inputs and fake transports; no paid worker or authenticated relay call is necessary.
2. Capture that the same contaminated-source projection reaches the HTTP request body and WebSocket snapshot frame, with expected public metadata intact. Record assertion outcomes rather than copying private fixture values into logs.
3. Temporarily mutate each boundary independently: restore transcriptPath to `readMoving` output; append a marker to the HTTP body; append a marker to the WebSocket snapshot; append a marker to the real HTTP fallback body. Also disable helper matching and invalid-input rejection independently to verify A1/A2 sensitivity. Each mutation must fail its corresponding suite. Remove each mutation and rerun the targeted command to green.
4. Review all snapshot fixture publication sites in the two publisher suites for guard coverage, including fallback. Record any unexercised branch explicitly; do not infer transport coverage from the helper's unit tests.
5. The runner owns preparation stamping and repository checks. This preparation leaves no stamp, commit, push or PR and claims no completed implementation proof.

## Follow-ups

- When #4915 adds `plateau:src/wip/progress-runs.ts` and `plateau:src/wip/progress-runs.test.ts`, reuse the helper for every standalone producer fixture and pass its populated projection through the same transport assertions. Reconcile the landed interface before adding that scope.
- Broader secret discovery, scrubbing arbitrary public text, and error-log redaction are separate work. A marker oracle catches known fixture leakage, not every possible credential spelling.
- Preserve the original #4624 integration proof requirement: fixtures supplement, rather than establish, evidence about live overview payloads. This item requires no live-data collection during preparation.
