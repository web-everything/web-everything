---
bornAs: x4cdc8i
kind: story
size: 3
tier: pinned
status: open
scope: ["we:scripts/lib/under-test.mjs", "we:scripts/lib/__tests__/under-test.test.mjs", "we:scripts/lib/under-test.cjs", "we:vitest.setup.ts", "we:scripts/lib/__tests__/under-test-bootstrap.test.mjs", "we:bun-test.preload.ts", "we:scripts/backlog.mjs", "we:scripts/__tests__/backlog-under-test.test.mjs", "we:scripts/lib/backlog-index.cjs", "we:scripts/__tests__/backlog-index.test.mjs", "we:scripts/lib/claude-agents-cache.mjs", "we:scripts/lib/__tests__/claude-agents-cache.test.mjs", "we:scripts/lib/gh-rest-read.mjs", "we:scripts/lib/__tests__/gh-rest-read.test.mjs", "we:scripts/lib/lane-pool-paths.mjs", "we:scripts/lib/__tests__/lane-pool-paths-under-test.test.mjs", "we:scripts/lib/pr-snapshot-store.mjs", "we:scripts/lib/__tests__/pr-snapshot.test.mjs", "we:scripts/lib/pr-snapshot.mjs", "we:scripts/lib/pr-facts.mjs", "we:scripts/lib/__tests__/pr-facts.test.mjs", "we:scripts/lib/salvage-index.mjs", "we:scripts/lib/__tests__/salvage-index.test.mjs", "we:scripts/lib/target-registry.mjs", "we:scripts/__tests__/target-registry.test.mjs", "we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/operations/dispatch-providers/probation-worker.mjs", "we:scripts/operations/__tests__/probation-heal-run.test.mjs", "we:skills-src/conveyor/verify-daemon.mjs", "we:skills-src/conveyor/__tests__/verify-daemon.test.mjs", "we:scripts/__tests__/lane-pool-root-and-shallow.test.mjs", "we:scripts/__tests__/lane-pool-vitest-real-root-guard.test.mjs", "we:__tests__/vitest.setup*.test.ts", "we:__tests__/bun-test.preload*.test.ts", "we:scripts/lib/__tests__/backlog-index*.test.cjs", "we:scripts/lib/__tests__/pr-snapshot-store*.test.mjs", "we:scripts/lib/__tests__/target-registry*.test.mjs", "we:scripts/operations/dispatch-providers/__tests__/probation-worker*.test.mjs"]
dateOpened: "2026-10-06"
preparedDate: "2026-10-06"
preparedAgainstSha: "cc47a8e8dfc7a0ddc9a7142e4d94bdf9ab5cacd7"
tags: []
---

# Runner-neutral under-test marker replacing env.VITEST guards

Make the existing test-isolation guards recognize `WE_UNDER_TEST` as well as `VITEST`, so the Bun opt-in follow-up to #5067 no longer needs to impersonate Vitest. Preserve each caller's existing overrides and production behavior. The current inventory is 19 executable guards across 14 production files, plus the two runner bootstrap files. No Bun migration or default-runner change is part of this item. Operator handoff checklist: item 72a.

## Progress

