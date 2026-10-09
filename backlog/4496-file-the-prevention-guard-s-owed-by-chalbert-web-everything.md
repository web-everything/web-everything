---
bornAs: xv21yh3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/backlog-workflow.md", "we:skills-src/conveyor/prepare-item-worker-brief.md", "we:skills-src/conveyor/prepare-item-agent-brief.md", "we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "8ae482c6090044de9bc190a88c6bfaa96bb7e317"
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

## Design

Add a named attribution-and-failure-default checklist to the build-item preparation guidance in `we:docs/agent/backlog-workflow.md` (new paragraph after the #3108 story-kind paragraph). Both probation briefs must invoke the same checklist explicitly, since the worker brief declares itself the entire task.

For a design attributing X to actor Y through store Z, require the concrete persisted field, accepted value, reader/filter, and writer evidence that distinguish Y from other writers. If no actor field exists, say so explicitly and substantiate any exclusive-producer assumption; a store name or run-ID prefix alone is not proof of actor ownership. Require a fixture containing a non-Y record that reaches the relevant reader boundary, alongside the Y record, with expected inclusion/exclusion. If the current representation cannot distinguish them, expose that gap for a decision rather than inventing a discriminator.

For a cap or guard narrowed by a new data source, require the behavior for unavailable, corrupt, and missing/aged-out records, its effect on the cap, and a matching test. Distinguish an omitted optional argument from a read that failed and returned an empty collection. Record an already accepted default faithfully; an unresolved change of policy remains a judgment call.

This is a semantic author/reviewer checklist. A deterministic text check can ensure the briefs retain the instruction, but cannot certify that a claimed discriminator or failure policy is correct.

## MVP

1. Add the checklist as a new paragraph right after the #3108 story-kind paragraph in `we:docs/agent/backlog-workflow.md` (not a decision-prep "Definition of Ready" heading), with #4494 as a worked caution: producer provenance is not an actor field, and empty-on-error differs from omitted-input fallback.
2. Add concise instructions to both scoped probation briefs to apply the checklist when relevant, citing the canonical guidance and retaining the existing no-policy-choice stop boundary.
3. Extend `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` to read the canonical checklist and read the canonical doc (a new `readFileSync`) and verify both brief variants require ownership/writer evidence, a non-owner fixture, and explicit failure-default evidence. Preserve existing authorization and stop-boundary assertions.
4. Do not modify builder counting, run-store schema, the accepted fail-open default, or backlog kind validation.

## Test plan

- In `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs`, add contract cases for both briefs and the canonical guidance. Removing any one of the three obligations must fail the corresponding case; use targeted assertions rather than full-document snapshots.
- Review a deficient sample design that says only “the builder's own store”: it must be returned for a concrete discriminator or supported producer provenance and a non-owner record fixture.
- Review a sample where an optional attribution argument is omitted versus a reader returning an empty set after an error: the checklist must demand separate expectations, not treat the compatibility fallback as read-failure coverage.
- Review a complete sample with a named ownership field, owner/non-owner records, and an accepted failure default: it should satisfy the checklist without forcing fail-closed policy. An irrelevant card needs no attribution machinery.
- The scoped contract test file covers both brief source entries and the canonical documentation entry. Existing runtime tests cited in Progress are supporting evidence, not planned edit targets.

## Proof plan

- During implementation, add the contract cases first and run `npx vitest run we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` (strip the repository prefix when executing from WE). Capture the missing-instruction failures, then the passing result after updating guidance and briefs.
- Perform the three sample reviews above using the actual resulting brief text; record the missing evidence or satisfied obligations in the PR body. A green text-contract test alone does not prove semantic review quality.
- Run `npm run check:standards` and inspect the diff for repository-prefixed references and unchanged worker authority/stop boundaries. This preparation pass leaves execution of these implementation checks to the runner and eventual builder.

## Edge cases this change must handle

1. **Untrusted text** — n/a: the change adds static guidance text and contract assertions; no card/PR/LLM text reaches a shell, argv or regex (tests read repo files only).
2. **Truncated reads** — n/a: tests read three local files with `readFileSync`; no `gh`/`git` read.
3. **Shared state files** — n/a: no state file is written.
4. **Fail closed** — the contract test must throw (not skip) if a brief or the canonical doc is missing or the checklist anchor is not found; a missing file is never an empty string that passes a negative assertion.
5. **Identity scoping** — n/a: no keys; the checklist itself tells authors to name the persisted actor field (the guidance subject, not a runtime key).
6. **State over time** — assertions are anchored to stable phrases, not line numbers, so later edits to the briefs (they changed three times since the last stamp) don't break them spuriously.
7. **Who wrote it** — the checklist text itself requires writer evidence for ownership claims; the test asserts that obligation is present in all three files.

## Follow-ups

- A dedicated review lens may automate applying the semantic checklist later; no keyword-based claim of attribution correctness belongs in this MVP.
- Changing builder failure policy or introducing an explicit owner field requires separate evidence and a separately authorized decision. The existing #4494 Follow-ups retain the fail-closed proposal.
- Do not resurrect the obsolete `workItem` guard; current `kind` validation is the applicable schema protection.

## Done when

1. The targeted brief-contract tests fail without the new instructions and pass with them.
2. Both preparation entry points carry the checklist, and sample reviews demonstrate the attribution and failure-default omissions are surfaced without choosing a new runtime policy.
