---
bornAs: xv21yh3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/backlog-workflow.md", "we:skills-src/conveyor/prepare-item-worker-brief.md", "we:skills-src/conveyor/prepare-item-agent-brief.md", "we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "8bdc1a1b971bb29f2725c31c27fd5792d1682556"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2953's independent review

The independent approval review of chalbert/web-everything#2953 left prevention debt: attribution designs must identify their ownership evidence and test another writer; caps narrowed by a new data source must state and test their failure default. Add those checks to card authoring and prepare-first guidance. The original request to require `workItem` is obsolete under the current `kind` schema.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2953@73d12a3ecb338987d84642f80b65091118fdbc8f

## Progress

- **Original premise/scope:** only `we:backlog/4494-builder-open-items-limit-counts-only-the-builder-s-own-items.md` was scoped. The approval cited its old lines 27/32 for missing ownership evidence and read-failure handling, and line 2 for a supposedly invalid `kind` field. It requested a checklist/lens plus a `workItem` presence gate.
- **Corrected premise:** #4494 is resolved. Its Prepare verification, Design, and Follow-ups already describe the run-store mechanism and accepted fail-open behavior; its old line citations no longer identify the missing work. `we:skills-src/conveyor/build-dispatch-daemon.mjs`'s `deriveDispatchedByBuilder` unions item numbers from two readers. `cliListRunStoreInFlight` and `cliListSettledBuilds` filter build effects from records supplied by `readDispatchLaneRunRecords`, which selects run IDs starting with `dispatch-lane` and degrades on listing/read errors. This is a provenance claim about the selected producer path, not an explicit actor-ID comparison. The `dispatch.executor` field identifies provider, not builder ownership; do not substitute it as an ownership discriminator.
- **Existing coverage:** `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` already exercises both real readers with a run-store path that is a file, expecting empty results. `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs` covers worker PR exclusion, builder inclusion, deduplication, unchanged other caps, and the omitted-attribution-input fallback. These are evidence for the documented behavior, not proof that every possible store writer is builder-owned.
- **Schema correction:** `we:scripts/check-standards-rules.mjs`'s `validateBacklogItem` already requires `kind` and validates it against `BACKLOG_KINDS`; `we:scripts/backlog/migrate-kind.mjs` explicitly migrates away from `type`/`workItem`. Requiring `workItem` or rejecting `kind` would reverse the current schema. No schema change is owed here.
- **Corrected scope:** the remaining deliverable is reusable authoring/prepare guidance in `we:docs/agent/backlog-workflow.md` and both current probation briefs, `we:skills-src/conveyor/prepare-item-worker-brief.md` and `we:skills-src/conveyor/prepare-item-agent-brief.md`. Their matching existing test home is `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`; extend it to cover the shared guidance contract. Runtime files and the resolved #4494 card are evidence only. This preserves the prevention goal without changing the accepted failure policy.

