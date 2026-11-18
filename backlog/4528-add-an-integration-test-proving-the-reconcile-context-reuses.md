---
bornAs: xejvuqt
kind: task
parent: "4108"
status: open
blockedBy: ["4108"]
scope: ["we:scripts/__tests__/merge-ai-prs-reconcile-carrier-visibility.test.mjs"]
estimatedLoc: 160
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "e2bed0a8c3b86ff61617d318f55efeda18ff5b21"
tags: []
---

# Add an integration test proving the RECONCILE context reuses the #4108 candidate listing's raw, base- and label-UNFILTERED rows

Prove that the raw listing reused by RECONCILE preserves a manifest-carrying carrier excluded from merge candidates, and that its coupled implementation inherits the real carrier health rather than becoming an orphan. The missing coverage is the composition of listing reuse, context collection, and the couple gate; production already implements these pieces.

## Design

Add `we:scripts/__tests__/merge-ai-prs-reconcile-carrier-visibility.test.mjs` as a hermetic integration test of exported production functions. Drive `buildLiveListingsByRepo` → `collectOpenPrContext` → `buildCarrierHealth` → `joinImplToCouples`, all from `we:scripts/merge-ai-prs.mjs`. Supply `contextProvesAbsence(ctx)` and the collected truncation flag to the join; do not reproduce completeness logic in the fixture.

Build raw carrier and impl rows with distinct PR numbers and matching manifest refs. Represent the carrier's `we:.lane-manifest.json` read through injected `fetchReads`, keyed by the production repo/PR key. Derive reads only for the rows actually passed to `fetchReads`, so an accidentally filtered carrier cannot survive through a fabricated side channel. Return a valid item and two repo refs for the carrier, and no manifest for the impl. Start the impl verdict as mergeable with no inherited item or couple identity.

Derive candidate `prs` with `filterOpenPrsByLabel` from `we:scripts/lib/no-search-backed-pr-list.mjs` and `filterOpenPrsByBase` from `we:scripts/merge-ai-prs.mjs`; retain original `rows` in each listing. Feed the actual reuse map into the collector's injected listing reader. Assert the carrier is absent from candidates but present in `prsByRepo`, `openItems`, and the resulting health index. Assert the impl joins the manifest item and names the carrier PR before checking deferral.

Exercise exclusions independently: (1) carrier on `develop`, selected base `main`, with `ready-to-merge` and `review:pending`; (2) carrier on `main`, lacking `ready-to-merge` but retaining `review:pending`. Here “unlabelled” means absent selection label, not absent review hold. A third case uses literally empty labels and a degraded read retaining the manifest, demonstrating the fail-closed path without pretending that no labels alone implies a hold. A healthy filtered carrier control must join with reason `healthy` and no deferral.

No production API, default, caller, or policy changes are required. The production reuse caller is `we:scripts/merge-ai-prs.mjs:5303`, with its early return at line 5314; the map is built at line 5788. These are research references, not implementation touch files.

## MVP

Must: one new test file covering separate base and selection-label exclusions, explicit carrier identity and open-item visibility, held deferral, degraded-read deferral, and a healthy joined control. Use production filtering, map construction, collection, health derivation, and joining. No network, CLI subprocess, or real GitHub calls are needed.

Could: a full fake-CLI test asserting the final drain plan and call budget. Existing CLI listing tests already cover candidate selection and list counts; extending that harness is outside this minimum integration seam.

## Acceptance

Each executable below is in the planned `we:scripts/__tests__/merge-ai-prs-reconcile-carrier-visibility.test.mjs`. Run the named test through the command in Test plan with its `-t` name. Before the new file exists each selection fails with no test files; after implementation each must pass. This is test-coverage delivery, not a claim that production currently fails.

