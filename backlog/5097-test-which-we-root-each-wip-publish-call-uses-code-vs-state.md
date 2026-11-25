---
bornAs: xt3nuuf
kind: story
size: 2
status: open
scope: ["plateau:src/wip/wip-publish-roots.test.ts", "plateau:src/wip/lane-map.test.ts", "we:scripts/__tests__/lane-pool-publisher-roots.test.mjs"]
dateOpened: "2026-10-04"
preparedDate: "2026-11-25"
preparedAgainstSha: "aa8022d9550eecd534262364f6222bc0b7e852d2"
tags: []
---

# Test which WE root each wip-publish call uses (code vs state)

Follow-up from plateau #204's advisory review, approved by the operator 2026-10-04. Defend the publisher's actual code/state routing with script-level tests and prove lane-path parity for two checkouts sharing the same pool identity. This is regression coverage, with no root-default or fallback policy change.

## Progress

- Original premise/scope: all watches and ask-session cwd use STATE, everything else uses CODE; broad implementation touch set was `plateau:scripts/wip-publish.ts` plus `plateau:src/wip/`, with no named tests.
- Corrected premise: `plateau:scripts/wip-publish.ts:71` passes both roots to the decision cache; lines 92–98 watch CODE operation directories, both CODE and STATE backlogs, and STATE conveyor state. Lines 214–218 and 274–276 read the lane map from STATE, resolve the lane through CODE, ask in the lane when available (otherwise STATE), and send fork notes to STATE plus the optional lane. Lines 151–166, 207 and 231 route telemetry, intake's WE operations, feeds, graduation and dispatch through CODE. Plateau-owned operations retain their own repository root, including intake's model cwd at line 160.
- Evidence of the remaining gap: `plateau:src/wip/we-roots.test.ts:16` tests root selection, and `plateau:src/wip/lane-map.test.ts:28–49` tests a single-root resolver with mocked CLI output. Neither exercises publisher wiring or real two-checkout CLI parity. `plateau:src/wip/decision-forks-source.ts:51–65` separately consumes STATE for the map and CODE for lane resolution.
- Parity is conditional, not universal: `we:scripts/lib/lane-pool-paths.mjs:79–81` derives the pool parent from the workspace or override; `we:scripts/lane-pool.mjs:458–496` derives the pool name from origin unless explicitly selected. The two checkouts must share workspace/pool override and origin-derived identity. `we:scripts/lane-pool.mjs:4886–4891` refuses invalid lane numbers and absent lane directories.
- Corrected scope is tests only: add the publisher script harness and CLI parity suite, extend the existing lane resolver test with cwd assertions. No production extraction is necessary for this coverage goal. Keep size **2**: approximately 160 changed lines in `plateau:src/wip/wip-publish-roots.test.ts`, 25 in `plateau:src/wip/lane-map.test.ts`, and 90 in `we:scripts/__tests__/lane-pool-publisher-roots.test.mjs` (about 275 total). The script's importable dependencies and captured agent callbacks provide the harness seam; the existing resolver already accepts injected exec (`plateau:src/wip/lane-map.ts:56`).

## Design

Exercise the real `plateau:scripts/wip-publish.ts` module in a Vitest node-environment harness. Mock its external effects before dynamic import, capture createAgent options and source/watch registrations, then invoke the actual registered ask and handler callbacks. Use distinct synthetic CODE, STATE, lane and Plateau roots so a swapped argument cannot pass accidentally. Mock networking, process exits, timers, file writes, child processes and stop signals; abort and restore them after each import. Do not duplicate the routing expressions in a test-only helper or settle for source-string matching.

Assert the full WE-root boundary: decision-cache options, snapshot reads, telemetry, feeds, intake WE root, graduation, dispatch cwd, lane-map reads, lane resolution, note writes and watches. Assert Plateau-owned roots separately where the same constructors receive both. Test distinct roots and coincident roots; preserve watch deduplication. Feed the existing root resolver's default, explicit split and legacy WE_ROOT configurations through this harness, retaining the existing precedence suite unchanged.

