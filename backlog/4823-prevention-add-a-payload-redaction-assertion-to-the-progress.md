---
bornAs: xh0f3u1
kind: story
size: 3
parent: "4075"
status: open
scope: ["plateau:src/wip/payload-leak-check.ts", "plateau:src/wip/payload-leak-check.test.ts", "plateau:src/wip/progress-read.test.ts", "plateau:src/wip/wip-publish.test.ts", "plateau:src/wip/wip-agent.test.ts"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-19"
preparedAgainstSha: "2f581cdb099d32eadcb51cc41fba8819c7053bc0"
tags: []
---

# Prevention — Add a payload-redaction assertion to the progress-runs and wip-publish test list. Better, add a shared… (from chalbert/web-everything#3327 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4624-show-actual-executors-and-standalone-jobs-in-plateau-running.md` (historical approval citation: line 79; current Test plan begins at line 95) — Add a payload-redaction assertion to the progress-runs and wip-publish test list. Better, add a shared leak-check helper that every publisher fixture test runs against the serialized payload.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3327@c57098509c4ea43995028750603a59c912694ebf

## Progress

Preparation revalidated on 2026-11-19 against the live plateau-app checkout at `af64fef954a9c77bf3cfdf63c9f0bea7d228bc5e`. This is source inspection only; no runtime tests or publication were performed. `plateau:` means plateau-app, not the abandoned Plateau prototype, consistent with `we:docs/agent/platform-decisions.md#constellation-placement`.

- **Old premise/scope:** the 2026-10-03 preparation scoped five test-support/test files, asserted the standalone run adapter was absent, and cited WebSocket serialization at lines 151–167. It proposed assertions inside fake transport boundaries without accounting for swallowed exceptions.
- **Corrected premise/scope:** keep the five-file test-only scope. Neither `plateau:src/wip/progress-runs.ts` nor `plateau:src/wip/payload-leak-check.ts` exists in the inspected tree; searching the current WIP tests found no shared payload guard. `plateau:src/wip/progress-read.ts:52-64` still projects explicit public fields. `plateau:src/wip/progress-read.test.ts:26-37` still uses null transcript paths for working/unknown rows. The goal is not already delivered.
- **Transport evidence:** `plateau:src/wip/wip-publish.ts:48-69` serializes and catches fetch failures; `plateau:src/wip/wip-publish.test.ts:22-52` checks parsed equality and error results. `plateau:src/wip/wip-agent.ts:162-185` catches socket-send exceptions and passes the snapshot object to the HTTP fallback. Capture raw bytes, then assert outside these catches. `plateau:src/wip/wip-agent.test.ts:25-31` currently stores parsed frames; its fallback at lines 253–264 only counts a mocked publisher. Wire that mock through real `publishOnce` with fake fetch to prove serialized fallback coverage.
- **Callers/defaults:** `plateau:scripts/wip-publish.ts:130` uses HTTP publication; line 192 wires the live agent's fallback to `publishOnce`. No runtime defaults, caller interfaces, cadence or authentication policy change. Test fixture defaults become populated projected runs, and all snapshot-emitting fixtures receive the guard. Non-snapshot messages and publish-loop tests returning only result objects are outside the payload guarantee.
- **Requirement:** `we:docs/agent/plateau-progress-view.md:132` prohibits credentials, absolute transcript paths and raw transcripts in the overview. This does not assert an observed production leak or require new redaction policy.
- **Estimate:** retain story size 3. Expected changed lines: new helper about 45, matching tests about 70, projection tests about 40, HTTP tests about 45, agent tests about 60 (about 260 total across five files). The existing seams above support this estimate; no runtime edits or new dependency are required.

## Design

Add a test-only `assertPayloadHasNoLeaks` helper (proposed) in `plateau:src/wip/payload-leak-check.ts`, accepting the actual serialized JSON string and an explicit list of forbidden synthetic values. Validate JSON and require a nonempty marker list containing only nonempty strings; reject missing/non-string payloads and malformed marker inventories without echoing inputs; inspect decoded string values and keys recursively so JSON escaping cannot conceal a fixture marker. Return no transformed payload. Failure messages identify the marker category or index without echoing its value or the full payload.

Use distinct deterministic markers for a credential, raw prompt/tool transcript content, and absolute transcript paths (POSIX and Windows forms). This is a fixture regression oracle, not a universal secret detector: do not invent regex rules that reject legitimate URLs, public descriptions, or repository-qualified paths. Authentication headers remain required and are outside the snapshot-body assertion.

In `plateau:src/wip/progress-read.test.ts`, feed `readMoving` a populated row with a non-null private transcriptPath and extra private source fields, keeping legitimate public metadata populated. Check its serialized projection with the helper and assert the expected public fields and counts survive. Carry that real projection into populated publisher fixtures instead of constructing only an empty snapshot or passing raw source records straight to transport.

In `plateau:src/wip/wip-publish.test.ts`, retain every actual fetch body and inspect it after the publication settles, before normalization. Assertions must run outside production catch blocks, preferably in a shared after-test verification hook; capture even requests whose fake response fails. In `plateau:src/wip/wip-agent.test.ts`, retain raw fake-socket sends alongside the existing parsed representation and check the retained original snapshot frame strings after publication settles. Parse only to classify protocol frames; never reserialize a parsed frame as the assertion input. A malformed captured frame fails verification. Keep captures separate from mock call histories so clearing mocks cannot erase evidence. Apply the shared guard to every snapshot-publishing fixture in those suites, including HTTP fallback: replace the default fallback stub with real `publishOnce` plus a capturing fake fetch. Exclude non-snapshot protocol messages. Preserve existing behavior assertions so an empty or dropped payload cannot satisfy the guard alone.

## MVP

One shared test helper, its own positive/negative tests, a contaminated-source projection regression and guard calls at both serialized transport boundaries. Cover credentials, raw transcript text and absolute transcript paths using synthetic fixtures only. No production sanitizer, schema change, live credential read, relay deployment or standalone run adapter is included. If a test exposes a real runtime leak, record the exact synthetic reproduction and prepare a separately scoped runtime fix rather than silently expanding this test-only item.

## Acceptance

The following are proposed named tests. Add them first, retaining their imports/calls to the not-yet-built shared helper for an observable initial red run; implement the helper and suite wiring next. Existing projection behavior alone is not an initial-red claim. Each test must fail before the build and pass afterward, with mutation sensitivity checked separately.

- [A1] Executable: `plateau:src/wip/payload-leak-check.test.ts` — “rejects leaked markers in keys, nested arrays and escaped values” table-tests credentials, raw transcript text and POSIX/Windows transcript paths, including markers embedded within longer strings; “accepts safe populated JSON” preserves legitimate URLs and repo-qualified references.
- [A2] Executable: `plateau:src/wip/payload-leak-check.test.ts` — “fails closed on missing or invalid JSON and invalid marker inventories” covers undefined/non-string payloads, malformed JSON, absent/empty lists and empty/non-string entries; “never echoes payloads or markers in diagnostics” checks all error paths. Failure is an explicit test error requiring fixture correction, never a skipped check or sanitized success.
- [A3] Executable: `plateau:src/wip/progress-read.test.ts` — “projects hostile working and unknown rows without private markers” asserts exact public run fields, unknown/raw state, timestamps and working/logical counts, plus the shared guard on serialized output. Inject private extras into source-only fields; do not expect arbitrary public description text to be scrubbed.
- [A4] Executable: `plateau:src/wip/wip-publish.test.ts` — “guards every captured HTTP snapshot and preserves populated projection” passes hostile-source `readMoving` output into the fixture and asserts a nonempty captured body, public metadata, bearer header and guard coverage for success and failure responses. “unreadable snapshot sends no request” keeps the no-send path explicit.
- [A5] Executable: `plateau:src/wip/wip-agent.test.ts` — “guards populated first, changed, refreshed and keepalive snapshots” and “guards serialized HTTP fallback until socket opens” assert expected sends, public metadata and the same marker inventory. Default fake transports capture all snapshot fixtures, including reconnects; post-test assertions run outside swallowed transport exceptions. The fallback uses real `publishOnce` and fake fetch; a zero-send fixture cannot satisfy a test requiring publication.
- [A6] Executable: the A3–A5 tests must fail independently when transcriptPath is restored to the projection, a marker is injected into an HTTP body, a marker is injected into a WebSocket snapshot frame, or a marker is injected into the disconnected fallback body. Remove each temporary mutation and require green again. No production defaults change; the changed fixture defaults and both existing publisher callers are exercised by A4/A5.

## Test plan

- `plateau:src/wip/payload-leak-check.test.ts` is the matching test for the new `plateau:src/wip/payload-leak-check.ts`. Table-test each marker category, nesting, JSON escaping, safe payloads and invalid helper inputs. Assert diagnostics do not reproduce sensitive marker text.
- `plateau:src/wip/progress-read.test.ts` covers the current source-to-public-run boundary with populated hostile input and positive output assertions. Test unknown states as well as working rows so private extras cannot escape through alternate projections.
- `plateau:src/wip/wip-publish.test.ts` checks the real serialized HTTP body and preserves the bearer-header assertion separately. Keep existing error-result tests; they cover a different boundary.
- `plateau:src/wip/wip-agent.test.ts` checks raw serialized snapshot frames and the disconnected HTTP fallback fixture with the same marker inventory. Assert the expected snapshot is actually sent and contains the populated run.
- Through the host queue entry point `we:scripts/readiness/heavy-admission.mjs` (`run --wait-ms 60000 -- npx vitest run`), with plateau-app as the child working directory, run these explicit test arguments: `plateau:src/wip/payload-leak-check.test.ts`, `plateau:src/wip/progress-read.test.ts`, `plateau:src/wip/wip-publish.test.ts`, and `plateau:src/wip/wip-agent.test.ts` (strip the repository prefixes when passing filesystem arguments). Add the helper tests first: the missing helper should produce the initial red result. Existing runtime omission behavior may already pass; the mutation checks prove the new regression sensitivity.

## Proof plan

1. Record the tested Plateau revision and exact targeted command, exit status and test totals. Use only in-memory synthetic inputs and fake transports; no paid worker or authenticated relay call is necessary.
2. Capture that the same contaminated-source projection reaches the HTTP request body and WebSocket snapshot frame, with expected public metadata intact. Record assertion outcomes rather than copying private fixture values into logs.
3. Temporarily mutate each boundary independently: restore transcriptPath to `readMoving` output; append a marker to the HTTP body; append a marker to the WebSocket snapshot. Each mutation must fail its corresponding suite. Remove each mutation and rerun the targeted command to green.
4. Review all snapshot fixture publication sites in the two publisher suites for guard coverage, including fallback. Record any unexercised branch explicitly; do not infer transport coverage from the helper's unit tests.
5. The runner owns preparation stamping and repository checks; existing preparation metadata is preserved for it to replace. This preparation leaves no stamp, commit, push or PR and claims no completed implementation proof.

## Follow-ups

- When #4915 adds `plateau:src/wip/progress-runs.ts` and `plateau:src/wip/progress-runs.test.ts`, reuse the helper for every standalone producer fixture and pass its populated projection through the same transport assertions. Reconcile the landed interface before adding that scope.
- Broader secret discovery, scrubbing arbitrary public text, and error-log redaction are separate work. A marker oracle catches known fixture leakage, not every possible credential spelling.
- Preserve the original #4624 integration proof requirement: fixtures supplement, rather than establish, evidence about live overview payloads. This item requires no live-data collection during preparation.