- **Re-prepare 2026-10-09 (stale stamp):** the prior stamp (`c6e39f4de`) predates edits to `we:skills-src/conveyor/prepare-item-agent-brief.md` (now six sections incl. a required `## Edge cases this change must handle`, plus a commit-first gate flow), `we:skills-src/conveyor/prepare-item-worker-brief.md` (`size:` / `## Proposed blockedBy changes` paragraph), and `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` (new #4670 case). Premise re-checked on `main`: no attribution/failure-default checklist exists in any of the four scoped files, so the goal is undelivered. Goal and scope unchanged. Insertion point in `we:docs/agent/backlog-workflow.md`: directly after the "Story-kind extension — `preparedDate` + `preparedAgainstSha` (#3108)" paragraph (now line 627), which is where story/task preparation readiness is defined; there is no separate "build-item Definition of Ready" heading, so the new checklist is a sibling paragraph there. The agent brief's Edge-cases class 4 (fail closed) and class 7 (who wrote it) overlap the new checklist; the checklist must cross-reference them rather than restate them. Preserve the existing `Only edit that card's body…` worker-brief sentence unchanged; add the checklist instruction separately.

- **Re-prepare 2026-11-18 — old versus current premise:** the previous preparation put prefix filtering and read-error catches inside both runtime readers. They now delegate to `readDispatchLaneRunRecords` at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1760`: list failure returns an empty array and individual read failures skip records; the two consumers at lines 1773 and 1811 accept a shared `records` input. The live tick and dry-run callers at lines 2953 and 3103 share that read. The attribution union at line 285 and documented accepted fail-open direction at line 278 remain evidence, not edit targets. This correction does not certify the comment's exclusive-producer claim: the new checklist must demand writer evidence when such a claim is used.
- **Undelivered prevention / unchanged scope:** the story preparation paragraph is now `we:docs/agent/backlog-workflow.md:627`. Neither it nor the two brief entry points contains the proposed attribution-and-failure-default checklist. `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs:16` covers both briefs' authority and stop boundaries, but has no canonical-doc reader or ownership/failure-default assertions. Keep the same four-file scope. The agent brief's existing edge classes 4 and 7 at `we:skills-src/conveyor/prepare-item-agent-brief.md:60` overlap the subject but do not demand the non-owner fixture or distinguish omitted input from an empty error result.
- **Schema and policy evidence:** `we:scripts/check-standards-rules.mjs:505` requires `kind`; `we:scripts/backlog/migrate-kind.mjs:5` documents removal of `workItem`. `we:scripts/conveyor/__tests__/build-dispatch-policy.test.mjs:335` exercises excluded worker records; line 391 pins omitted-input compatibility. These observations support guidance-only work, not a new ownership field or runtime default.
- **Sizing:** retain size 3 (old 3 → new 3). Expected touch set: canonical checklist about 25–35 lines at `we:docs/agent/backlog-workflow.md:627`, two brief invocations about 8–12 lines each near `we:skills-src/conveyor/prepare-item-worker-brief.md:8` and `we:skills-src/conveyor/prepare-item-agent-brief.md:47`, and about 60–90 lines of contract cases beside `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs:16`. This is a story; no `estimatedLoc` is added. Stamps remain runner-owned.

## Design

Add a named **Attribution and failure defaults** checklist with stable anchor `attribution-and-failure-defaults` immediately after the story-kind preparation paragraph at `we:docs/agent/backlog-workflow.md:627`. This is a semantic preparation requirement backed by a text contract, not an automated proof of ownership correctness.

When a design attributes records to an actor, require the persisted field and accepted value, reader/filter, and writer evidence. When no actor field exists, explicitly say so and substantiate any exclusive-producer assumption. A store name, provider field, or run-ID prefix alone is insufficient. Require owner and non-owner fixtures reaching the actual reader boundary with expected inclusion/exclusion. If the representation cannot distinguish writers, expose the gap and stop for the unresolved decision rather than inventing a discriminator.

When a new source narrows a cap or guard, require separate expectations for unavailable, corrupt, missing, and aged-out data, their effect on the cap, and named tests. Distinguish an omitted optional input from a failed read returning an empty collection. Preserve already accepted defaults with evidence; an unresolved policy choice remains `could-not-prepare`. Require authors to trace changed defaults through callers, existing tests, and persisted old records where relevant. The worked caution is #4494: producer provenance is not an actor field, and empty-on-error differs from omitted-input fallback.

Both `we:skills-src/conveyor/prepare-item-worker-brief.md` and `we:skills-src/conveyor/prepare-item-agent-brief.md` must explicitly invoke `we:docs/agent/backlog-workflow.md#attribution-and-failure-defaults` and summarize the ownership evidence, non-owner fixture, and failure-default obligations. The worker brief is a standalone task, so a bare link is insufficient. Cross-reference agent edge classes 4 and 7; clarify that documenting an already accepted runtime default does not authorize changing it. Preserve each entry point's existing authority and stop boundaries.

Extend the existing test module's local text-reading approach in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs:12`. Read the canonical doc relative to the module location, extract the named checklist, and assert positive obligations in that section and both briefs. Missing/unreadable files must throw; a missing anchor or empty section must fail explicitly. Avoid negative-only checks that could accept missing content. Keep any extraction/assertion helpers local to this test file.

## MVP

1. Add the canonical checklist, #4494 caution, changed-default tracing requirement, and accepted-policy boundary to `we:docs/agent/backlog-workflow.md`.
2. Wire both scoped briefs to that anchor with the standalone obligation summaries. Preserve the worker's permitted-frontmatter sentence and both briefs' factual-correction and unresolved-fork exits.
3. Extend `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` with the named Acceptance cases, parameterized across the canonical section and both brief texts where applicable. Retain all current contract cases.
4. Keep runtime counting, run-store schema, backlog schema, and accepted fail-open behavior outside the touch set. No model-based review harness or new runtime checker is required.

## Acceptance

All test names below are proposed cases in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`, run through the queued command in Proof plan. Each case must fail against the current guidance and pass after implementation; removal mutations must then demonstrate sensitivity to its named obligation.

- [A1] Executable — `requires ownership discriminator and writer evidence`: asserts field/value, reader/filter, writer evidence, explicit absent-field handling, and the insufficient-prefix warning in the canonical checklist and both brief summaries. Also asserts that unresolved attribution is escalated rather than guessed.
- [A2] Executable — `requires owner and non-owner reader-boundary fixtures`: asserts both record classes, the actual reader boundary, and inclusion/exclusion expectations in all three texts.
- [A3] Executable — `requires failure defaults and follows changed-default callers`: asserts unavailable/corrupt/missing/aged-out cases, effect on the cap, named test evidence, omitted-versus-empty distinction, and caller/test/old-record tracing. Briefs must explicitly require these obligations via their summary and the canonical anchor.
- [A4] Executable — `preserves accepted defaults and escalates unresolved policy`: asserts the new checklist and both invocations require evidence for accepted behavior and escalation for unresolved changes, without mandating a change to #4494's runtime default. Run existing already-done, genuine-judgment-fork, and worker frontmatter allow-list cases alongside it.
- [A5] Executable — `requires canonical checklist wiring and rejects incomplete guidance`: loads all three real sources, verifies both exact anchor references and a nonempty canonical section, and exercises missing/unreadable input, absent anchor, empty section, and each removed obligation through local assertion helpers. Fail rather than skip or substitute empty strings. The real-source assertions make this case red before the checklist exists; the negative fixtures prove the closed paths afterward.

## Test plan

Implement A1–A5 first in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`. Assert separate obligations rather than matching a full paragraph snapshot. Parameterize source coverage so one brief cannot silently lose its requirement while the canonical doc remains green. For A5, use an injected reader that throws for missing/unreadable inputs and in-memory mutations for absent anchor, empty section, and removed obligation; do not mutate repository files during tests. Check each rejected fixture's diagnostic identifies the missing source or obligation.

Perform semantic sample reviews in addition to executable text checks: (1) “the builder's own store” without discriminator/writer evidence or a non-owner fixture must be returned for evidence; (2) omitted attribution input versus empty-on-error must receive separate expected counts; (3) a complete design with owner/non-owner records and an evidenced accepted default should satisfy the checklist; (4) an unrelated card should not acquire attribution machinery. Record outcomes as manual review evidence, not as automated semantic guarantees.

## Proof plan

Use the host heavy-run queue for implementation verification. In the following command template, strip `we:` from both path arguments when executing from the WE root: `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`. Capture A1–A5 failing on the old guidance, then passing after the three text edits, with all existing cases still green. If admission is busy, use this single bounded wait and stop/report on timeout; do not poll.

Show the actual canonical section and both brief invocations in the implementation review, and record all four semantic sample outcomes. Review the diff for unchanged authority and policy boundaries. Text-contract success demonstrates retained instructions, not semantic correctness of a future attribution claim.

The runner owns checks and stamping for this card-only preparation. During implementation, run the required standards gate through the queue as well: `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards` (strip the repository prefix from the script path to execute). No runtime test suite is needed for this guidance-only touch set.

## Edge cases this change must handle

1. **Untrusted text** — static guidance only; tests read repo sources and local fixture strings, with no model text passed to shell or dynamic regex.
2. **Truncated reads** — local full-file reads; no network or paginated CLI input.
3. **Shared state files** — no state writes; mutation fixtures remain in memory.
4. **Fail closed** — A5 rejects unavailable source text, absent anchor, empty section, and deleted obligations; accepted runtime failure defaults remain a separately evidenced subject of the checklist.
5. **Identity scoping** — the checklist demands ownership evidence and explicit gaps; no new runtime identity key is introduced.
6. **State over time** — A3 requires old-record/default compatibility analysis where applicable; text tests use stable obligations and anchors rather than line numbers.
7. **Who wrote it** — A1 and A2 pin the writer evidence and non-owner fixture requirements across both entry points and canonical guidance.

## Follow-ups

- A dedicated semantic review lens could apply this checklist automatically; this MVP does not claim keyword tests prove attribution correctness.
- An explicit runtime owner field or changed builder failure policy needs separate evidence and authorization; retain #4494's follow-up rather than deciding it here.
- Do not resurrect the obsolete `workItem` presence guard; current `kind` validation remains the schema protection.
