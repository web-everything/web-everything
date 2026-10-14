---
bornAs: xp1cr0h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/queue-prune.mjs", "we:scripts/conveyor/queue.mjs", "we:scripts/conveyor/__tests__/queue-prune.test.mjs", "we:scripts/conveyor/__tests__/queue.test.mjs"]
dateOpened: "2026-10-06"
preparedDate: "2026-10-14"
preparedAgainstSha: "98e95aa8d5faa22152db44554d0363911c16339a"
tags: []
---

# Prevention — Delete the receipt after a successful apply, or reject it when at is older than a few minutes. Ad… (from web-everything/web-everything#4077 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/queue-prune.mjs:205-217` — Delete the receipt after a successful apply, or reject it when `at` is older than a few minutes. Add a CLI test that applies twice, re-adds the ids, and expects the second apply to be refused.
2. `we:scripts/conveyor/queue.mjs` — A deterministic `import/no-unresolved` lint rule to verify module resolution at build time.
3. `we:scripts/conveyor/queue.mjs` — Strict coverage thresholds or TDD enforcement for documented failure paths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4077@379c6cc19ef5babe9f13c10dd0a65e541ebf8eb1

## Progress

Preparation inspection: the original scope named both queue modules and both existing test suites; the original premise bundled receipt replay prevention, unresolved-import lint, and coverage/TDD enforcement. The receipt defect remains: we:scripts/conveyor/queue-prune.mjs:205-217 hashes the drop class and sorted IDs, writes an `at` value, and checks only the digest. The prior preparation cited lines 204-215 and 208-215; the receipt functions now extend through line 217, with validation at lines 214-216; the corrected locus is we:scripts/conveyor/queue-prune.mjs:205-217. The apply branch at we:scripts/conveyor/queue.mjs:261-270 never consumes the receipt. Re-adding the same IDs restores the same digest.

Corrected delivery scope: retain the four declared paths, with receipt lifecycle unit and CLI regressions in we:scripts/conveyor/__tests__/queue-prune.test.mjs and CLI import/roundtrip regression coverage in we:scripts/conveyor/__tests__/queue.test.mjs. The existing bulk CLI case at we:scripts/conveyor/__tests__/queue-prune.test.mjs:213-222 stops after the first successful apply; it does not test replay. These are existing files, not missing suites. No source relocation is needed. The prior draft proposed adding a startup/list smoke test, but we:scripts/conveyor/__tests__/queue.test.mjs:23-28 already runs the real CLI and we:scripts/conveyor/__tests__/queue.test.mjs:71-74 already parses an empty-list response. Correct that narrower test scope to strengthening the existing case with explicit success/action assertions, rather than adding a duplicate smoke test. The four-file scope and size 3 remain unchanged; both source entries retain matching test entries in scope.

The broader guard requests remain follow-ups below: we:package.json:28-45 exposes Vitest commands rather than an ESLint build gate, and we:vitest.config.ts:56-70 explicitly distinguishes tooling from the standards coverage planes (with a trust-chain exception); its thresholds already specify 80 at we:vitest.config.ts:116-121. A new repository-wide lint or coverage policy is not a prerequisite for the receipt regression.

Retain size 3: approximately 15 changed lines in we:scripts/conveyor/queue-prune.mjs for receipt cleanup, 15 in we:scripts/conveyor/queue.mjs for lifecycle integration/error handling, 90 in we:scripts/conveyor/__tests__/queue-prune.test.mjs for helper and CLI cases, and 10 in we:scripts/conveyor/__tests__/queue.test.mjs to strengthen existing CLI startup assertions (about 130 total). This is an estimate, not an implementation diff. Preparation is based on source inspection; no runtime reproduction or test pass is claimed. The runner owns checks and stamping.

## Design

Use the explicitly requested deletion alternative: a completed bulk apply consumes its dry-run receipt. A timeout alone cannot reject an immediate second apply after IDs are re-added, so it does not satisfy the named regression without consumption.

Add a receipt-removal helper beside the existing receipt functions in we:scripts/conveyor/queue-prune.mjs. In the bulk-removal branch of we:scripts/conveyor/queue.mjs, retain protection loading, plan computation, and digest validation. After successful queue persistence, delete the receipt before reporting success. A validated zero-drop apply also consumes its receipt. Dry-runs continue to write receipts without mutating the queue. Ordinary remove, automatic prune, and the shared applyPlan function keep their current semantics.

Implement cleanup with unlink semantics: ignore only ENOENT, never recursively remove a receipt path. Missing receipt cleanup is harmless; other filesystem errors must produce a nonzero result and an explicit cleanup diagnostic, never a successful apply response. If persistence already succeeded, the diagnostic must say so rather than imply rollback. A queue-write failure must not be presented as successful receipt consumption. Keep the existing receipt format and digest rules; no age threshold is introduced.

