---
bornAs: xxa8ti1
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-tick-speed.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "bdcf17b75673b6d6f0673952f1c89b5d81c93973"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2981's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

The remaining guards are dry-run/live WIP-count parity and conservative WIP accounting when builder attribution cannot be read. Review requests 2 and 3 describe one failure-path guard, not two separate mechanisms. Current source locations and the corrected counting contract are recorded below.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2981@bef8e3972fcde5e026e7ca0c8e8aecc08074f6df

## Progress

Preparation research on 2026-11-18 confirms the guard remains outstanding. No implementation or new stamp is made here.

- **Old premise/scope:** the prior preparation targeted two independently failing readers, cited the dry-run at line 1332 and live caching at line 1452, and scoped only the daemon and its main test. Those locations and the independent-reader premise are stale.
- **Corrected premise/scope:** `we:skills-src/conveyor/build-dispatch-daemon.mjs:1760` now owns the shared `readDispatchLaneRunRecords` scan. It swallows listing errors and skips unreadable records before either reader can observe failure. The wrappers at `we:skills-src/conveyor/build-dispatch-daemon.mjs:1774` and `we:skills-src/conveyor/build-dispatch-daemon.mjs:1811` consume that snapshot; dry-run caching starts at `we:skills-src/conveyor/build-dispatch-daemon.mjs:2953` and live caching at `we:skills-src/conveyor/build-dispatch-daemon.mjs:3103`. Carry status from the scan, not merely from wrappers. Add the existing shared-read regression file to scope.
- **Source evidence:** the tick still derives an attribution set unconditionally at `we:skills-src/conveyor/build-dispatch-daemon.mjs:808`; the hypothetical report does so at `we:skills-src/conveyor/build-dispatch-daemon.mjs:2979`. The report re-fetches PRs and claims at `we:skills-src/conveyor/build-dispatch-daemon.mjs:2968`, so sharing the derivation alone does not establish snapshot parity. No exported report assembly seam exists.
- **Tests/callers:** `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:744` covers successful worker exclusion; its helper tests start at line 763, and real ENOTDIR expectations at lines 1616 and 1654 retain empty-array behavior. `we:skills-src/conveyor/__tests__/build-dispatch-tick-speed.test.mjs:20` covers shared reads and prepare compatibility; its “unreadable” case at line 67 actually supplies a missing directory, which is an ordinary empty store under `we:scripts/operations/run-store.mjs:198`. Add a genuine ENOTDIR fixture rather than relabeling missing storage as failure. Corrupt records throw under `we:scripts/operations/run-store.mjs:163`.
- **Counting correction:** `we:scripts/conveyor/build-dispatch-policy.mjs:275` accepts null attribution and counts recognizable delivered item numbers once, excluding borrowed fixes from the in-flight WIP union. It does not count raw PRs or PRs without item references. Preserve this existing contract; the policy is evidence, not an implementation target.
- **Additional caller:** queue pruning receives run rows at `we:skills-src/conveyor/build-dispatch-daemon.mjs:628`, before the main normalization point at line 641. Normalize before every array consumer, including this caller; preserve prepare-item array returns.
- **Sizing:** retain story size 3. The bounded touch set is one daemon (approximately 140–200 changed lines for status propagation and report extraction), its main test (approximately 140–200 lines), and its existing shared-read test (approximately 40–70 lines). Evidence is the scanner, two shell assemblies, and three existing regression groups cited above. No new policy or implementation file is required.

## Design

Implement the review's specified fallback in `we:skills-src/conveyor/build-dispatch-daemon.mjs`. Add an opt-in status result to the shared scanner and both readers: with `withStatus: true`, return `{ rows, readFailed }`; otherwise retain the existing array return for prepare-item and older callers. At the scanner, mark `readFailed` on a thrown directory listing or individual record read, retaining all successfully read rows. Both wrappers accept either legacy record arrays or the status-bearing snapshot and propagate its failure bit. Do not rescan a supplied snapshot. A missing directory remains successful empty storage under the existing run-store contract. Successful empty reads remain distinguishable from failures.

Have the live and dry-run build shells request status results and inject them intact. Normalize legacy array effects as successful reads before queue pruning and all other tick consumers; unwrap rows for bookkeeping while retaining status for attribution. Keep the default reader return as an array, and opt live/dry-run build callers into status explicitly. Prepare callers receive the shared rows without changing their failure policy. Use the successful rows for existing in-flight and settlement bookkeeping. Derive attribution through one shared adapter: return null when either build read failed, otherwise call `deriveDispatchedByBuilder` with the two row arrays. Both planning paths must use this adapter. Do not replace failure with an empty set or discard successful in-flight rows. Update the daemon's fail-direction comments to describe this change.

Extract `buildDryRunReport` as an exported, injected assembly seam used by the actual dry-run CLI. Inject the existing external reads, route prediction, policy, focus, and clock; keep stdout formatting in the CLI shell. Return enough assembly evidence for tests to inspect the tick plan, hypothetical `ifFreed` plan, and rendered report without duplicating the planner in the test. Reuse the tick’s effective pre-planning accounting inputs (after claim retirement/recovery), including PRs, in-flight claims, build-reader results, borrowed fixes, fix claims, main-red freeze and kill-switch state, for the hypothetical plan; their candidate sets may differ, but their pre-dispatch open-item union must agree. Keep the public JSON/text report shape stable.

