---
bornAs: xp1cr0h
kind: story
size: 3
parent: "4075"
status: open
deliveryAgent: codex
deliveryAgentReason: "Build this card on Codex as requested; its four-file receipt lifecycle scope exceeds the inherited feature probation envelope. Keep shared feature routing on the Argon/Codex roster."
scope: ["we:scripts/conveyor/queue-prune.mjs", "we:scripts/conveyor/queue.mjs", "we:scripts/conveyor/__tests__/queue-prune.test.mjs", "we:scripts/conveyor/__tests__/queue.test.mjs"]
dateOpened: "2026-10-06"
preparedDate: "2026-10-14"
preparedAgainstSha: "add3ffc9feb86aee144df531758250009a075cba"
tags: []
---

# Prevention — Delete the receipt after a successful apply, or reject it when at is older than a few minutes. Ad… (from web-everything/web-everything#4077 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/queue-prune.mjs:205-217` — Delete the receipt after a successful apply, or reject it when `at` is older than a few minutes. Add a CLI test that applies twice, re-adds the ids, and expects the second apply to be refused.
2. `we:scripts/conveyor/queue.mjs` — A deterministic `import/no-unresolved` lint rule to verify module resolution at build time.
3. `we:scripts/conveyor/queue.mjs` — Strict coverage thresholds or TDD enforcement for documented failure paths.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4077@379c6cc19ef5babe9f13c10dd0a65e541ebf8eb1

## Progress

Re-inspected for probation preparation on 2026-10-14. The inherited preparation already chose receipt deletion and deferred the broader lint/coverage requests; this pass preserves that goal and scope. Source inspection confirms there is still no receipt consumption in we:scripts/conveyor/queue.mjs:248-270, so this is not already delivered. Existing preparation stamps are left untouched for the runner.

Current preparation revalidated the four-file scope against the checkout. The old draft treated cleanup diagnostics uniformly as post-persistence failures; the corrected premise distinguishes a nonempty apply (queue persisted) from a zero-drop apply (no queue write): we:scripts/conveyor/queue.mjs:264 skips applyPlan when there are no drops. Keep the original receipt-consumption goal and scope, but require truthful diagnostics for both paths. The original replay wording could imply two consecutive applies before re-adding; the concrete sequence below restores the dropped IDs before the second apply so its digest really matches. Evidence: we:scripts/conveyor/queue-prune.mjs:206-207 hashes only drop class and sorted dropped IDs, and we:scripts/conveyor/__tests__/queue-prune.test.mjs:213-222 covers only the first apply. No implementation or test relocation was found. Existing preparation stamps are left untouched for the runner.

Preparation inspection: the original scope named both queue modules and both existing test suites; the original premise bundled receipt replay prevention, unresolved-import lint, and coverage/TDD enforcement. The receipt defect remains: we:scripts/conveyor/queue-prune.mjs:205-217 hashes the drop class and sorted IDs, writes an `at` value, and checks only the digest. Prior preparations cited lines 204-215 and 208-215; the receipt functions now extend through line 217, with validation at we:scripts/conveyor/queue-prune.mjs:214-217 and directory creation at line 211. The corrected receipt lifecycle locus is we:scripts/conveyor/queue-prune.mjs:205-217. The apply branch at we:scripts/conveyor/queue.mjs:261-270 never consumes the receipt. Re-adding the same IDs restores the same digest.

Corrected delivery scope: retain the four declared paths, with receipt lifecycle unit and CLI regressions in we:scripts/conveyor/__tests__/queue-prune.test.mjs and CLI import/roundtrip regression coverage in we:scripts/conveyor/__tests__/queue.test.mjs. The existing bulk CLI case at we:scripts/conveyor/__tests__/queue-prune.test.mjs:213-223 stops after the first successful apply; it does not test replay. These are existing files, not missing suites. No source relocation is needed. The inherited plan proposed a new startup/list smoke test, but we:scripts/conveyor/__tests__/queue.test.mjs:23-28 already throws on unsuccessful CLI startup, and lines 71-74 already parse an empty list response. Strengthen that existing case with success/action and no-sidecar-write assertions instead of duplicating it. Source-to-test pairing remains we:scripts/conveyor/queue-prune.mjs → we:scripts/conveyor/__tests__/queue-prune.test.mjs and we:scripts/conveyor/queue.mjs → both scoped suites.