This establishes sequential replay prevention, not atomic cross-process exclusion or crash recovery between queue persistence and receipt deletion. Those require a separate transaction design and are not implied by this change.

## MVP

- **Must:** after a successful dry-run/apply, the receipt is absent. Re-add the removed IDs and retry the same apply without another dry-run: refuse with nonzero exit and leave the queue byte-for-byte unchanged.
- **Must:** a new dry-run permits the new apply; protected IDs and unrelated rows survive throughout.
- **Must:** missing, malformed, or mismatched receipts still refuse before queue mutation; receipt cleanup errors never report success. Successful zero-drop applies consume receipts too.
- **Must:** preserve the CLI entry point's module-resolution smoke coverage and add concrete regression assertions for the documented failure paths.
- **Could:** add repository-wide unresolved-import lint and expanded coverage policy as the separately scoped follow-ups below. They are not silently considered delivered by a passing CLI test.

## Test plan

In we:scripts/conveyor/__tests__/queue-prune.test.mjs, extend the temporary-sidecar harness at we:scripts/conveyor/__tests__/queue-prune.test.mjs:179-192, capturing stderr as well as stdout and disabling both readiness and kind checks for re-add operations. Exercise dry-run → apply → re-add via the CLI → identical apply refusal → fresh dry-run → successful apply. Assert receipt existence after dry-run, absence after success, nonzero refusal, unchanged queue bytes on refusal, and retained protected/unrelated IDs. Avoid real operator queue state and remote reads by retaining the existing protection override.

Add receipt helper tests for missing, malformed, and mismatched receipt contents, successful deletion, harmless missing cleanup, and propagated non-ENOENT errors using deterministic filesystem mocks. Add zero-drop consumption and queue-write/cleanup failure tests; assert no success result on either failure and no misleading rollback claim. For deterministic CLI failure injection, launch a temporary Node module from the existing test harness that patches the targeted node:fs synchronous operation, calls syncBuiltinESMExports, sets process.argv to the CLI invocation, then dynamically imports we:scripts/conveyor/queue.mjs. Throw only for the exact temporary queue or receipt path. Queue persistence uses write-then-rename at we:scripts/conveyor/queue-store.mjs:320-324: inject rename failure to prove the original queue and receipt survive. Inject receipt unlink failure after persistence to prove the queue changed, the receipt remains, exit is nonzero, and the diagnostic explicitly reports persistence succeeded but cleanup failed. This uses test-owned temporary fixtures, not a production failure switch or a change to the queue store. Do not use timing sleeps or permission-bit failures that vary under elevated users.

In we:scripts/conveyor/__tests__/queue.test.mjs, strengthen the existing isolated empty-list case at we:scripts/conveyor/__tests__/queue.test.mjs:71-74 with ok:true and action:list assertions; its subprocess helper already throws on startup failure. Existing add/remove/list roundtrips remain regression coverage; this runtime import check supplements rather than replaces the requested future static lint.

## Proof plan

The implementing worker first adds the replay regression and runs it against the unchanged implementation through the host heavy-run queue. Capture the expected failure: the second apply succeeds and removes re-added IDs instead of refusing. After implementation, run both scoped suites through that same queue and capture the passing replay case and refusal assertions. Run the standards gate through admission as well. Use we:scripts/readiness/heavy-admission.mjs with its `run --` arguments to invoke `npx vitest run` for we:scripts/conveyor/__tests__/queue-prune.test.mjs and we:scripts/conveyor/__tests__/queue.test.mjs together, then invoke `npm run check:standards` through the same admission entry point. Resolve these repository-prefixed loci relative to the WE checkout when constructing shell arguments. Record exit codes and the replay assertion output; an unrelated gate failure must be reported separately rather than called a passing proof.

## Done when

The replay regression demonstrably fails before the fix and passes after it; receipt lifecycle/error cases and both scoped CLI suites pass, and the standards gate passes. A successful apply cannot authorize a later sequential removal through the same retained receipt. Static lint and global coverage policy remain explicitly outstanding follow-ups.

## Follow-ups

The requests below remain outstanding and are not filed separately by this preparation; no follow-up delivery is claimed.

- Preserve the original deterministic unresolved-import lint request: separately scope the build-gate configuration and its negative fixture (a deliberately broken relative import must fail). The CLI smoke test here proves runtime loading only. Do not introduce a new lint toolchain implicitly in this receipt fix.
- Preserve the original strict-coverage/TDD request: separately establish which tooling files and failure branches should be instrumented against the existing coverage-plane rules in we:vitest.config.ts:56-70, then add a gate regression that demonstrates enforcement. No new percentage or TDD policy is selected here.
- Concurrent applies and crashes between persistence and deletion need transactional receipt consumption if that stronger guarantee is required; this card promises sequential replay prevention only.