This is a bounded daemon correction using the planner's existing null behavior. It does not change attribution on successful reads, global PR caps, or prepare-item failure policy.

## MVP

1. Add and document the opt-in reader status contract, including partial-read failure, in `we:skills-src/conveyor/build-dispatch-daemon.mjs`.
2. Carry it through live and dry-run shell caching into the shared attribution adapter and tick planner call. Preserve legacy array effects and prepare-item consumers.
3. Extract and wire the report assembly seam, sharing the captured accounting inputs between both plans.
4. Extend `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` with real-reader error observations, live-tick no-dispatch guards, and report parity regressions. Retain existing success-path attribution tests.

## Test plan

Tick/report tests live in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs`; scanner and snapshot compatibility tests live in `we:skills-src/conveyor/__tests__/build-dispatch-tick-speed.test.mjs`.

- Reader matrix: successful empty store, valid in-flight/settled records, ENOTDIR using a file as the run-store directory, and a corrupt dispatch record alongside a valid record. Exercise each reader with status enabled; assert failures are explicit and successful rows survive. Preserve array-mode compatibility and prepare-item tests. Restore temporary directories and environment after each case.
- Tick matrix: fail only the in-flight attribution read, only the settled read, and both. Seed open builder PRs at `maxOpenItems`, leave concurrency/global-PR/scope gates permissive, enable the tick's live branch with injected dispatch spies, and assert zero dispatch calls plus `wip-cap` holds naming the counted items. Feed real-reader failure results into at least one case rather than constructing every sentinel by hand.
- Union semantics: include duplicate PR delivery references, an in-flight item also delivered by a PR, a worker-owned PR, and a PR without an item reference. On failure count recognizable item numbers once without the ownership filter. On a successful empty read continue excluding worker PRs; on successful attribution count builder items only.
- Report seam: with the same builder/worker fixture, assert `ifFreed.openItems` equals the tick plan's open-item count and numbers, and the report's `filling` matches those numbers. Repeat on read failure and with a core-capacity-held candidate so the hypothetical path actually runs. Assert item hold reasons agree with the headline count and that assembling the report invokes no dispatch effects.

## Proof plan

During implementation, add the regression cases first and record their failure against the old behavior: errors are indistinguishable from empty success, or a capacity-full tick dispatches. For the report seam, prove the wired CLI assembly path is tested, not just the attribution helper; temporarily removing attribution from only the hypothetical planner call must fail the worker-PR parity assertion. A missing export alone is not behavioral proof.

Run the affected tests through the host queue using the commands defined below. These commands use shell variables so every authored file reference retains its repository prefix; strip `we:` only when passing a path to Node/Vitest. Run from the WE checkout. Temporary stores belong under the task's `$TMPDIR`. If admission is busy, use its supported bounded wait once, then stop and report; do not poll.

```sh
queue=we:scripts/readiness/heavy-admission.mjs
main=we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs
shared=we:skills-src/conveyor/__tests__/build-dispatch-tick-speed.test.mjs
node "${queue#we:}" run -- npx vitest run "${main#we:}" "${shared#we:}"
node "${queue#we:}" run -- npm run check:standards
```

These are future implementation checks, not tests claimed as completed by preparation. The runner owns preparation checks and stamping.

## Acceptance

The named tests below are to be added to the scoped test files and run with the queued focused command above. Each must demonstrate a behavioral failure before implementation and pass afterward; a missing export is not sufficient red evidence. Compatibility assertions accompany a new status assertion so the regression fails on the old code without weakening historical expectations.

- [A1] Executable: `status survives shared scan failures` in `we:skills-src/conveyor/__tests__/build-dispatch-tick-speed.test.mjs` exercises real ENOTDIR, corrupt-plus-valid records, successful empty and missing stores, and verifies both wrappers preserve failure status and valid rows from one scan. Assert scan/read call counts, legacy array defaults, and prepare-item compatibility in the same matrix.
- [A2] Executable: `unreadable attribution holds live dispatch at WIP capacity` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` feeds real scanner failure into a live tick, plus isolated in-flight/settled/both failure variants. With other gates permissive, assert zero dispatch calls, a `wip-cap` reason and exact counted numbers. Include duplicate delivery refs, worker PRs, unknown-item PRs and borrowed fixes; successful-read controls retain builder-only attribution. This tests the conservative fallback and its operator-visible hold reason.
- [A3] Executable: `status-aware cached reads preserve queue pruning and prepare callers` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` enables pruning and prepare work with partial read failure. Assert pruning receives an array containing surviving rows, prepare bookkeeping retains its prior behavior, and the build plan still uses conservative attribution. Exercise the shared snapshot wiring used by both CLI shells, not only a hand-built sentinel.
- [A4] Executable: `dry-run assembly shares effective WIP inputs with tick` in `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` drives the exported assembly used by the CLI with successful and failed attribution, changing-on-second-read effects, retired claims and a capacity-held candidate. Assert identical pre-dispatch counts/numbers in tick and hypothetical plans, matching report `filling` and hold reasons, stable public report fields, and no dispatch effects. Removing attribution from only the hypothetical call or restoring a second accounting read must fail this test.

## Follow-ups

No additional policy decision is needed for the requested fallback. Broader run-store recovery, prepare-item failure behavior, and new operational alerting are outside this guard. If implementation exposes a separate defect in those areas, record it separately; do not broaden this card into a run-store redesign.
