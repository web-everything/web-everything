---
bornAs: xp1cr0h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/queue-prune.mjs", "we:scripts/conveyor/queue.mjs", "we:scripts/conveyor/__tests__/queue-prune.test.mjs", "we:scripts/conveyor/__tests__/queue.test.mjs"]
dateOpened: "2026-10-06"
preparedDate: "2026-10-14"
preparedAgainstSha: "26105d8adb52d1d310d5e0109933a1a80b6a5c59"
tags: []
---

# Prevention — Delete the receipt after a successful apply, or reject it when at is older than a few minutes. Ad… (from web-everything/web-everything#4077 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/queue-prune.mjs:205-217` — Delete the receipt after a successful apply, or reject it when `at` is older than a few minutes. Add a CLI test that applies twice, re-adds the ids, and expects the second apply to be refused.
2. `we:scripts/conveyor/queue.mjs` — A deterministic `import/no-unresolved` lint rule to verify module resolution at build time.
3. `we:scripts/conveyor/queue.mjs` — Strict coverage thresholds or TDD enforcement for documented failure paths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4077@379c6cc19ef5babe9f13c10dd0a65e541ebf8eb1

## Progress

Preparation reinspection (2026-10-14; existing stamps left untouched for the runner): the original scope named both queue modules and both existing test suites; the original premise bundled receipt replay prevention, unresolved-import lint, and coverage/TDD enforcement. The receipt defect remains: we:scripts/conveyor/queue-prune.mjs:205-217 hashes the drop class and sorted IDs, writes an `at` value, and checks only the digest. The historical line 210 citation no longer identifies validation: directory creation is now at we:scripts/conveyor/queue-prune.mjs:211, and digest-only validation is at we:scripts/conveyor/queue-prune.mjs:214-217. The apply branch at we:scripts/conveyor/queue.mjs:261-270 never consumes the receipt. Re-adding the same IDs restores the same digest.

Corrected delivery scope: retain the four declared paths, with receipt lifecycle unit and CLI regressions in we:scripts/conveyor/__tests__/queue-prune.test.mjs and CLI import/roundtrip regression coverage in we:scripts/conveyor/__tests__/queue.test.mjs. The existing bulk CLI case at we:scripts/conveyor/__tests__/queue-prune.test.mjs:213-223 stops after the first successful apply; it does not test replay. These are existing files, not missing suites. No source relocation is needed. The old preparation proposed a new startup/list smoke case, but we:scripts/conveyor/__tests__/queue.test.mjs:23-28 already launches the real CLI and we:scripts/conveyor/__tests__/queue.test.mjs:71-74 already parses empty-list JSON. Correct that test scope to strengthen the existing case with success/action and no-sidecar-write assertions, rather than duplicate it. Source-to-test pairing remains we:scripts/conveyor/queue-prune.mjs → we:scripts/conveyor/__tests__/queue-prune.test.mjs and we:scripts/conveyor/queue.mjs → both scoped suites.

The broader guard requests remain follow-ups below: we:package.json:28-45 exposes Vitest commands rather than an ESLint build gate, and we:vitest.config.ts:56-70 explicitly distinguishes tooling from the standards coverage planes (with a trust-chain exception); its thresholds already specify 80 at we:vitest.config.ts:116-121. A new repository-wide lint or coverage policy is not a prerequisite for the receipt regression.

Retain size 3: approximately 15 changed lines in we:scripts/conveyor/queue-prune.mjs for receipt cleanup, 15 in we:scripts/conveyor/queue.mjs for lifecycle integration/error handling, 90 in we:scripts/conveyor/__tests__/queue-prune.test.mjs for helper and CLI cases, and 10 in we:scripts/conveyor/__tests__/queue.test.mjs for stronger existing CLI startup assertions (about 130 total). This is an estimate, not an implementation diff. Preparation is based on source inspection; no runtime reproduction or test pass is claimed. The runner owns checks and stamping.

## Design

Use the explicitly requested deletion alternative: a completed bulk apply consumes its dry-run receipt. A timeout alone cannot reject an immediate second apply after IDs are re-added, so it does not satisfy the named regression without consumption.

Add a receipt-removal helper beside the existing receipt functions in we:scripts/conveyor/queue-prune.mjs. In the bulk-removal branch of we:scripts/conveyor/queue.mjs, retain protection loading, plan computation, and digest validation. After successful queue persistence, delete the receipt before reporting success. A validated zero-drop apply also consumes its receipt. Dry-runs continue to write receipts without mutating the queue. Ordinary remove, automatic prune, and the shared applyPlan function keep their current semantics.

Missing receipt cleanup is harmless; other filesystem errors must produce a nonzero result and an explicit cleanup diagnostic, never a successful apply response. If persistence already succeeded, the diagnostic must say so rather than imply rollback. A queue-write failure leaves the validated receipt in place and must not be presented as successful receipt consumption. Report cleanup failure through the CLI failure response, including that queue persistence completed (or that the zero-drop apply needed no write), so JSON callers receive an explicit error as well as a nonzero exit. Keep the existing receipt format and digest rules; no age threshold is introduced.

