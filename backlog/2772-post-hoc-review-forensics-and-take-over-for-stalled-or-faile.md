---
bornAs: xaq4sub
kind: story
size: 5
parent: "2551"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/readiness/lane-forensics.mjs", "we:scripts/readiness/__tests__/lane-forensics.test.mjs", "we:scripts/__tests__/lane-pool-release-ownership.test.mjs", "we:scripts/__tests__/lane-pool-release-reap-race.test.mjs", "plateau:vite.config.mts", "plateau:src/backlog-view/post-hoc-review.ts", "plateau:src/backlog-view/post-hoc-review.css", "plateau:src/backlog-view/post-hoc-review.test.ts", "plateau:src/backlog-view/post-hoc-api.ts", "plateau:src/backlog-view/post-hoc-api.test.ts", "plateau:src/backlog-view/lane-board.ts", "plateau:src/backlog-view/lane-board.test.ts", "plateau:src/backlog-view/lane-board-data.ts", "plateau:src/backlog-view/lane-board-data.test.ts", "plateau:src/backlog-view/card-state-read-model.test.ts", "plateau:src/build-runner/build-action.ts", "plateau:src/build-runner/build-action.test.ts", "plateau:tests/e2e/post-hoc-review.spec.ts"]
dateOpened: "2026-07-28"
preparedDate: "2026-10-02"
preparedAgainstSha: "ec42b8635de1191cc9778a6a5aa59485ac5cef36"
tags: []
---

# Post-hoc review: forensics and take-over for stalled or failed lanes

For stalled/stopped/failed/orphaned lanes, show the last observed state, diff-so-far and recorded failure evidence so recover/retry/reassign/discard/take-over is an informed choice. Let the operator assume custody of the existing build, hold its lane, and hand that same work back without losing changes. Unknown causes must remain unknown.

## Progress

Preparation only; no runtime changes. Inspected WE at `ec42b8635de1191cc9778a6a5aa59485ac5cef36` and plateau-app at `f1b2d3fe48632b13eb03e44fb59ccfe50b12fbb9`. In body citations, `we:../plateau-app/` denotes the constellation's plateau-app repository, inspected in the supplied primary checkout; it does not refer to the abandoned Plateau prototype. Machine-readable scope retains the repository's canonical `plateau:` alias so dispatch cannot misclassify product files as WE files.

| Original premise / scope | Checked correction and evidence |
| --- | --- |
| State classification exists for A5/E1/E3. | True, and A10 already models take-over: we:../plateau-app/src/backlog-view/card-state-read-model.ts:189, :192, :203 and :206. Failures take precedence over A10; preserve that ordering and display custody separately. Existing fixtures cover these states at we:../plateau-app/src/backlog-view/card-state-read-model.test.ts:42, :47, :69 and :71. Stopped is also a runner status, not one of those three UC identities: we:../plateau-app/src/build-runner/build-action.ts:39. |
| WE conveyor state supplies “why it stalled.” | It supplies inactivity evidence and separately grouped infrastructure causes, not a general causal diagnosis: we:scripts/readiness/conveyor-state.mjs:421–467. Missing activity is skipped at :454. A direct import probe of `assessHealth` produced one stalled lane for old activity, none for missing activity, and a separate infrastructure cluster for the third lane. Do not turn silence into a fabricated cause. |
| Lane pool already supplies diff-so-far and lease-hold. | Existing adoption changes worker identity and journals a snapshot; it rejects stale leases and requires a durable session identity: we:scripts/lane-pool.mjs:3886–3913. That is not a bounded forensic diff API or a complete operator custody round trip. Ordinary acquisition can reset the lane unless reset is suppressed: we:scripts/lane-pool.mjs:1755. Release checks the exact lease before removal: we:scripts/lane-pool.mjs:2552. Preserve these protections. |
| A panel and read endpoint are enough. | The current route allowlist has no forensic or custody endpoint: we:../plateau-app/vite.config.mts:730–733. Its stop endpoint stops the shared runner at :764–774. The build flow acquires a fresh lane at we:../plateau-app/src/build-runner/build-action.ts:243–245 and releases it in `finally` at :306–308. Its run store is in memory at :70. Custody-aware cleanup and same-lane continuation are therefore part of the change; a stop request alone cannot guarantee a held lane or durable history. |
| Broad product-directory scope plus WE conveyor-state edits. | Replace the directory with explicit product surface, API, build-flow and test files. Add a proposed WE collector and ownership tests. Consume the existing health function without changing its policy; remove conveyor-state from the write scope. Proposed new files in scope are plans, not claims that they exist. |