- [A1] Executable — `cross-base held carrier survives reuse`: with only base excluding the carrier, assert candidate exclusion, context row and item presence, joined carrier identity, `coupleDefer === true`, and reason `held`.
- [A2] Executable — `selection-label-excluded held carrier survives reuse`: with only the ready label excluding the carrier, assert the same visibility, identity, and held deferral guarantees.
- [A3] Executable — `unlabelled degraded carrier fails closed after reuse`: with empty labels and a manifest-bearing degraded read, assert carrier visibility, incomplete context, joined identity, and deferral reason `degraded`.
- [A4] Executable — `healthy filtered carrier remains joined without deferral`: remove the hold from a cross-base fixture and assert context visibility, joined identity, `coupleDefer === false`, and reason `healthy`. Filtering alone must not invent a hold.

## Test plan

Use the host heavy queue for the new file. Repository prefixes below denote locus; strip `we:` from command arguments when executing from the WE checkout:

`node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/__tests__/merge-ai-prs-reconcile-carrier-visibility.test.mjs`

Use `-t 'cross-base held carrier survives reuse'` (and the other exact Acceptance names) for individual guarantees. Never use `--passWithNoTests`. Keep fixtures explicit and small; no shared fixture refactor or existing assertion weakening. The builder should run the new file and the adjacent `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs` through the queue. If busy, use the single bounded admission wait and report inability to run rather than polling.

## Proof plan

Record the new-file command's nonzero missing-file baseline before adding the test, then its passing result after implementation. Demonstrate regression sensitivity with a temporary local mutation of the reuse mapping in `we:scripts/merge-ai-prs.mjs:2524` from raw `rows` to candidate `prs`: the visibility and joined-identity assertions must fail. Restore that mutation immediately; it is not part of the delivered touch set. Re-run the new file green after restoration. A passing healthy control distinguishes real carrier health from a blanket defer.

The runner owns preparation stamping and checks. Preparation itself adds no test and makes no runtime-pass claim. Builder evidence must report commands and observed outcomes, including any queue refusal.

## Follow-ups

Optional full-CLI coverage may reuse the fake-GitHub harness in `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:39`. It is not required to close this exported-function integration gap. No unresolved policy fork or production behavior change is needed.

## Progress

- Original premise: #4108 tests only checked call counts and candidate filtering, and any filtered carrier should cause impl deferral. Corrected premise: `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:105` already tests raw map preservation, and its collector tests at line 68 cover truncation. What remains missing is their composition with manifest visibility and the couple join.
- Health correction: `we:scripts/merge-ai-prs.mjs:1719` explicitly permits a healthy filtered carrier; `we:scripts/merge-ai-prs.mjs:2063` derives carrier health from context, including review holds and degraded reads. Existing healthy-couple coverage at `we:scripts/__tests__/merge-ai-prs-couple-join-and-drain-verdicts.test.mjs:117` reinforces that filtering alone is not a hold. The new held/degraded fixtures preserve the original no-orphan goal without changing policy.
- Source evidence: `we:scripts/merge-ai-prs.mjs:2523` maps raw rows; `we:scripts/merge-ai-prs.mjs:2210` collects injected listings; `we:scripts/merge-ai-prs.mjs:2124` reduces their manifests into context; `we:scripts/merge-ai-prs.mjs:2170` applies the absence-proof rule. Existing couple tests do not import the reuse-map builder, so separate unit coverage does not deliver this composition.
- Original scope was only `we:scripts/merge-ai-prs.mjs`, with no test path or estimate. Corrected scope is the single planned test file; production requires no edit. Estimate: one test file × approximately 160 changed lines (imports/fixtures about 70, shared integration driver about 40, four cases/assertions about 50), hence `estimatedLoc: 160`. No size existed or was added because this is a task.
- #4108 is resolved in its current card. Preserve the existing blocker pending independent confirmation; propose its removal below. No preparation stamp authored.

## Proposed blockedBy changes

- remove 4108 — prerequisite is resolved and raw-row reuse is present (we:scripts/merge-ai-prs.mjs:2523).