This establishes sequential replay prevention, not atomic cross-process exclusion or crash recovery between queue persistence and receipt deletion. Those require a separate transaction design and are not implied by this change.

## MVP

- **Must:** after a successful dry-run/apply, the receipt is absent. Re-add the removed IDs and retry the same apply without another dry-run: refuse with nonzero exit and leave the queue byte-for-byte unchanged.
- **Must:** a new dry-run permits the new apply; protected IDs and unrelated rows survive throughout.
- **Must:** missing, malformed, or mismatched receipts still refuse before queue mutation; receipt cleanup errors never report success. Successful zero-drop applies consume receipts too.
- **Must:** preserve the CLI entry point's module-resolution smoke coverage and add concrete regression assertions for the documented failure paths.
- **Could:** add repository-wide unresolved-import lint and expanded coverage policy as the separately scoped follow-ups below. They are not silently considered delivered by a passing CLI test.

## Test plan

In we:scripts/conveyor/__tests__/queue-prune.test.mjs, extend the temporary-sidecar harness at we:scripts/conveyor/__tests__/queue-prune.test.mjs:179-192, capturing stderr as well as stdout. Exercise dry-run → apply → re-add via the CLI → identical apply refusal → fresh dry-run → successful apply. Assert receipt existence after dry-run, absence after success, nonzero refusal, unchanged queue bytes on refusal, and retained protected/unrelated IDs. Use the existing fixture IDs 1 (removed), 2 (unrelated), and 3 (protected). Avoid real operator queue state and remote reads by retaining the existing nonempty CONVEYOR_PRUNE_PROTECTED override and temporary CONVEYOR_QUEUE_FILE; isolate backlog loading with a temporary WE_BACKLOG_DIR and disable add-time kind/readiness checks for the re-add step.

Add receipt helper tests for missing, malformed, and mismatched receipt contents, successful deletion, harmless missing cleanup, and propagated non-ENOENT errors using deterministic filesystem mocks. Add zero-drop consumption and queue-write/cleanup failure tests; assert no success result on either failure and no misleading rollback claim. For CLI failure injection, generate a temporary Node preload fixture in the test harness: patch only the targeted node:fs renameSync or unlinkSync call and use syncBuiltinESMExports before loading the real CLI. Queue persistence uses a temporary write followed by rename at we:scripts/conveyor/queue-store.mjs:320-325, so inject the write-path failure at renameSync with its destination equal to the temporary queue path; match unlinkSync against the receipt path exactly; leave fixture setup and other filesystem operations intact. Assert a write failure preserves both queue bytes and receipt, while a cleanup failure leaves the persisted queue and receipt visible and reports the partial completion. This keeps fault fixtures inside the scoped test file and requires no production environment switch. Do not use timing sleeps or permission-bit failures that vary under elevated users.

In we:scripts/conveyor/__tests__/queue.test.mjs:71-74, extend the existing empty-list case to assert ok:true, action:list, and absence of a newly written sidecar; its subprocess helper already fails on nonzero exit and its JSON parse already checks parseability. Existing add/remove/list roundtrips remain regression coverage; this runtime import check supplements rather than replaces the requested future static lint.

## Proof plan

The implementing worker first adds the replay regression and runs it against the unchanged implementation through the host heavy-run queue. Capture the expected failure: the second apply succeeds and removes re-added IDs instead of refusing. After implementation, run both scoped suites through that same queue and capture the passing replay case and refusal assertions. Run the standards gate through admission as well. All execution goes through we:scripts/readiness/heavy-admission.mjs using its `run --` interface: run `npx vitest run` with we:scripts/conveyor/__tests__/queue-prune.test.mjs and we:scripts/conveyor/__tests__/queue.test.mjs together (strip the documentation-only `we:` prefix from arguments), then run `npm run check:standards` through the same admission wrapper. Record exit codes and the replay assertion output; an unrelated gate failure must be reported separately rather than called a passing proof. The runner owns preparation checks and stamping; these red/green implementation proofs remain future work.

## Done when

The replay regression demonstrably fails before the fix and passes after it; receipt lifecycle/error cases and both scoped CLI suites pass, and the standards gate passes. A successful apply cannot authorize a later sequential removal through the same retained receipt. Static lint and global coverage policy remain explicitly outstanding follow-ups.

## Follow-ups

- Preserve the original deterministic unresolved-import lint request: separately scope the build-gate configuration and its negative fixture (a deliberately broken relative import must fail). The CLI smoke test here proves runtime loading only. Do not introduce a new lint toolchain implicitly in this receipt fix.
- Preserve the original strict-coverage/TDD request: separately establish which tooling files and failure branches should be instrumented against the existing coverage-plane rules in we:vitest.config.ts:56-70, then add a gate regression that demonstrates enforcement. No new percentage or TDD policy is selected here.
- Concurrent applies and crashes between persistence and deletion need transactional receipt consumption if that stronger guarantee is required; this card promises sequential replay prevention only.