## Design

### Forensic detail and read contract

Add a lazy “Review interrupted build” action to the lane board for stalled, stopped, failed and orphaned attempts. Keep the board's existing classifier and show its state alongside operator custody, rather than replacing failure with a reassuring take-over badge. Existing classification and fixtures are cited above. Reuse established product components and registered interaction traits; do not create a new standard for this product panel.

Proposed GET `/api/backlog/forensics` accepts a configured repository key, item identity and attempt identity. Resolve pool/lane server-side; never accept an arbitrary checkout path or shell command. Return a versioned DTO containing item, attempt, pool/lane, recorded base and head SHAs, captured-at time, source timestamps, last state, worker/lease identity, activity evidence, recorded error/infra cause, custody, permitted actions and refusal reasons. Each absent source is explicitly unavailable. The runner's recorded failure/stopped outcome is a source when present (we:../plateau-app/src/build-runner/build-action.ts:350–357), not a durable history guarantee after restart.

Implement the WE collector as proposed we:scripts/readiness/lane-forensics.mjs with injectable IO and a pure projection. Read existing conveyor health and lane evidence. Diff sections distinguish committed changes since the recorded attempt base, staged changes, unstaged changes and untracked filenames; report binary files, truncation and unavailable base separately. Use fixed argv, no shell interpolation, bounded output/time, and no external diff/text conversion. Never reset, fetch, acquire, release or disclose raw transcript contents during GET. Revalidate attempt/lease/head around collection; flag an inconsistent snapshot and disable its actions instead of presenting it as current. The panel renders patch text as text, with loading, empty, partial, stale and unavailable states.

- **Forensic confidentiality:** untracked files contribute filenames only, never file contents. Exclude or redact gitignored and known secret paths from patch bodies across committed, staged and unstaged categories. Filter before serialization, not only during panel rendering; secret contents must not leak through error or truncation metadata. This is a path-based confidentiality contract, not a claim of general-purpose secret detection.

### Operator custody and hand-back

Every custody POST must independently validate JSON content type, same-origin Origin and loopback Host before invoking a custody backend or changing runner/lease state. Reject non-JSON content types, a mismatched Origin and a non-loopback Host with no mutation; JSON alone is not the complete guard.

Proposed POST custody actions carry the same attempt identity, an expected lease version and an idempotency key. Re-read eligibility immediately before any mutation. Unknown repo, stale attempt, recycled lane, reserved lane, changed owner or unconfirmed worker shutdown yields a named refusal with no mutation. Do not map the UI directly to forced adoption: today's command writes `workerSession` and requires a session environment (we:scripts/lane-pool.mjs:3889–3904); it does not supply the required full transfer protocol.

Use the existing lane-pool ownership authority to implement atomic custody transitions, preserving branch, index, worktree, untracked files and item mapping. For a live stalled build, request the existing graceful stop and observe process termination before transfer; if that cannot be confirmed, retain the failure and refuse take-over. Arrange custody intent/cleanup coordination before stopping so the old build's `finally` cannot free the lane between stop and transfer. Preserve normal cleanup when no custody request exists. Persist custody and the interrupted-attempt pointer outside the in-memory run map so reload/server restart can recover the hold. The holder must remain excluded from acquire/reap while custody is valid; display loss of custody explicitly.

Hand-back is an acknowledged transfer to a new worker continuing the same checkout, not ordinary lane release followed by ordinary acquire. Add an explicit continuation input to the build flow that validates custody/base/head and bypasses its fresh-acquire/reset path. Keep the operator hold until receiver acknowledgement; on failure retain custody and offer retry. Duplicate requests return the original result. Old-worker cleanup must not remove the successor's lease, extending the exact-lease protection already present at we:scripts/lane-pool.mjs:2552. “Release” in this surface means hand-back, not silently freeing dirty work for another build.

Recover/retry/reassign/discard must display their consequences and eligibility alongside evidence. MVP supports the custody recovery path and same-lane hand-back; other actions expose a reason when unavailable, never a success-looking inert control. Destructive discard remains a separately explicit operation; opening the panel or handing back must never discard work.

### Per-repo delivery split (#4289)

