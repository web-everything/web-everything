---
bornAs: xcu4cqf
kind: story
size: 8
status: active
scaffoldedBy: "hermetic-tests"
dateScaffolded: "2026-10-08"
dateOpened: "2026-10-08"
tags: []
---

# Hermetic tests by default: blocking unit/soak suites cannot reach live GitHub, conveyor state, lane pool or origin backlog; live tests move to a scheduled non-blocking suite

Main went red ~5.5h (2026-10-08) because soak scenario build-dispatch-orphan-adopt read live gh + origin/main backlog with real card numbers. Make the test + soak harness hermetic by default: a loud recording fake gh, fs guards on the real conveyor state root / lane pool / primary-checkout backlog, a per-test violation check, a ratchet scan over tests that reference live readers without injection, and a separate scheduled live suite (declared settings) that never gates PRs/main.

## Done when

1. **Executable** — `npm run test:soak -- we:scripts/conveyor/soak/breaks/build-dispatch-orphan-adopt.soak.test.mjs` on a tree WITHOUT PR #4522's fix fails immediately with `live GitHub/backlog access in test` naming the `gh pr list` and `git ls-tree origin/main` calls (before this card it passed or failed depending on live card state); with #4522's self-contained scenario it passes.
2. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/hermetic-tests.test.mjs we:scripts/lib/__tests__/hermetic-test-scan.test.mjs` passes: the pure decision (`isHermetic`, `classifyFsPath`, `classifyGitArgs`, `classifyFetchUrl`), the fake `gh` + `git` shims, the fs/fetch guard, the settings validation, the cron pin to `we:.github/workflows/live-tests.yml`, and the ratchet (per-file live-read counts may only shrink against `we:scripts/hermetic-test-baseline.json`).
3. The full unit and soak suites run green in hermetic mode (enforce), with counts and wall time recorded before/after in the PR.
4. Tests that genuinely need live data are listed in `liveSuite.tests` (with a reason) in `we:scripts/hermetic-tests.settings.json`, excluded from every blocking config, and run only by `we:vitest.live.config.ts` on the scheduled `we:.github/workflows/live-tests.yml` workflow, whose failure opens/updates one `health-smell` issue and never gates a PR or main.

## Edge cases this change must handle

1. **Untrusted text** — n/a: the guard reads only paths, argv and URLs from the test process itself; the violation log is TSV written by our own shims and parsed field-by-field, never evaluated.
2. **Truncated reads** — the per-file violation log is read incrementally by byte offset; an access logged after its test ended (a detached child) is not dropped but fails the file in `afterAll`.
3. **Shared state files** — each test file gets its own violations dir under the run's private temp root; the guarded roots are exactly the shared host state (conveyor state, jobs, lane pool, primary backlog/queue) and the checkout under test plus its sibling repos are exempt.
4. **Fail closed** — hermetic is ON unless a config says `WE_TEST_HERMETIC=0` (only `we:vitest.live.config.ts` does); a malformed settings file throws; the setup is not wrapped in a try; `report` mode is ignored under CI; a swallowed `HermeticAccessError` still fails the test in `afterEach`.
5. **Identity scoping** — every violation carries the running test's id/name (env set in `beforeEach`, inherited by child shims), so the failure names the exact test.
6. **State over time** — this card exists because live data drifts: nothing in a blocking suite may depend on it, and the drift-prone tests run on a schedule as a health signal.
7. **Who wrote it** — n/a: no authorship decision; the ratchet only counts code shapes in tracked test sources.