The broader guard requests remain follow-ups below: we:package.json:28-45 exposes Vitest commands rather than an ESLint build gate, and we:vitest.config.ts:56-70 explicitly distinguishes tooling from the standards coverage planes (with a trust-chain exception); its thresholds already specify 80 at we:vitest.config.ts:116-121. A new repository-wide lint or coverage policy is not a prerequisite for the receipt regression.

Retain size 3: approximately 15 changed lines in we:scripts/conveyor/queue-prune.mjs for receipt cleanup, 15 in we:scripts/conveyor/queue.mjs for lifecycle integration/error handling, 90 in we:scripts/conveyor/__tests__/queue-prune.test.mjs for helper and CLI cases, and 10 in we:scripts/conveyor/__tests__/queue.test.mjs to strengthen the existing CLI empty-list assertion (about 130 total). This is an estimate, not an implementation diff. Preparation is based on source inspection; no runtime reproduction or test pass is claimed. The runner owns checks and stamping.

## Design

Use the explicitly requested deletion alternative: a completed bulk apply consumes its dry-run receipt. A timeout alone cannot reject an immediate second apply after IDs are re-added, so it does not satisfy the named regression without consumption.

Add a receipt-removal helper beside the existing receipt functions in we:scripts/conveyor/queue-prune.mjs. In the bulk-removal branch of we:scripts/conveyor/queue.mjs, retain protection loading, plan computation, and digest validation. After successful queue persistence, delete the receipt before reporting success. A validated zero-drop apply also consumes its receipt. Dry-runs continue to write receipts without mutating the queue. Ordinary remove, automatic prune, and the shared applyPlan function keep their current semantics.

Missing receipt cleanup is harmless; other filesystem errors must produce a nonzero result and an explicit cleanup diagnostic, never a successful apply response. If persistence already succeeded, the diagnostic must say so rather than imply rollback. If there were zero drops, report that the queue was unchanged and receipt cleanup failed; do not claim a write occurred. Use the CLI fail response in we:scripts/conveyor/queue.mjs:187-191 so JSON callers receive ok:false and an error, as well as a nonzero exit. A queue-write failure leaves the validated receipt in place and must not be presented as successful receipt consumption. Keep the existing receipt format and digest rules; no age threshold is introduced.

This establishes sequential replay prevention, not atomic cross-process exclusion or crash recovery between queue persistence and receipt deletion. Those require a separate transaction design and are not implied by this change.

## MVP

- **Must:** after a successful dry-run/apply, the receipt is absent. Re-add the removed IDs and retry the same apply without another dry-run: refuse with nonzero exit and leave the queue byte-for-byte unchanged.
- **Must:** a new dry-run permits the new apply; protected IDs and unrelated rows survive throughout.
- **Must:** missing, malformed, or mismatched receipts still refuse before queue mutation; receipt cleanup errors never report success. Successful zero-drop applies consume receipts too.
- **Must:** preserve the CLI entry point's module-resolution smoke coverage and add concrete regression assertions for the documented failure paths.
- **Could:** add repository-wide unresolved-import lint and expanded coverage policy as the separately scoped follow-ups below. They are not silently considered delivered by a passing CLI test.

## Test plan

In we:scripts/conveyor/__tests__/queue-prune.test.mjs, extend the temporary-sidecar harness at we:scripts/conveyor/__tests__/queue-prune.test.mjs:179-192, capturing stderr as well as stdout and setting CONVEYOR_NO_READY_CHECK=1 and CONVEYOR_NO_KIND_CHECK=1 for re-add operations (the latter bypass is at we:scripts/conveyor/queue.mjs:103). Exercise dry-run → apply → re-add via the CLI → identical apply refusal → fresh dry-run → successful apply. Assert receipt existence after dry-run, absence after success, nonzero refusal, unchanged queue bytes on refusal, and retained protected/unrelated IDs. Use the existing fixture IDs 1 (removed), 2 (unrelated), and 3 (protected). Avoid real operator queue state and remote reads by retaining the existing nonempty CONVEYOR_PRUNE_PROTECTED override and temporary CONVEYOR_QUEUE_FILE; isolate backlog loading with a temporary WE_BACKLOG_DIR.