The original goal genuinely spans both repos. Keep the complete mixed scope visible until decomposition is authored; this preparation does not create cards or rewrite dependencies. The current wrapper refuses a mixed locus before acquisition (we:scripts/operations/deliver-item-wrapper.mjs:375–382). The operator's #4289 ruling retained coupled delivery as a future capability while selecting a useful predecessor/successor split (we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:19–21). Apply that approach here, not a permanent ban on mixed work. Per-repo ownership remains governed by we:docs/agent/platform-decisions.md:5511 (`#conveyor-multi-repo-model`).

1. **WE operational predecessor, proposed size 5:** all five WE scope entries. Deliver a bounded CLI forensic read plus version-checked custody/hand-back primitives, durable attempt/custody evidence and isolated-repo tests. Independent value: an operator can inspect and safely transfer an interrupted disposable build via CLI without Plateau. This extends the existing operational tooling; it does not mint a normative WE plug contract. CLI output defines the additive versioned seam and examples consumed by the product tests.
2. **Plateau successor, retain #2772 and re-estimate at split:** all product scope entries, including build cleanup/continuation, route adapter, panel, board projection and tests. Add `blockedBy` pointing to the real predecessor ID after it is created. Consume its landed CLI revision, gracefully disable writes when unavailable, and prove the complete UI round trip. Keep the current size unchanged during this card-only preparation.

Land and verify the predecessor first, then the consumer. Neither intermediate version may require its counterpart to preserve current build cleanup. Do not dispatch this still-mixed card through the current wrapper, remove real scope to evade refusal, or claim the goal done when only CLI primitives ship.

## MVP

- A keyboard-accessible interrupted-build panel shows current identity, last state, evidence-backed reason or “unknown,” and every diff category with explicit missing/truncated markers.
- Every read is bounded and non-mutating; stale or mismatched snapshots cannot authorize a mutation.
- Untracked evidence contains filenames only, never file contents. Gitignored and known secret-path contents are absent from the serialized forensic DTO, including committed, staged and unstaged patch bodies and error/truncation metadata.
- Every custody POST independently rejects non-JSON content types, a mismatched Origin and a non-loopback Host before any custody backend call, runner stop or lease write. Rejection causes zero mutation; a valid same-origin loopback JSON request reaches the backend.
- Take-over holds the original lane only after worker termination and fresh ownership validation. Refreshing the UI or restarting its server restores the durable custody view.
- Hand-back continues the same changes in the same lane; failed transfer keeps custody. Concurrent/duplicate actions and delayed cleanup cannot free another holder's lane.
- Existing normal builds retain cleanup behavior. Failure state precedence remains unchanged. Alternatives show honest availability and consequences; no automatic discard or reassignment is introduced.
- Both delivery slices include their tests and observed proof before the original end-to-end goal is complete.

## Test plan

These named tests are implementation obligations, not runtime tests delivered by the #4816 documentation amendment:

- **Capability (Red today; handler/test are proposed, not executed here):** **“custody POST rejects non-JSON, mismatched Origin and non-loopback Host without mutation”** in proposed plateau:src/backlog-view/post-hoc-api.test.ts. Exercise real handler dispatch with an injected backend for every custody action. Vary each invalid header independently while keeping the other headers valid; assert refusal and zero backend calls, runner stops or lease writes. Include a valid same-origin loopback JSON request that reaches the injected backend, so rejecting all requests cannot satisfy the test.
- **Capability (Red today; collector/test are proposed, not executed here):** **“lane forensics omits secret contents and lists untracked names only”** in proposed we:scripts/readiness/__tests__/lane-forensics.test.mjs. Exercise the collector's real read/serialization path in an isolated git repository seeded with unique fake-secret sentinels in an ignored file, a known secret-path fixture and an ordinary untracked file. Cover secret-path changes in committed, staged and unstaged patch categories. Assert that the serialized DTO contains none of the sentinels, including error/truncation metadata; the ordinary untracked filename is present without its contents; and an ordinary tracked patch still appears. Compare repository state before/after to assert no mutation. Use fake values, never local credentials.

**WE:** proposed we:scripts/readiness/__tests__/lane-forensics.test.mjs exercises stale/missing activity, explicit stop/failure, infra cause versus silence, missing base, recycled lane, staged/unstaged/committed/untracked/binary changes, bounded patch output, read errors and non-mutating collection. Extend we:scripts/__tests__/lane-pool-release-ownership.test.mjs with temporary git repos and controlled processes to prove atomic transfer, shutdown refusal, durable hold, duplicate request, stale version, concurrent takeover, cleanup races, failed hand-back and same-lane acknowledgement. Extend we:scripts/__tests__/lane-pool-release-reap-race.test.mjs to pin successor protection. Run these real-process suites via `npm run test:integration:vitest -- <test-paths>`; they are deliberately excluded from the unit tier (we:vitest.config.ts:183 and we:vitest.integration.config.ts:5–14). Run the existing conveyor-state tests as regression coverage; do not change their inactivity policy.

