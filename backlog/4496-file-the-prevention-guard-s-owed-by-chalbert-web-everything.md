---
bornAs: xv21yh3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/backlog-workflow.md", "we:skills-src/conveyor/prepare-item-worker-brief.md", "we:skills-src/conveyor/prepare-item-agent-brief.md", "we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "e2bed0a8c3b86ff61617d318f55efeda18ff5b21"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2953's independent review

The independent approval review of chalbert/web-everything#2953 left prevention debt: attribution designs must identify their ownership evidence and test another writer; caps narrowed by a new data source must state and test their failure default. Add those checks to card authoring and prepare-first guidance. The original request to require `workItem` is obsolete under the current `kind` schema.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2953@73d12a3ecb338987d84642f80b65091118fdbc8f

## Progress

- **Original premise/scope:** only `we:backlog/4494-builder-open-items-limit-counts-only-the-builder-s-own-items.md` was scoped. The approval cited its old lines 27/32 for missing ownership evidence and read-failure handling, and line 2 for a supposedly invalid `kind` field. It requested a checklist/lens plus a `workItem` presence gate.
- **Corrected premise:** #4494 is resolved. Its Prepare verification, Design, and Follow-ups already describe the run-store mechanism and accepted fail-open behavior; its old line citations no longer identify the missing work. `we:skills-src/conveyor/build-dispatch-daemon.mjs`'s `deriveDispatchedByBuilder` unions item numbers from two readers. `cliListRunStoreInFlight` and `cliListSettledBuilds` select run IDs starting with `dispatch-lane` and build effects, and degrade on listing/read errors. This is a provenance claim about the selected producer path, not an explicit actor-ID comparison. The `dispatch.executor` field identifies provider, not builder ownership; do not substitute it as an ownership discriminator.
- **Existing coverage:** `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` already exercises both real readers with a run-store path that is a file, expecting empty results. `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs` covers worker PR exclusion, builder inclusion, deduplication, unchanged other caps, and the omitted-attribution-input fallback. These are evidence for the documented behavior, not proof that every possible store writer is builder-owned.
- **Schema correction:** `we:scripts/check-standards-rules.mjs`'s `validateBacklogItem` already requires `kind` and validates it against `BACKLOG_KINDS`; `we:scripts/backlog/migrate-kind.mjs` explicitly migrates away from `type`/`workItem`. Requiring `workItem` or rejecting `kind` would reverse the current schema. No schema change is owed here.
- **Corrected scope:** the remaining deliverable is reusable authoring/prepare guidance in `we:docs/agent/backlog-workflow.md` and both current probation briefs, `we:skills-src/conveyor/prepare-item-worker-brief.md` and `we:skills-src/conveyor/prepare-item-agent-brief.md`. Their matching existing test home is `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`; extend it to cover the shared guidance contract. Runtime files and the resolved #4494 card are evidence only. This preserves the prevention goal without changing the accepted failure policy.