Add receipt helper tests for missing, malformed, and mismatched receipt contents, successful deletion, harmless missing cleanup, and propagated non-ENOENT errors using deterministic filesystem mocks. Also exercise missing, malformed, and mismatched receipts through the CLI with a nonempty planned drop: require nonzero exit, ok:false in JSON mode, and byte-for-byte unchanged queue contents. A helper-only refusal assertion does not prove the mutation boundary. Add zero-drop consumption and queue-write/cleanup failure tests; assert no success result on either failure and no misleading rollback claim. For CLI failure injection, generate a temporary Node preload fixture in the test harness: patch only the targeted node:fs renameSync or unlinkSync call and use syncBuiltinESMExports before loading the real CLI. Queue persistence uses a temporary write followed by rename at we:scripts/conveyor/queue-store.mjs:320-325, so inject the write-path failure at renameSync with its destination equal to the temporary queue path; match unlinkSync against the receipt path exactly; leave fixture setup and other filesystem operations intact. For zero-drop apply, assert the queue bytes are unchanged, cleanup still runs, and an injected cleanup failure reports no queue write. Assert a write failure preserves both queue bytes and receipt. Inject receipt unlink failure after persistence to prove the queue changed, the receipt remains, exit is nonzero, and the diagnostic explicitly reports persistence succeeded but cleanup failed. This uses test-owned temporary fixtures, not a production failure switch or a change to the queue store. Do not use timing sleeps or permission-bit failures that vary under elevated users.

In we:scripts/conveyor/__tests__/queue.test.mjs:71-74, extend the existing isolated empty-list case to assert `ok: true`, `action: list`, and absence of a newly written sidecar alongside its empty queue assertion; the subprocess wrapper already enforces successful startup and JSON parsing. Existing add/remove/list roundtrips remain regression coverage; this runtime import check supplements rather than replaces the requested future static lint.

## Proof plan

The implementing worker first adds the replay regression and runs it against the unchanged implementation through the host heavy-run queue. Capture the expected failure at the replay-refusal assertion: the second apply succeeds and removes re-added IDs instead of refusing. Keep this initial regression focused on replay refusal, so an earlier receipt-existence assertion does not mask the behavioral failure; add the lifecycle assertions afterward. After implementation, run both scoped suites through that same queue and capture the passing replay case and refusal assertions. Run the standards gate through admission as well. Verification commands are executed from the WE repository; their script and test loci are we:scripts/readiness/heavy-admission.mjs, we:scripts/conveyor/__tests__/queue-prune.test.mjs, and we:scripts/conveyor/__tests__/queue.test.mjs.

Run Node with we:scripts/readiness/heavy-admission.mjs and arguments `run -- npx vitest run`, followed by the repository-relative forms of both prefixed test paths above (strip the documentation-only `we:` prefix from arguments). For the standards gate, use the same admission entry point with `run -- npm run check:standards`. No direct Vitest or standards-script invocation bypasses admission. Record exit codes and the replay assertion output; an unrelated gate failure must be reported separately rather than called a passing proof. The runner owns preparation checks and stamping; these red/green implementation proofs remain future work.

## Done when

The replay regression demonstrably fails before the fix and passes after it; receipt lifecycle/error cases and both scoped CLI suites pass, and the standards gate passes. A successful apply cannot authorize a later sequential removal through the same retained receipt. Static lint and global coverage policy remain explicitly outstanding follow-ups.

## Follow-ups

- Preserve the original deterministic unresolved-import lint request: separately scope the build-gate configuration and its negative fixture (a deliberately broken relative import must fail). The CLI smoke test here proves runtime loading only. Do not introduce a new lint toolchain implicitly in this receipt fix.
- Preserve the original strict-coverage/TDD request: separately establish which tooling files and failure branches should be instrumented against the existing coverage-plane rules in we:vitest.config.ts:56-70, then add a gate regression that demonstrates enforcement. No new percentage or TDD policy is selected here.
- Concurrent applies and crashes between persistence and deletion need transactional receipt consumption if that stronger guarantee is required; this card promises sequential replay prevention only.