**Plateau:** proposed we:../plateau-app/src/backlog-view/post-hoc-api.test.ts tests real handler dispatch with injected backend: repo/attempt validation, malformed JSON, method/content-type checks, output bounds, conflicts and service unavailability. Proposed we:../plateau-app/src/backlog-view/post-hoc-review.test.ts covers evidence rendering, escaped patch content, stale responses after selection changes, duplicate clicks, focus restoration and custody failure feedback. Extend the board/projection/classifier tests listed in scope, preserving E1/E3 precedence over A10. Extend we:../plateau-app/src/build-runner/build-action.test.ts for stop-before-spawn, stop/transfer/finally races, ordinary cleanup, server restart recovery and continuation without fresh acquire/reset. Stub all spending/PR/network actions.

Proposed we:../plateau-app/tests/e2e/post-hoc-review.spec.ts covers each interrupted state, unavailable evidence, keyboard opening/closing, visible focus, narrow-screen patch overflow and the successful/failed take-over and hand-back paths. Use the product's existing components/traits and check accessible names, headings and focus order. Run each repo's affected suites and required gates separately; WE verification is not Plateau runtime proof.

## Proof plan

Implementation proof, not claimed performed by this preparation:

1. Seed an isolated temporary pool with identifiable committed, staged, unstaged and untracked changes and controlled failed/stopped/stalled/orphaned attempts. Never use live production leases or launch a paid worker for these checks.
2. Curl the real read endpoint against a disposable secret-fixture repository; compare all diff categories against git and hash HEAD/index/worktree/untracked contents before and after to prove GET did not mutate them. Inspect the actual serialized response for sentinel absence, ordinary tracked patch presence and filename-only untracked evidence, including error/truncation metadata. A screenshot hiding secret text is insufficient. Record missing/truncated evidence cases and timestamps.
3. Drive the running Plateau panel by keyboard; capture the state, evidence, focus return and narrow viewport rendering. Inspect the actual endpoint response as well as pixels.
4. Take over a controlled stopped worker. Observe lease/custody state, unchanged contents and exclusion from acquire/reap. Reload and restart the product server, then show the same held attempt.
5. Hand back to a controlled receiver. Observe the identical checkout and contents, new ownership and continuation without reset. Race a stale second client and old cleanup; both must preserve the new holder. Kill the receiver before acknowledgement and prove the operator retains custody.
6. Record exact repo SHAs, commands, responses and artifacts in the implementing cards. A green classifier test alone does not prove lease custody or a functioning endpoint.
7. Send non-JSON, mismatched-Origin and non-loopback-Host requests independently to each real custody action against a disposable backend/pool, keeping other headers valid. Record refusal, zero backend/stop/lease writes and unchanged ownership. Send the valid same-origin loopback JSON control separately and observe backend dispatch.

## Follow-ups

- Consider a shared origin-guard helper and lint/standards enforcement for new mutating development middleware routes separately. This amendment does not mandate a repository-wide middleware migration or select a new standards rule.
- Make exact secret-path matching and missing-Origin handling explicit and test them during API/collector implementation; this amendment does not settle those policy details.
- Author the two single-repo cards/edge before dispatch; this session only proposes the split. Keep full scope until that explicit decomposition occurs.
- Extend recovery alternatives beyond the custody round trip only with their own acceptance and destructive-action proof; do not silently broaden this into arbitrary process termination, discard or a new orchestration policy.
- Testing lesson: a runner stop is not proof of lane retention, and an adoption marker is not proof the previous process exited. Keep the preservation and delayed-cleanup race tests on the implementing cards; no shared agent-document edits are needed.
- Longer historical retention and remote operator identity integration can build on the durable attempt/custody record; this MVP must still recover active custody after server restart.

## Preparation verification

- `node we:scripts/backlog.mjs prepare-stamp 2772` wrote the preparation date and WE HEAD stamp; status remains open.
- `node we:scripts/check-backlog-item.mjs 2772` passed; `git diff --check` passed.
- `node we:scripts/verify-lane.mjs` passed: the card-only diff selected no related unit tests, then the standards gate reported zero errors and 5,215 warnings. This is preparation validation, not implementation proof.
- Only this card was edited. The implementation tests and live proof above remain acceptance work for the proposed delivery slices.
