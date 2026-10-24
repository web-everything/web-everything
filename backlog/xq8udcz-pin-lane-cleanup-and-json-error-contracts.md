---
kind: story
status: open
size: 5
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lane-git-diet.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/lane-pool-git-diet.test.mjs", "we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-23"
tags: [prevention, testing, git]
---

# Pin lane cleanup and JSON error contracts

Add the four prevention guards owed by the correctness panel on PR #5806. Its advisory accepted correctness while asking for named tests of production environment isolation, test seam gating, malformed JSON handling and an absent selected pool.

Source: web-everything/web-everything#5806, advisory review posted 2026-10-24T00:54:30Z, head `4a5ee48414889ace5d987b240b601ec1734aafa3`. Locations in that review are `we:scripts/lane-pool.mjs:220`, `we:scripts/lane-git-diet.mjs:148`, `we:scripts/check-standards-rules.mjs:1085` and `we:scripts/lane-git-diet.mjs:143`. These are requested prevention tests, not a claim that all four behaviors currently fail. In particular, the current ruling marks the earlier lane-pool wiring finding **not-real**; preserve that ruling and the existing scrub guards.

Idempotency key (do not edit): advisory-prevention-key:web-everything/web-everything#5806@4a5ee48414889ace5d987b240b601ec1734aafa3:correctness-contracts

## Acceptance

- [A1] **Executable** — In `we:scripts/__tests__/lane-pool-git-diet.test.mjs`, exercise production `git()` and `gitQuiet()` with inherited `GIT_DIR` and `GIT_REFERENCE_BACKEND` aimed at a decoy. Assert reads and writes stay in the intended lane and the decoy is unchanged. Cover the reclaim reset/clean wiring too, or add the proposed lint rejecting direct `laneGitHardeningEnv(process.env)` there. Test the production call path, rather than replaying only the scrubber helper. Run that test file through `npm run test:unit --`.
- [A2] **Executable** — In `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs`, spawn the CLI with `VITEST` absent and then empty, with `LANE_GIT_DIET_TEST_LATE_BORROWER`, `LANE_GIT_DIET_TEST_PAUSE_AT` and `LANE_GIT_DIET_TEST_PAUSE_DIR` set. Assert no alternates file or pause signal is written, the run completes within a bounded timeout, and normal cleanup occurs. Check both pause and late-borrower seams independently so a startup refusal cannot satisfy the test. Keep existing positive seam tests.
- [A3] **Executable** — In `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, pass unterminated strings, raw control characters and invalid escapes to both `findDuplicateKeysPerScope` and `validateNoDuplicateManifestKeys`. Pin an explicit contract: a clear error or a tolerant duplicate result. Check package-manifest and timing callers use that contract safely; preserve escaped-key duplicate detection. Run that test file through `npm run test:unit --`.
- [A4] **Executable** — In `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs`, supply existing pool and scan roots with an absent selected pool such as `frontierui`. Assert exit status 2, a specific diagnostic, no stack trace and no changed repository. Add the clean refusal in `we:scripts/lane-git-diet.mjs` if needed. Run that test file through `npm run test:unit --`.

## Non-goals

- [N1] Do not remove hardening or seam guards to demonstrate a regression; use the sanctioned revert-red mechanism where the behavior already works.
- [N2] Do not change borrower discovery policy or the explicit-lanes test; those obligations have separate cards from the same advisory.

## Edge cases

- Untrusted text: cover escaped JSON keys, invalid strings and root paths containing spaces; keep shell input inert.
- Truncated reads and resource bounds: use bounded child timeouts; a timed-out pause seam is a test failure, never a successful refusal.
- Shared state: use independent temporary lane and decoy repositories; compare decoy state before and after each path.
- Fail closed: distinguish the intended missing-pool diagnostic from startup failures at other guards.
- Identity scoping: exercise inherited location redirection at the actual lane-pool call sites.
- State over time: restore inherited environment between cases and independently pin production seam gating.
- Who wrote it: production test seam behavior requires the existing Vitest guard; environment paths alone confer no write authority.
