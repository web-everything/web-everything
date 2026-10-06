---
bornAs: x04n3j9
kind: story
size: 3
parent: "4075"
status: open
scope: ["plateau:src/wip/progress-policy.ts", "plateau:src/wip/progress-policy.test.ts", "plateau:src/wip/progress-read.test.ts", "plateau:src/wip/wip-read.ts", "plateau:src/wip/wip-read.test.ts"]
dateOpened: "2026-10-01"
preparedDate: "2026-10-06"
preparedAgainstSha: "552ff72a38cc675862587afaa0c289a793efdf4f"
tags: []
---

# Prevention — old-mtime policy observations stay fresh through readWip

Filed mechanically from the approval of chalbert/plateau-app#189. This story prepares the named old-mtime contract regression and its observation-time fix. The other bundled prevention findings remain recorded under Follow-ups.

Idempotency key (do not edit): approval-prevention-key:chalbert/plateau-app#189@cb0c434e395bd347dcbf7709b50526d3197ffe77

## Progress

- Preparation inspected Plateau App commit `2e9ae55b4460693ff54294cadf958e065de44e7e`. Old premise/scope: seven review findings were bundled under a freshness-test title, all assigned to WE, with nonexistent test paths under `we:src/wip/__tests__/` and old parser citations at `we:src/wip/progress-read.ts:105` and `we:src/wip/progress-read.ts:136`. There is no WE WIP source tree in this checkout. These were incorrect repository assignments, not evidence the goal disappeared.
- Corrected premise/scope: the policy parser is now `plateau:src/wip/progress-policy.ts:33`, re-exported by `plateau:src/wip/progress-read.ts:81`. Its return still derives observation time from mtime (`plateau:src/wip/progress-policy.ts:73`); the reader passes mtime and returns the cached observation unchanged (`plateau:src/wip/progress-policy.ts:84-94`). The production integration is `plateau:src/wip/wip-read.ts:461`, using the tick clock established at `plateau:src/wip/wip-read.ts:385`. The existing integration test injects a policy already dated now, so it cannot catch this defect (`plateau:src/wip/wip-read.test.ts:549-573`). This is not already delivered.
- Scope now contains the two implementation files and their existing colocated TypeScript tests, plus the existing cache-regression suite `plateau:src/wip/progress-read.test.ts:119`. The model consumes the policy observation without needing a new schema (`plateau:src/wip/wip-model.ts:348-362`). Narrow to the title's contract; retain independent prevention debts below. Size remains **3**: clock propagation, cache semantics, and an integrated filesystem regression within the existing reader interfaces. No dependency change proposed.
- Research was source inspection, not execution of the proposed regression. Preparation changes only this card; stamping and checks belong to the runner.

## Design

Use the current read tick as the policy observation, independently of the plan's modification time. In `plateau:src/wip/progress-policy.ts`, rename the third `readPolicy` argument to `observedAtMs`, and add a tick argument to the returned policy-reader function after the existing path and selection arguments (defaulting to the current clock for existing callers). In `plateau:src/wip/wip-read.ts:461`, explicitly pass the already captured `nowMs` to the production reader.

Keep mtime, size, path, and selection as cache identity only. A successful stat/cache hit revalidates the unchanged selected content: return and cache a fresh policy object with the current observation, without rereading or rehashing the text. A successful changed-file read parses with the same tick time. Do not mutate objects returned to earlier snapshots. On stat/read failure, retain the last successful observation and selected content with unavailable status, as the existing fallback does; never refresh failed observations or leak a previous selection. Revision, effective date, publication selection, and conflict handling keep their current semantics.

The contract test must traverse the real production policy branch of `readWip`; supplying a prebuilt policy through `progressIO.policy` would bypass the defect. Stub unrelated subprocess/network adapters using the existing integration fixture. No new public snapshot fields or model changes are needed.

## MVP

1. Add deterministic clock and cache tests in `plateau:src/wip/progress-policy.test.ts`; retain and adapt the cache regression in `plateau:src/wip/progress-read.test.ts` if its call signature needs updating.
2. Add a temporary-file contract regression in `plateau:src/wip/wip-read.test.ts` using an allow-listed policy heading, an mtime well beyond the freshness threshold, and a fixed `nowMs`. Leave the policy injection unset.
3. Implement tick propagation and successful-cache-hit observation renewal in `plateau:src/wip/progress-policy.ts` and `plateau:src/wip/wip-read.ts`. Deliver these as one Plateau App implementation change with its matching tests.

