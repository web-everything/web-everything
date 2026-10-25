---
bornAs: xaz2izw
kind: story
size: 5
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-git-diet.test.mjs", "we:scripts/lane-git-diet.mjs", "we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-23"
tags: [prevention, test-coverage]
---

# Prevention — Pin lane diet and lane pool CLI contracts

Track the five coverage and error-contract preventions owed by PR #5806's advisory review. Add tests at the real call paths, pin malformed-input behavior and clean CLI errors, and make the explicit-lanes refusal test deterministic. This filing implements the requested deferral; it does not change runtime behavior.

Source: [PR #5806 advisory review](https://github.com/web-everything/web-everything/pull/5806), posted 2026-10-24T00:54:30Z, head `4a5ee48414889ace5d987b240b601ec1734aafa3`. Findings below are recorded as prevention work, without reopening the supplied `not-real` ruling on lane-pool wiring or changing any review label. The repeated explicit-lanes finding is also the review's later-round card suggestion and belongs here rather than in an implementation change to that PR.

Split from the canonical prevention filing in #6966, which carries this advisory head's idempotency key.

## Acceptance

- [A1] **Lane-pool environment wiring** (`we:scripts/lane-pool.mjs:220`): add a named test in `we:scripts/__tests__/lane-pool-git-diet.test.mjs` that exercises actual `git()` and `gitQuiet()` call paths with inherited `GIT_DIR` pointing to a decoy and `GIT_REFERENCE_BACKEND` set. Assert results come from the lane and the decoy's refs, config and object contents remain unchanged. Exercise reclaim reset/clean wiring in temporary fixtures as well; calling only `scrubGitLocationEnv` is insufficient. Do not assume every installed Git supports the redirected backend syntax; test the environment reaching the child as well as the decoy assertions.
- [A2] **Production seam isolation** (`we:scripts/lane-git-diet.mjs`, test seams): add a subprocess test in `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs` that explicitly deletes inherited `VITEST`, supplies `LANE_GIT_DIET_TEST_LATE_BORROWER`, `LANE_GIT_DIET_TEST_QUOTED_ALTERNATE`, `LANE_GIT_DIET_TEST_PAUSE_AT` and `LANE_GIT_DIET_TEST_PAUSE_DIR`, then runs an otherwise eligible apply. Cover each pause stage, use an existing signal directory without a `go` file, and bound the child below the seam's 30-second timeout. Assert normal cleanup completes and neither an alternates file nor a `ready` signal is created. Also test absent and empty `VITEST` independently.
- [A3] **Malformed JSON contract** (`we:scripts/check-standards-rules.mjs:1088`): add named cases in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` for unterminated strings, invalid escapes and raw control characters, calling both `findDuplicateKeysPerScope` and `validateNoDuplicateManifestKeys`. Explicitly document and pin either tolerant results or a clear error contract for each public helper. Check manifest and timings callers before changing the contract; retain escaped-key duplicate detection.
- [A4] **Missing pool diagnostic** (`we:scripts/lane-git-diet.mjs`, pool enumeration): add a subprocess test in `we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs` with existing explicit pool and scan roots but an absent selected pool directory. Test both dry-run and apply with an explicit lane list. Require status 2, a pool-specific diagnostic and no stack trace; assert the CLI created no pool or claim marker. Existing empty pools remain a successful empty report.
- [A5] **Explicit-lanes refusal** (`we:scripts/lib/__tests__/lane-git-diet-cleanup.test.mjs`, named refusal test): supply `--scan-root` and `--pool-root` pointing to existing fixture directories, omit only `--lanes`, and assert status 2 plus the specific `--apply needs an explicit --lanes=N,M list` diagnostic. Assert no lane modification; do not use a generic `toThrow` that can pass on a missing default root. This single acceptance item covers both the simplicity finding and its duplicate card suggestion.
- [A6] From the WE checkout, run `npm run test:unit --` with the three repository-relative test paths named in A1–A3 (remove their `we:` prefixes), then run the diff-selected verify gate. Record which regression fails before each necessary source fix; do not remove existing safety guards by hand to manufacture a failing test. Treat test-only pins that already pass as coverage additions, not reproduced production defects.

## Non-goals

- [N1] Borrower scan expansion, tracked separately in #6966.
- [N2] A new review verdict, human-review clearance, or a claim that the supplied lane-pool ruling was wrong.
- [N3] Running destructive lane-pool commands against a host pool; all integration fixtures must be isolated temporary repositories.

## Edge cases this change must handle

1. **Untrusted text** — Preserve literal JSON escapes and path whitespace; isolate inherited environment overrides and do not run fixture text through a shell.
2. **Truncated reads** — A child timeout, spawn failure or unrelated startup error cannot satisfy an expected diagnostic or normal-cleanup assertion.
3. **Shared state files** — Verify decoy and signal files remain untouched; keep fixture directories independent across tests.
4. **Fail closed** — Pin exact missing-pool and missing-lanes exit paths, and define the malformed-input contract at both helper and caller surfaces.
5. **Identity scoping** — Test real lane-pool wiring and explicitly remove inherited `VITEST`; a helper-only scrub test or an ambient default root is insufficient.
6. **State over time** — Snapshot decoy refs/config/objects before and after calls; every pause variant needs a bounded child completion assertion.
7. **Who wrote it** — Only the isolated test process supplies seams; the production subprocess must ignore them without `VITEST`.