For parity, create two small local Git checkouts under a task-temporary workspace with the same synthetic origin URL and one private pool containing a lane directory. Execute the actual `we:scripts/lane-pool.mjs` path command from each checkout, using an explicit private LANE_POOL_ROOT and scrubbed inherited Git/pool identity variables. Pure assertions against `we:scripts/lib/lane-pool-paths.mjs` also pin default workspace derivation for primary and control-clone layouts, so the override cannot mask that contract. No network, acquisition, real-pool scans or live publisher is needed.

## MVP

1. Add `plateau:src/wip/wip-publish-roots.test.ts` to capture the real publisher's registrations and assert the routing matrix, defaults and existing fallback behavior.
2. Extend `plateau:src/wip/lane-map.test.ts` to assert CODE cwd, argv and timeout; run the resolver for two roots with an exec spy that verifies cwd rather than blindly returning equal paths.
3. Add `we:scripts/__tests__/lane-pool-publisher-roots.test.mjs` for actual CLI parity, pure default-path checks, missing lane refusal and a different-origin negative control. Production files are read-only dependencies of this test-only touch set.

## Acceptance

- [A1] Executable — planned test `publisher routes every WE consumer to its designated root` in `plateau:src/wip/wip-publish-roots.test.ts` covers every caller enumerated in Design, both lane-map call sites, both note destinations, and all watch directories. The named test is absent before this build and must pass afterward; swapping either STATE call to CODE must make it fail.
- [A2] Executable — planned tests `publisher preserves root defaults and legacy pins` and `publisher falls back only to STATE when no lane resolves` in `plateau:src/wip/wip-publish-roots.test.ts` pin default/legacy/explicit roots, coincident-root watch deduplication, missing/unreadable/malformed maps, absent entries, rejected CLI calls and empty CLI output. No stale CODE map is consulted; ask cwd falls back to STATE and notes have no lane destination. These named cases are absent before the build and pass afterward. This preserves existing tolerant behavior, not a new refusal of all asks.
- [A3] Executable — planned test `resolver uses each supplied code cwd` in `plateau:src/wip/lane-map.test.ts` pins node argv, cwd and the existing ten-second timeout for both roots; invalid lane input does not spawn. This cwd-sensitive case is absent before the build and passes afterward; replacing cwd with STATE fails it.
- [A4] Executable — planned tests `primary and control clone resolve the same shared lane`, `different origins do not imply parity`, and `missing lane refuses without mutation` in `we:scripts/__tests__/lane-pool-publisher-roots.test.mjs` exercise the real CLI and pure default derivation. They are absent before the build and pass afterward. Unknown lanes exit nonzero with no path; the operator-visible error remains intact, and no directory is created as a fallback.

## Test plan

Run only the three scoped test files via the host heavy-admission queue. For Plateau tests, invoke the WE admission entry point with the Plateau checkout as cwd and use its installed Vitest; for the WE test, run from the acquired WE checkout. Command shape: node (the resolved `we:scripts/readiness/heavy-admission.mjs`) run --wait-ms=60000 -- npx vitest run (the repo-relative test filenames named in Acceptance). Resolve repository-prefixed references to actual paths at invocation; the prefix is documentation, not a shell filename.

Use task TMPDIR for every fixture; clean up in finally/afterEach. Bound child output and timeout, stub all publisher side effects, and prohibit any real model invocation or relay connection. On queue contention wait once using admission's own wait budget, then report unavailable capacity. Existing `plateau:src/wip/we-roots.test.ts` remains supporting evidence, not a substitute for script wiring coverage.

## Proof plan

Record the new named cases missing before implementation and passing afterward; this is a coverage-only item, so baseline production behavior is expected to be correct. Demonstrate sensitivity with temporary mutations: swap each publisher STATE argument to CODE, omit either backlog watch, route lane resolution to STATE, and derive the CLI pool from the checkout basename. Each relevant acceptance test must fail; restore mutations before the final queued run. Capture CLI stdout/status for both synthetic checkouts and the missing-lane refusal. Do not claim equal stubbed output proves real CLI parity. Confirm the final diff contains tests only and no default or caller behavior changes.

## Follow-ups

No new blocker is proposed. Root relocation, alternate-origin deployments, changes to malformed-state policy and broader daemon-watch ownership are separate work if requested. This item pins the observed behavior; it does not migrate state, alter the shared lane pool, or redesign publisher startup.