- **Re-prepare 2026-10-09 (stale stamp):** the prior stamp (`c6e39f4de`) predates edits to `we:skills-src/conveyor/prepare-item-agent-brief.md` (now six sections incl. a required `## Edge cases this change must handle`, plus a commit-first gate flow), `we:skills-src/conveyor/prepare-item-worker-brief.md` (`size:` / `## Proposed blockedBy changes` paragraph), and `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` (new #4670 case). Premise re-checked on `main`: no attribution/failure-default checklist exists in any of the four scoped files, so the goal is undelivered. Goal and scope unchanged. Insertion point in `we:docs/agent/backlog-workflow.md`: directly after the "Story-kind extension — `preparedDate` + `preparedAgainstSha` (#3108)" paragraph (~line 616), which is where story/task preparation readiness is defined; there is no separate "build-item Definition of Ready" heading, so the new checklist is a sibling paragraph there. The agent brief's Edge-cases class 4 (fail closed) and class 7 (who wrote it) overlap the new checklist; the checklist must cross-reference them rather than restate them. Builders must also touch the existing `Only edit that card's body…` worker-brief line only by appending, not rewording.

- **Re-prepare 2026-11-18 at `e2bed0a8c3b86ff61617d318f55efeda18ff5b21`:** old scope remains the four frontmatter paths; the missing reusable checklist remains undelivered. Corrected premise: run-ID selection and read-error degradation now live in shared `readDispatchLaneRunRecords` at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1760`; both readers consume it at lines 1776 and 1814, with configurable `launchKind` defaulting to build. The union still lives at line 285. Do not describe the two readers as independently listing the store. Existing error coverage is visible at `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:1611`; omitted-input compatibility is separately tested at `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs:391`. No runtime policy change is needed for this prevention task.
- **Current insertion and callers:** the story-kind paragraph is now `we:docs/agent/backlog-workflow.md:627`; insert a named checklist immediately after it. Both caller briefs now carry executable-acceptance directives (`we:skills-src/conveyor/prepare-item-worker-brief.md:37`, `we:skills-src/conveyor/prepare-item-agent-brief.md:294`). Preserve those directives and the worker authority sentence at line 9 verbatim; add a separate checklist paragraph. Agent edge-case classes 4 and 7 remain at lines 59 and 62. The existing contract suite reads both briefs at `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs:12` and pins authority/stop boundaries at lines 23–34 and 46–64, but does not read the canonical guidance or assert this checklist. Schema remains `kind`, required at `we:scripts/check-standards-rules.mjs:505` and validated at line 516.
- **Scope/size evidence:** retain scope and size 3 (old 3 → new 3): approximately 25–35 guidance lines after `we:docs/agent/backlog-workflow.md:627`, 8–12 lines in each brief near their method instructions, and 60–90 contract-test lines extending `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs:16`. These are one shared documentation contract and its two callers, with no runtime edits. This story receives no `estimatedLoc`. Existing stamps are left untouched for the runner; this pass does not stamp.

## Design

Add a stable `attribution-and-failure-default-checklist` anchor immediately after the story-kind preparation paragraph in `we:docs/agent/backlog-workflow.md:627`. This is the canonical semantic checklist for card authors and preparers. Both `we:skills-src/conveyor/prepare-item-worker-brief.md` and `we:skills-src/conveyor/prepare-item-agent-brief.md` must link to that anchor and summarize its three obligations so the self-contained worker route cannot silently omit them:

1. **Ownership evidence:** name the persisted actor field, accepted value, reader/filter, and writer evidence. If there is no actor field, explicitly document and substantiate exclusive-producer provenance; a store name, provider field, or run-ID prefix alone is insufficient. Require an owner and non-owner fixture reaching the actual reader boundary, with expected inclusion/exclusion. An indistinguishable other writer is an evidence gap to escalate, never permission to invent an actor discriminator.
2. **Failure-default evidence:** for a cap narrowed by a data source, specify unavailable, corrupt, missing, and aged-out records and the resulting cap behavior, with named tests. Distinguish omitted optional input from a failed read returning an empty collection. Follow changed defaults through callers and persisted old records; if a refusal is proposed, name its operator-visible recovery/escalation. Record an already accepted default faithfully; an unresolved policy change stops preparation.
3. **Applicability and authority:** irrelevant cards need no attribution machinery. Cross-reference agent edge-case classes 4 and 7; clarify that the new checklist fails preparation on missing evidence, without silently rewriting an existing runtime failure policy. Preserve existing worker authority, already-done/no-edit, and genuine-judgment-fork exits.

Use #4494 as a worked caution, citing `we:skills-src/conveyor/build-dispatch-daemon.mjs:1760` and `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs:391`: producer provenance is not an actor field, and empty-on-error is not omitted-input fallback. This example describes the accepted policy without claiming every store writer is builder-owned.

Extend the existing contract suite in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`. Read the canonical document relative to the test module, extract the anchored checklist with an explicit missing-anchor assertion, and assert each obligation independently in the canonical section and both brief paragraphs. Use whitespace normalization and targeted clauses, not whole-document snapshots. Missing files must throw; missing/empty checklist sections must fail. These assertions guard instruction presence, not semantic truth of future agent judgments.

## MVP

1. Add the canonical anchor and three obligations to `we:docs/agent/backlog-workflow.md`.
2. Add the canonical link and concise obligation summaries to both scoped briefs, preserving their current authority sentences and executable-acceptance directives. Resolve the apparent fail-closed tension by distinguishing preparation evidence refusal from changing an accepted runtime default.
3. Add the named contract tests in Acceptance, with negative mutations for absent obligations and absent evidence sources, in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`. Keep helpers local to that test file; no production validator or new dependency.
4. Exclude runtime counting, run-store schema, owner-field invention, `kind` validation changes, and any new runtime default. Both preparation entry points are the callers changed by this MVP.

## Acceptance

All test names below are planned additions to `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`. Each must fail against the current unmodified guidance and pass after implementation; negative mutations run in memory or through injected reads, never by deleting repository files.

- [A1] Executable: `requires ownership evidence and owner/non-owner reader fixtures in all three sources` — checks the actor-field/value/reader/writer obligations, explicit no-field provenance alternative, and the non-owner boundary fixture in the canonical section and each brief; removing any obligation must be detected.
- [A2] Executable: `requires failure defaults, caller and historical-state coverage in all three sources` — checks unavailable/corrupt/missing/aged-out cases, named tests, cap effect, omitted-versus-empty distinction, caller and old-record review for changed defaults, and operator recovery for a proposed refusal; each omitted clause is rejected.
- [A3] Executable: `both entry points invoke the canonical checklist without choosing runtime policy` — checks the anchor links, applicability qualification, accepted-default preservation, escalation of unresolved ownership/policy gaps, and the agent cross-reference to classes 4 and 7. Existing authority and stop-boundary cases remain required alongside this new test.
- [A4] Executable: `checklist contract rejects missing, unreadable, empty or incomplete evidence` — first validates the actual three sources (red today); then exercises missing/unreadable document reads and missing anchor, empty section, and each removed obligation through the same assertion helper, expecting failure rather than skip or empty-string fallback. Report the source and absent obligation in assertion diagnostics.

## Test plan

Implement A1–A4 first in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`, retaining the existing parameterized worker/agent tests and frontmatter allow-list cases. The real-source assertions supply the before-build failures; mutations prove that the newly introduced checks reject incomplete evidence even after the source text is compliant. Do not count a negative-helper test that already passes before the build as the only red/green evidence.

Supplement the automated instruction contract with three recorded sample reviews using the resulting text: (1) “builder's own store” without writer evidence and without a non-owner fixture must surface both omissions; (2) an omitted-input test offered as read-error coverage must surface the missing failure expectation; (3) a complete field/reader/writer/owner/non-owner design with an accepted fail-open default must not demand a policy change. Also confirm an irrelevant card can state non-applicability. These reviews assess semantic usefulness; they are not a claim of deterministic LLM behavior.

## Proof plan

The builder runs only the scoped contract suite through the host heavy queue: `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`. Repository prefixes identify paths in this card; strip `we:` from command arguments when executing in WE. Capture the new real-source failures before guidance edits, then the passing suite with both caller variants after edits. Capture mutation-test results for A4 and the three sample-review outcomes.

Run the required standards check through the same queue: `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards`. If occupied, wait once using the queue's supported bounded wait option, then stop and report if still unavailable. Inspect the final diff for prefixed references, unchanged runtime defaults, preserved caller authority and no new schema requirement. This card-only preparation leaves runner-owned checks and stamping to the runner; no tests are claimed as executed here.

## Edge cases this change must handle

1. **Untrusted text:** static documentation and local test fixtures only; no external text enters shell execution.
2. **Truncated reads:** complete local UTF-8 reads; missing/unreadable files throw, and section extraction refuses a missing anchor or empty section (A4).
3. **Shared state:** no state mutations; test mutations remain in memory or injected reads.
4. **Fail closed:** absent preparation evidence fails the contract with a source-specific diagnostic (A4). Runtime fail-open policy is not silently overridden (A3).
5. **Identity scoping:** the checklist requires evidence distinguishing writers at the reader boundary (A1); no new runtime identity key is introduced.
6. **State over time:** require old-record and caller coverage when a default changes (A2); anchor assertions on semantic clauses rather than line numbers.
7. **Who wrote it:** field/value/filter/writer evidence and a non-owner record are mandatory for applicable claims (A1). Unsupported provenance is escalated (A3).

## Follow-ups

- A dedicated semantic review lens could later apply this checklist automatically; keyword assertions cannot certify an ownership claim.
- A changed builder failure policy or explicit owner field requires separately authorized work. Preserve #4494's existing fail-closed follow-up; this card only requires authors to expose such choices.
- No obsolete `workItem` guard: the current `kind` validation already provides schema protection.
