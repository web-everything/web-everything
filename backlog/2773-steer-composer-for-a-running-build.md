---
bornAs: xgkz08u
kind: story
size: 3
parent: "2551"
status: open
scope: ["plateau:src/backlog-view/queue-view.ts", "plateau:src/backlog-view/queue-view.test.ts", "plateau:src/backlog-view/steer-composer.ts", "plateau:src/backlog-view/steer-composer.test.ts", "plateau:src/build-runner/runner.ts", "plateau:src/build-runner/runner.test.ts", "plateau:src/build-runner/steer-action.ts", "plateau:src/build-runner/steer-action.test.ts", "plateau:vite.config.mts", "plateau:tests/e2e/build-steer.spec.ts"]
dateOpened: "2026-07-28"
preparedDate: "2026-10-02"
preparedAgainstSha: "737527064d8dc92011a3b0ef13c0313706078aa7"
tags: []
---

# Steer composer for a running build

Give the operator a composer at the running build to send guidance that runs as its own turn at the next boundary, queued and never silently dropped. Preserve the ratified runner guarantee; a successful stdin write alone is not proof of consumption. Serves G1: steer at the point of work.

## Progress

Preparation checked the local Plateau checkout at `56f3f6efadb6c4d016f9fd8fb349f1be4430e949` and the WE lane. Product citations below use `we:../plateau-app/` as the logical sibling-repository path; frontmatter retains the machine-readable Plateau scope identity.

- **Original premise/scope:** UI plus a route were sufficient because the runner already implemented steering; scope covered only the backlog-view directory and Vite config.
- **Observed premise:** the shared runner/store and stop route exist at we:../plateau-app/vite.config.mts:704–711 and :753–776. That route block has no steer handler. The queue decorates running rows with Stop at we:../plateau-app/src/backlog-view/queue-view.ts:402–423; it restores a run at :539–555. The goal is not delivered by those controls.
- **Delivery evidence limit:** we:../plateau-app/src/build-runner/runner.ts:143–150 writes one stream-JSON user message and immediately returns true; it does not wait for a write callback or confirm a later turn. The existing test at we:../plateau-app/src/build-runner/runner.test.ts:80–89 asserts serialization and no-child refusal only. These observations do not disprove boundary delivery, but do require a real delivery probe before claiming it.
- **Corrected scope:** explicitly include composer, route seam, runner failure handling, integration wiring and their tests. `active()` includes pending, opening and stopping runs (we:../plateau-app/src/build-runner/build-action.ts:97–102); therefore active-run presence alone is insufficient authorization to steer. The UI also omits stopping from its DTO union at we:../plateau-app/src/backlog-view/queue-view.ts:188–192, while the server includes it at we:../plateau-app/src/build-runner/build-action.ts:39. Include that lifecycle correction in the queue integration.
- **Decision preserved:** boundary-delivery, queued, non-dropping is ratified at we:backlog/2444-plateau-loop-phase-1-agent-runner-shape-cli-spawn-contract-s.md:24–29. This preparation adds verification and failure reporting; it does not replace that guarantee with best-effort delivery.

## Design

All changes are proposed, not implemented or live-proven by this preparation.

1. Add a sibling composer module mounted by the queue panel beside the running build controls. Use a labelled multiline field, a Send guidance button, visible focus and a polite status region. Show the target item/run. Follow the existing admin visibility gate at we:../plateau-app/src/backlog-view/queue-view.ts:216–219; this is a UI gate, not a claim of server authentication. Use existing form/action conventions and registered behaviors where applicable; do not invent a new disclosure or keyboard-navigation implementation.
2. Bind each draft and send to the displayed run ID. Enable sending only during `building`; disable for pending, stopping, opening and terminal states. Keep drafts through queue polling/re-rendering, request failure and run settlement; never retarget old text to a replacement run automatically. Teardown removes listeners and pending UI updates. The current row re-render and terminal handling are at we:../plateau-app/src/backlog-view/queue-view.ts:307–308 and :432–460.
3. Add `POST /api/backlog/build/steer` with JSON `{ runId, text }`, returning `{ id, queued: true }` on accepted transport delivery. Require JSON content type (415), valid JSON and nonblank string text plus run ID (400), POST (405), and an exact current run ID in `building` with a live writable runner (409 otherwise). Preserve entered text when validating whitespace. Recheck the target immediately before writing after asynchronous body reads. Mirror the stop route's content-type guard, not its unqualified active-slot targeting (we:../plateau-app/vite.config.mts:766–774). Put validation/dispatch in a testable product-local action module; wire it to the same runner/store, with no new process spawn.
4. Retain the stream-JSON user-message transport at we:../plateau-app/src/build-runner/runner.ts:146–150. Harden closed/errored stdin and write-callback failures; Node backpressure must not cause a duplicate write. Update the runner return contract and its callers/tests together if asynchronous acceptance is required. Return an explicit failure on a failed write, never queued success. Distinguish “queued for next turn” from “agent has acted on it”; keep the submitted text visible. On an ambiguous network outcome, retain it with an unknown-outcome notice and no automatic resend. Disable duplicate submission while a request is pending.
5. Preserve FIFO sends to the live child, no interrupt/kill/resume, and preserve Stop. A boundary-delivery proof is a release requirement, not an inference from HTTP success. If the real CLI fails that guarantee, escalate the observed contradiction against #2444 instead of weakening acceptance or substituting another transport policy.