## Test plan

- `plateau:src/wip/progress-policy.test.ts`: old mtime plus explicit current tick produces the current observation. On a second successful cache hit at a later tick, observation advances, revision and text stay stable, read/hash counts stay at one, and the first returned object retains its timestamp. A subsequent failure preserves the second successful observation with unavailable status. Changed selections, missing files, oversized files, conflicts, and effective dates retain existing behavior.
- `plateau:src/wip/wip-read.test.ts`: create and clean up a unique temporary plan, set its mtime at least one day before the fixed tick, pass its path and explicit headings to `readWip`, and assert both policy and source observations equal that tick. Assert `sources.policy.status` is not `stale` and the selected content is present. Repeat at a later tick without changing the file, then remove the file and verify the unavailable fallback has not been refreshed. Exact equality is stronger than the original one-tick tolerance and prevents a not-stale-only false positive.
- `plateau:src/wip/progress-read.test.ts`: rerun existing publication-boundary and metadata-cache tests to detect parser/cache regressions. Stub external reads; no live GitHub calls or operator plan contents.

## Proof plan

Run each named test file individually through the host queue using `we:scripts/readiness/heavy-admission.mjs` with the test process working in the acquired Plateau App checkout. The command shape is `node <absolute path to we:scripts/readiness/heavy-admission.mjs> run -- npx vitest run <Plateau-relative test path>`; resolve the prefixed paths above to that checkout's local paths when executing.

Capture red evidence before implementation: the old-mtime integration assertion must fail because the observed timestamp is the old file date, not because of missing fixtures or unrelated subprocesses. Capture green evidence after implementation for all three scoped test files, including the cache-hit and failure cases. Run the WE card consistency gate through the host queue (`node <absolute path to we:scripts/readiness/heavy-admission.mjs> run -- npm run check:standards` from WE). The preparation runner owns that gate and the stamp for this card. Record exact commands and results in the implementation review; no rendered UI change is needed for this timestamp contract.

## Done when

- An old-mtime plan read through the production `readWip` policy branch has the current tick's observation and is not reported stale solely due to mtime.
- Successful unchanged-file reads advance observation without rereading content; failed reads preserve the last successful observation and report unavailable.
- The contract regression fails on the original implementation and passes with the fix, with cache/privacy regressions passing through host admission.

## Follow-ups

The approval bundled these independent guards; they are preserved here, not silently treated as delivered or prerequisites of the timestamp fix:

- Publication boundaries: the old parser citation is superseded by `plateau:src/wip/progress-policy.ts:5-51`. Explicit heading selection and ancestor/fence boundaries already exist; non-ATX cases are already tested at `plateau:src/wip/progress-read.test.ts:47`. Reassess the residual publish-fence/secret-pattern proposal against that coverage before defining additional policy.
- Timeout cancellation: `plateau:src/wip/wip-api.ts:33-36` still races a deadline without cancellation, and `plateau:src/wip/wip-api.ts:55-67` clears the slot after failure. A separate change must propagate cancellation to actual child execution and bound orphaned reads, with coverage in `plateau:src/wip/wip-api.test.ts` and `plateau:src/wip/wip-read.test.ts`. A general timeout review/lint lens is separate tooling scope.
- Shared contract fixture and duplicate-large-fixture guard: the fixture remains embedded at `plateau:src/wip/wip-source.test.ts:43` and in `plateau:src/wip/wip-view.test.ts`. Extraction and a standards-gate duplication detector remain separate work, as the original review explicitly stated.
- Held renderer regression: retain the original request for held count, description, owner, and next step in `plateau:src/wip/wip-view.test.ts`; the current model intentionally exposes an unavailable hold projection (`plateau:src/wip/wip-model.ts:358`). Establish the applicable held contract before asserting missing runtime behavior is implemented.
- Duplicate-data/TDD guard: the existing distinct-logical-work test at `plateau:src/wip/progress-read.test.ts:25` is evidence to audit, not proof that every duplicate-input case is covered. A repository-wide semantic review or TDD enforcement rule is outside the clock fix.
- CSS duplicate-property lint: the repeated `overflow-wrap` remains at `plateau:src/wip/wip-view.css:144`. Preserve the proposal for a CSS lint guard and its own linter fixtures as separate tooling work.