- Investigated checkout `cc47a8e8dfc7a0ddc9a7142e4d94bdf9ab5cacd7`; the helper does not yet exist and the direct guards remain, so this goal is not already delivered.
- **Old premise/scope:** the body counted 12 production files / 16 checks, while frontmatter listed only five production consumers, the proposed helper, and two bootstrap files. **Corrected premise/scope:** 14 production files / 19 checks. Add the seven consumers already named only in the old body, plus the omitted CommonJS cache guard at `we:scripts/lib/backlog-index.cjs:18` and two PR-facts guards at `we:scripts/lib/pr-facts.mjs:86` and `we:scripts/lib/pr-facts.mjs:297`. The complete observed inventory is below; no original consumer moved. The daemon citation moves from line 77 to `we:skills-src/conveyor/verify-daemon.mjs:79`.
- **Bootstrap correction:** `we:bun-test.preload.ts:10` already sets `VITEST` before importing the shared setup at line 11. This is a compatibility shim, not an already-delivered neutral marker. The stripping loop at `we:vitest.setup.ts:96-100` removes ambient `WE_*` keys, so the shared setup must re-establish the marker after that block, outside its conditional.
- **Module-format correction:** `we:scripts/lib/backlog-index.cjs:1` uses synchronous CommonJS, including its constructor at line 17. Add a tiny CommonJS predicate implementation with an ESM facade instead of changing the synchronous loader or relying on require-of-ESM support. This keeps the proposed ESM API and one predicate implementation.
- **Test-scope correction:** the lane tests actually live at `we:scripts/__tests__/lane-pool-root-and-shallow.test.mjs` and `we:scripts/__tests__/lane-pool-vitest-real-root-guard.test.mjs`; snapshot-store tests live in `we:scripts/lib/__tests__/pr-snapshot.test.mjs:68`. Root-level setup tests are not selected by `we:vitest.config.ts:107-113`; put planned bootstrap coverage under the already-selected `we:scripts/lib/__tests__/under-test-bootstrap.test.mjs`. Every source entry now has a matching existing or planned test in scope.
- **Prepare-validation repair:** the prior scope listed shared bootstrap and existing consumer regression tests but omitted the six matching test patterns required by the runner. Add planned scope reservations for `we:__tests__/vitest.setup*.test.ts`, `we:__tests__/bun-test.preload*.test.ts`, `we:scripts/lib/__tests__/backlog-index*.test.cjs`, `we:scripts/lib/__tests__/pr-snapshot-store*.test.mjs`, `we:scripts/lib/__tests__/target-registry*.test.mjs`, and `we:scripts/operations/dispatch-providers/__tests__/probation-worker*.test.mjs`. Retain the existing executable coverage mapping below; these reservations do not assert that files already exist or are selected by the current runner. In particular, `we:vitest.config.ts:107-114` does not select root bootstrap tests or CommonJS test files, so retain the selected shared bootstrap and backlog-index regression suites for delivery proof. Source guards remain observable at `we:scripts/lib/backlog-index.cjs:18`, `we:scripts/lib/pr-snapshot-store.mjs:37`, `we:scripts/lib/target-registry.mjs:604`, and `we:scripts/operations/dispatch-providers/probation-worker.mjs:69`; production scope and size remain unchanged.
- **Size: 2 → 3.** Evidence: the additional CommonJS boundary at `we:scripts/lib/backlog-index.cjs:17-18`, two extra guards at `we:scripts/lib/pr-facts.mjs:86,297`, and bootstrap ordering at `we:vitest.setup.ts:96-100` require interoperability, override-parity, and bootstrap tests beyond a mechanical replacement. No dependency change is proposed. Preparation only: implementation and proof runs remain for delivery; the runner owns stamps and checks.

## Design

Export `isUnderTest(env = process.env)` from the proposed `we:scripts/lib/under-test.mjs`, backed by the same function in the proposed `we:scripts/lib/under-test.cjs`. The CommonJS consumer requires the latter synchronously; ESM consumers import the facade. The function returns `Boolean(env?.VITEST || env?.WE_UNDER_TEST)` on every call, without cached environment state, runner imports, IO, or mutation. Preserve legacy truthiness: empty/unset markers are false, any nonempty string (including `0` or `false`) is true. An explicit environment bag never falls back to ambient markers.

Replace just the test-runner operand at all observed sites:

| Consumer and current line(s) | Behavior to preserve |
| --- | --- |
| `we:scripts/backlog.mjs:1078` | Build-queue cache disabled under test unless its existing explicit setting allows it. |
| `we:scripts/lib/backlog-index.cjs:18` | Disk index disabled under test without an explicit index directory; explicit disable still wins. |
| `we:scripts/lib/claude-agents-cache.mjs:8` | Default TTL zero under test, 20 seconds otherwise; explicit TTL unchanged. |
| `we:scripts/lib/gh-rest-read.mjs:39,93` | ETag-cache and host-log suppression; retain fake-gh detection and directory overrides. |
| `we:scripts/lib/lane-pool-paths.mjs:105` | Refuse implicit real pool under test; retain explicit root and deliberate escape hatch. |
| `we:scripts/lib/pr-snapshot-store.mjs:37` | Snapshot suppression, explicit disable/directory precedence, and fake-gh handling. |
| `we:scripts/lib/pr-snapshot.mjs:112` | Suppress host call-log writes absent explicit throttle/pool roots. |
| `we:scripts/lib/pr-facts.mjs:86,297` | Disable real Worker use unless explicitly enabled; suppress unisolated host logging. |
| `we:scripts/lib/salvage-index.mjs:74` | No default host salvage read under test; explicit root/directory still works. |
| `we:scripts/lib/target-registry.mjs:604` | Existing scratch-root fallback; explicit registry root wins. |
| `we:scripts/lib/verdict-ledger.mjs:827` | Existing scratch-ledger fallback; explicit ledger directory wins. |
| `we:scripts/operations/ci-heal-pr-dispatch.mjs:79-85` | Preserve all four ledger-read/write, kill-file and salvage guards and their overrides. |
| `we:scripts/operations/dispatch-providers/probation-worker.mjs:69` | Unconfigured launch off under test, on otherwise; explicit on/off and invalid-value refusal unchanged. |
| `we:skills-src/conveyor/verify-daemon.mjs:79` | Ignore the host drain marker under test. |

