---
bornAs: x2b8ziv
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/backlog/scaffold.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs", "we:backlog/2776-owner-review-triage-screen-for-feedback-suggestions.md"]
dateOpened: "2026-10-02"
dateStarted: "2026-10-06"
dateResolved: "2026-10-06"
preparedDate: "2026-10-03"
preparedAgainstSha: "8a4b96161632caafcc5da32b896d16e3758787ec"
tags: []
---

# Prevention — Add a card-template security checklist item for any receive or write endpoint: body-size cap, rate limi… (from chalbert/web-everything#3555 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/2776-owner-review-triage-screen-for-feedback-suggestions.md` — Add a card-template security checklist item for any receive or write endpoint: body-size cap, rate limit, CSRF/origin check, and abuse of any state-resetting trigger. Mirror it in the port test-plan stub. Longer term, a prepare-card lint could require those keywords when scope contains a port or route.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3555@e974a229d79cf04905ad54d9e5f3712ec6d37b64

## Progress

Delivery sanity read (2026-10-06): before implementation, the shared renderer and the feedback port test-plan stub still omitted the four security prompts; the spec was coherent and not already implemented. Added generated-output regression coverage for all four supported card kinds before changing the renderer. Delivery is limited to authoring guidance and future test obligations, not endpoint hardening.

- Red proof: `npx vitest run we:scripts/backlog/__tests__/scaffold.test.mjs` against the unchanged renderer produced 4 missing-hint failures (story, epic, task, decision) and 14 passes; existing metadata and acceptance assertions passed before the missing-hint assertion.
- Added the conditional four-part authoring hint beside the verbatim guard-relaxation hint. Extended the existing proposed port suite's test-plan bullet with body-size boundaries (including streams), rate-budget boundaries, origin/CSRF cases, reset/wakeup abuse and unchanged stored state on rejection; retained its prior cases. No endpoint controls or proposed Plateau tests are implemented by this item.
- Green proof: the same scoped Vitest command passed all 18 tests after the renderer edit. Rendered a task skeleton in memory and inspected its metadata, executable TODO, unchanged guard hint and conditional security hint; no backlog card was generated. Direct content review confirmed all four port obligations, explicit transport-specific non-applicability, rejection/state preservation and retention of existing cases. The proposed Plateau tests were not run. `npm run check:standards` is deferred to the wrapper because the delivery brief prohibits agent-run gates; edits remain uncommitted for the wrapper.

Preparation inspected the current checkout; no delivery or endpoint-security proof is claimed.

- **Old premise/scope:** the sole scope entry was we:backlog/2776-owner-review-triage-screen-for-feedback-suggestions.md, although the requested prevention includes a reusable card-template change.
- **Corrected premise/scope:** the shared skeleton is `renderItem` in we:scripts/backlog/scaffold.mjs. Its `doneWhen` text currently emits an executable TODO and the guard-relaxation hint, without the four endpoint-security prompts. Both we:scripts/backlog.mjs (the scaffold handler) and we:scripts/operations/scaffold.mjs (the scaffold declaration) call that renderer. Change the shared renderer, with matching existing tests in we:scripts/backlog/__tests__/scaffold.test.mjs; neither caller needs a separate template.
- **Port-stub evidence:** the concrete stub is the “Port — capability” bullet under Test plan in we:backlog/2776-owner-review-triage-screen-for-feedback-suggestions.md. It names proposed plateau:src/backlog-view/feedback-review-port.test.ts and covers authorization, scrub, revisions and retries, but omits body-size caps, rate limiting, CSRF/origin checks and abuse of state-resetting triggers. Retain that card in scope to mirror the checklist there. The proposed Plateau test is evidence of future work, not an existing test or a file to implement in this prevention item.
- **Boundary:** this is template guidance plus a test-plan amendment, not implementation of the feedback endpoint or a new preparation gate. No numerical security limits or transport policy are selected here. The documentation-only scope entry needs a content review; the executable source entry has its matching test in scope.