## MVP

- An operator can submit guidance from a restored or newly started running build and see queued acceptance or an actionable failure without losing text.
- Exact-run targeting prevents a stale tab from steering a later build. Stop/exit races refuse further sends; they cannot report new guidance queued against a terminal run.
- Two accepted messages during a busy turn appear in order as subsequent user turns. Neither interrupts the current work; a transport failure is visible and preserves the text.
- Include all source and test paths declared in scope. The composer/action modules and browser spec are new proposed files; queue/runner tests extend existing coverage. No output-tail, take-over, redirect, durable cross-restart queue, or editing/reordering already handed-off messages in this slice. The broader queued/reorderable supervision envelope remains in we:backlog/2551-live-agent-supervision-surface.md:19–20.

**Delivery shape:** one Plateau implementation delivery with tests. WE changes here are card preparation only, not a new standard or runtime dependency. Placement follows we:docs/agent/platform-decisions.md:143–160 (`#constellation-placement`). No mixed implementation scope currently needs splitting. Apply #4289's per-repo approach if implementation discovers a new shared contract is necessary: propose a WE contract/examples/conformance-test predecessor that is useful independently, then a Plateau consumer/test successor blocked by it. Do not silently add WE runtime files or omit them from scope. The ruling is recorded at we:backlog/4289-design-multi-repo-couple-locus-delivery-e-g-we-plateau-app-2.md:19–21; coupled delivery remains a supported future approach, not a blanket prohibition.

## Test plan

- Extend we:../plateau-app/src/build-runner/runner.test.ts:80–89 with ordered multiple messages, no child, closed/destroyed stdin, synchronous and callback errors, and backpressure without duplicate writes. Keep stop/resume/redirect regressions green.
- Add we:../plateau-app/src/build-runner/steer-action.test.ts (proposed): valid delivery; bad method/content type/body/text; absent, mismatched, pending, stopping and terminal run; runner refusal; write error; run replacement while reading the body. Assert exact run identity, unchanged message text and no spawns.
- Add we:../plateau-app/src/backlog-view/steer-composer.test.ts (proposed), and extend we:../plateau-app/src/backlog-view/queue-view.test.ts: test accessible labels, blank sends, duplicate clicks, draft retention through re-render/error, restored runs, stopping state, stale responses and teardown. Assert observable text/status/request behavior.
- Add we:../plateau-app/tests/e2e/build-steer.spec.ts (proposed): exercise the actual mounted composer and HTTP route using a controlled runner child; verify JSON errors, keyboard submission, visible queued/error states and two ordered messages. A route stub alone cannot prove Vite wiring.
- Run affected Plateau Vitest tests, the browser spec and the product render-conformance gate; then the Plateau lane's required gates. WE verification for this card-only change is running we:scripts/verify-lane.mjs with Node, including standards checks. Do not claim product tests ran during preparation.

## Proof plan

1. In an isolated Plateau development lane, boot its server and use a controlled child with a held first turn. Send two distinct markers through the real browser composer and route while busy; release the turn and capture ordered child input, status transitions and the browser result. Probe a wrong run ID and Stop/Send race, verifying no unintended child receives text. This establishes integration, not the CLI guarantee.
2. Before accepting implementation, use the real supported CLI with a bounded scratch task and a deliberate busy turn. Submit two guidance markers through the composer, then capture the original turn completion and both subsequent user turns/results. Record provider/version, run/session identity and timing. The live build drains runner events until exit at we:../plateau-app/src/build-runner/build-action.ts:267–277; use that observable stream to correlate results. Confirm the original child/session is retained.
3. Capture a keyboard walkthrough and narrow-screen screenshot showing label, focus, target run, retained draft and failure state. Record exact commands/results and artifact locations in this card. No successful live proof is asserted yet. Failure to observe both markers at boundaries blocks completion and requires diagnosis; neither mocked writes nor a 2xx response substitutes for that observation.

## Follow-ups

- Keep testing lessons and proof artifacts linked here; do not append shared agent documentation during implementation.
- Parent-epic queue editing/reordering, output-tail and post-mortem work remains separate (we:backlog/2551-live-agent-supervision-surface.md:19–25). This slice must not imply that messages already written to stdin can be recalled.
- Durable replay, acknowledgement history and automatic retries require explicit identity/idempotency semantics before any later extension; the MVP retains text and exposes ambiguous outcomes instead of silently retrying.