Set `process.env.WE_UNDER_TEST = '1'` in `we:vitest.setup.ts` immediately after the sandbox stripping block, including when sandboxing is opted out. In `we:bun-test.preload.ts`, replace the synthetic `VITEST` assignment with the neutral marker before the dynamic setup import; shared setup restores it after stripping. Do not delete a real Vitest-provided marker. Update affected guard comments and the lane refusal's runner wording while retaining its recognizable refusal phrase. Keep existing scratch-directory names to avoid an unrelated storage migration.

## MVP

1. Add the pure CommonJS predicate and ESM facade, then migrate the complete 19-site inventory using explicit `env` bags where those already exist.
2. Wire both bootstraps in the ordering above and remove Bun's synthetic Vitest marker.
3. Add neutral-marker and legacy-marker parity tests, bootstrap-order tests, and a production-source inventory assertion that prevents new direct marker reads outside the helper.
4. Adjust existing production-simulation tests that clear only `VITEST` to clear both markers explicitly. Preserve legacy-only cases so the global neutral marker cannot hide a regression. Do not widen production opt-ins or run against real operator state.

## Test plan

Source-to-test mapping (new files are planned; other files already exist):

| Source | Matching test |
| --- | --- |
| `we:scripts/lib/under-test.mjs` | `we:scripts/lib/__tests__/under-test.test.mjs` (planned) |
| `we:scripts/lib/under-test.cjs` | `we:scripts/lib/__tests__/under-test.test.mjs` (planned) |
| `we:vitest.setup.ts` | `we:scripts/lib/__tests__/under-test-bootstrap.test.mjs` (planned) |
| `we:bun-test.preload.ts` | `we:scripts/lib/__tests__/under-test-bootstrap.test.mjs` (planned) |
| `we:scripts/backlog.mjs` | `we:scripts/__tests__/backlog-under-test.test.mjs` (planned) |
| `we:scripts/lib/backlog-index.cjs` | `we:scripts/__tests__/backlog-index.test.mjs` |
| `we:scripts/lib/claude-agents-cache.mjs` | `we:scripts/lib/__tests__/claude-agents-cache.test.mjs` |
| `we:scripts/lib/gh-rest-read.mjs` | `we:scripts/lib/__tests__/gh-rest-read.test.mjs` |
| `we:scripts/lib/lane-pool-paths.mjs` | `we:scripts/lib/__tests__/lane-pool-paths-under-test.test.mjs` (planned) |
| `we:scripts/lib/pr-snapshot-store.mjs` | `we:scripts/lib/__tests__/pr-snapshot.test.mjs` |
| `we:scripts/lib/pr-snapshot.mjs` | `we:scripts/lib/__tests__/pr-snapshot.test.mjs` |
| `we:scripts/lib/pr-facts.mjs` | `we:scripts/lib/__tests__/pr-facts.test.mjs` |
| `we:scripts/lib/salvage-index.mjs` | `we:scripts/lib/__tests__/salvage-index.test.mjs` |
| `we:scripts/lib/target-registry.mjs` | `we:scripts/__tests__/target-registry.test.mjs` |
| `we:scripts/lib/verdict-ledger.mjs` | `we:scripts/lib/__tests__/verdict-ledger.test.mjs` |
| `we:scripts/operations/ci-heal-pr-dispatch.mjs` | `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs` |
| `we:scripts/operations/dispatch-providers/probation-worker.mjs` | `we:scripts/operations/__tests__/probation-heal-run.test.mjs` |
| `we:skills-src/conveyor/verify-daemon.mjs` | `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs` |