## Design

Add one conditional endpoint-security checklist hint to the shared card skeleton in we:scripts/backlog/scaffold.mjs, adjacent to the existing acceptance-authoring hint. Suggested wording: “For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.” Keep it visibly authoring guidance, not an assertion that these controls exist or a completed acceptance criterion. Preserve the existing guard-relaxation hint verbatim and preserve frontmatter generation.

Amend the port test-plan bullet in we:backlog/2776-owner-review-triage-screen-for-feedback-suggestions.md with concrete test obligations for all four concerns. Require authors to state the actual cap and rate-limit boundary, the transport's origin/CSRF behavior, and which receive/activity operations can reset disposition or wake snoozed records. An applicability explanation must be specific to the transport; a mock/local adapter alone is not evidence of protection. Reuse the card's proposed plateau:src/backlog-view/feedback-review-port.test.ts rather than inventing a second port suite.

The checklist records required analysis; endpoint-specific values and mechanisms belong to the endpoint's implementation work. Do not add a keyword detector or infer security from filenames in this slice.

## MVP

1. Newly rendered cards contain the conditional four-part security prompt through the shared renderer.
2. The feedback-review port test-plan stub mirrors all four obligations, alongside its existing authorization and state-machine cases.
3. Existing scaffold metadata, executable acceptance placeholder and guard-relaxation guidance remain intact. Unrelated cards can document non-applicability without claiming to expose an endpoint.

## Done when

- **Executable:** the extended suite in we:scripts/backlog/__tests__/scaffold.test.mjs fails against the current renderer because the security checklist is absent, then passes with the template change.
- **Observable:** the port test-plan stub in we:backlog/2776-owner-review-triage-screen-for-feedback-suggestions.md names all four concerns and the corresponding rejection/state-preservation outcomes.
- **Must:** this prevention does not claim that a documented checklist or green scaffold suite secures a running endpoint.

## Test plan

Extend we:scripts/backlog/__tests__/scaffold.test.mjs with output assertions for the receive/write applicability condition, body-size cap, rate limit, CSRF/origin check, state-resetting-trigger abuse and the instruction to mirror tests or justify non-applicability. Assert placement after the acceptance heading, preservation of the existing guard hint and unchanged metadata for representative supported card kinds. Assert against generated text, not solely an exported constant compared to itself.

For the documentation amendment, inspect the port bullet directly: it must call for within-cap versus over-cap requests (including streamed bodies), allowed versus over-budget requests, permitted versus rejected origin/CSRF cases, and repeated or unauthorized activity/reset attempts that must not reopen disposed items or wake snoozed items improperly. Rejected requests must leave stored state unchanged. These are future endpoint tests in proposed plateau:src/backlog-view/feedback-review-port.test.ts, not tests to implement or run in this item.

## Proof plan

At implementation time, run the extended scaffold suite against the unchanged renderer and record the missing-checklist failure; then run it after the edit and record the pass. Use `npx vitest run` with we:scripts/backlog/__tests__/scaffold.test.mjs (strip the repository prefix when supplying the checkout-relative CLI argument). Invoke `renderItem` in memory and inspect the resulting skeleton; no new backlog card needs to be written. Review the feedback port test-plan amendment against the four-part checklist and confirm the existing cases remain.

Run `npm run check:standards` after implementation. Report template/test-plan delivery separately from endpoint hardening; do not report hypothetical Plateau tests as executed. This preparation leaves runner-owned stamping and checks to the runner.

## Follow-ups

A prepare-card lint requiring security coverage for port/route scope remains the explicitly longer-term suggestion, outside this MVP. It needs applicability handling and tests that distinguish authoring hints from completed analysis before it can enforce anything. Endpoint controls and their concrete tests remain with the feedback-review implementation; this item neither delivers them nor redefines its transport policy.