- Helper matrix: empty bag, missing/empty markers, each marker alone, both markers, truthy strings, null-safe explicit input, and calls before/after environment mutation. Assert identical results through ESM import and CommonJS require, and no ambient fallback for `{}`.
- Bootstrap coverage: assert the neutral marker in the running Vitest worker; exercise the setup's stripping/restoration with mocked lifecycle registration in an isolated environment, including `WE_TEST_SANDBOX=0`. Verify preload assignment precedes its dynamic setup import and no longer assigns `VITEST`. These tests run under Node/Vitest; do not claim that a source-order assertion proves Bun execution.
- Parameterize consumer guard cases with legacy-only and neutral-only bags. For process-global consumers, explicitly remove the other marker and restore both afterward. Check test-default behavior and every existing explicit override, including fake-gh-only behavior for caches/logs and disabled/explicit-enable precedence for PR facts. Stub IO or use private temporary roots, never a live Worker, authenticated gh, host drain file, or real registry/ledger.
- Lane refusal: planned `we:scripts/lib/__tests__/lane-pool-paths-under-test.test.mjs` calls the pure resolver with only `WE_UNDER_TEST=1`, no override, and expects the existing real-pool refusal. Check explicit private root, deliberate opt-out, legacy-only marker, and marker-free production derivation without doing IO. Extend `we:scripts/__tests__/lane-pool-vitest-real-root-guard.test.mjs` to exercise neutral-only subprocess refusal from a temporary checkout/workspace and success against a private pool; clean temporary state in finally. Retain `we:scripts/__tests__/lane-pool-root-and-shallow.test.mjs` as path-derivation regression coverage.
- Add the inventory assertion to `we:scripts/lib/__tests__/under-test.test.mjs`: scan production JavaScript modules under `we:scripts/` and `we:skills-src/`, excluding test directories, and reject direct executable `VITEST` property reads outside `we:scripts/lib/under-test.cjs`. Cover optional chaining and bracket notation, and assert each inventoried consumer uses the shared helper. Comments may mention compatibility; unrelated Vitest configuration constants are not guards.

## Proof plan

1. Red before implementation: the new pure lane test must observe that neutral-only execution does not yet refuse; bootstrap coverage must observe a missing neutral marker. Keep this red proof confined to pure functions or a temporary workspace so the old code cannot inspect the host pool.
2. Green after implementation: run the helper, bootstrap, lane, and every mapped consumer test through the host heavy-run queue. Use `npm run test:unit --` followed by the repo-relative test arguments corresponding to the prefixed entries above; that script already queues the run. Include both existing lane regression files. Record selected file counts and pass/fail output; no bare test-runner command and no silent no-tests-selected success.
3. Independently rescan `we:scripts/` and `we:skills-src/` for direct `VITEST` reads, including optional/bracket syntax, excluding tests. The sole executable implementation is `we:scripts/lib/under-test.cjs`; the ESM facade only exports it. This corrects the old acceptance criterion that allowed only an ESM implementation despite the synchronous CommonJS consumer. Confirm Bun's preload no longer manufactures `VITEST`.
4. Run `npm run check:standards` through its existing heavy-admission wrapper and record its result. Inspect the final diff for preserved override ordering and the entire 19-site inventory. Preparation does not claim these future implementation checks passed.

## Done when

- **Executable:** the queued helper/bootstrap/lane tests above fail on the pre-change behavior and pass with the new marker; all mapped consumer regressions and the queued standards gate pass.
- **Must refuse:** neutral-only test execution with no explicit pool root or deliberate escape hatch throws the real-pool refusal before lane IO. Existing failure propagation, invalid launch-setting refusal, and production behavior remain unchanged.
- **Must isolate every input kind:** test fixtures representing source code, docs, configuration, or data receive the same marker-based protections; no filename or input-kind exception is introduced. Existing explicit overrides retain their current meanings.
- Both bootstraps establish the marker, all 19 guards use the shared predicate, and the source inventory test prevents direct runner-specific guards from returning. No Bun installation is needed to deliver this item.

## Follow-ups

The broader #5067 opt-in work remains separate: pinned Bun invocation and isolation flags, mock-factory compatibility, actual Bun execution, and full-suite measurements. This item removes one runner coupling; Node/Vitest proof does not establish Bun compatibility for the remaining shim APIs. Fixed shared scratch-directory names and stronger validation of explicit root overrides are unchanged and are not silently redesigned here.
