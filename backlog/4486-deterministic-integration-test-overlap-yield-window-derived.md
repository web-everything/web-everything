---
bornAs: xhbvu6t
kind: task
parent: "4075"
status: open
scope: ["we:scripts/conveyor/land-overlap-yield.mjs", "we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs", "we:scripts/conveyor/__tests__/land-overlap-yield-history.test.mjs"]
estimatedLoc: 260
dateOpened: "2026-09-29"
preparedDate: "2026-11-02"
preparedAgainstSha: "72bb0262baf5eb33807bdfca065b7aefdac5bcc0"
tags: []
---

# Deterministic integration test: overlap-yield window derived from main integration history

Follow-up from we:backlog/4314-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md, guard 2: a configuration commit created before the ready label but merged afterward must not retroactively lengthen that epoch's yield budget. Preserve the non-renewable budget and explicit operator override defined in we:backlog/4308-drain-lands-a-ready-pr-after-not-before-a-larger-overlapping.md.

## Progress

- Original premise: the missing guard was a linear sequence of config commits before/after the label; original scope included we:scripts/merge-ai-prs.mjs and we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs. That fixture alone does not exercise the reported late integration of an older side-branch commit.
- Corrected premise: we:scripts/conveyor/land-overlap-yield.mjs:422 uses path-filtered `rev-list --before` without first-parent traversal. It can traverse a side branch whose config commit predates the label even though its merge into main follows the label. Select a main integration snapshot first, then read its tree. The existing real-reader tests use fake Git output (we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs:395); the non-renewal test injects a canned reader (we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs:169). This guard is not delivered by those tests.
- Additional factual correction: we:scripts/conveyor/land-overlap-yield.mjs:281 implements the smaller-of-current-and-default fallback but emits no warning; we:scripts/conveyor/land-overlap-yield.mjs:416 likewise silently marks shallow evidence untrusted. The requested warning needs implementation, not merely an assertion against existing behavior.
- Corrected scope: retain the reader module and its unit tests; add we:scripts/conveyor/__tests__/land-overlap-yield-history.test.mjs for real repositories. Remove the drain source/test from the touch set: we:scripts/merge-ai-prs.mjs:223 imports the same compute function, and we:scripts/conveyor/land-overlap-yield.mjs:505–522 already creates a reader per planning pass and bypasses history for explicit window overrides. No caller signature or default change is required.
- Estimate: previously no estimatedLoc or size. Set estimatedLoc to 260: approximately 45 changed lines in we:scripts/conveyor/land-overlap-yield.mjs, 35 in we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs, and 180 in the new we:scripts/conveyor/__tests__/land-overlap-yield-history.test.mjs. The checked helper directory we:scripts/__tests__/lib/ contains spawn-timeout helpers, not a reusable Git-history fixture.

## Design

1. Keep `gitHistoryConfigAtReader` and `windowMsAtLabelTime` as the production seam. Resolve the latest first-parent commit of WE `origin/main` at or before readyAt, without a config-path filter, then read we:scripts/drain-overlap-yield-config.json from that exact tree. A merge commit's tree is authoritative even when it is TREESAME to its side parent. Do not choose a side-branch commit by its old author/committer date. Use `git rev-list --first-parent -1 --before=<readyAt> origin/main` without a path argument, then `git show` for the selected tree. Pin the inclusive second-resolution boundary with the real Git test. No persistent deadline store or new policy is needed.
2. Preserve trusted absent/malformed snapshot behavior: use the code default, currently 45 minutes (we:scripts/conveyor/land-overlap-yield.mjs:48), never search forward for a valid value. Preserve untrusted-history behavior: shallow, unreadable repository, or failed revision lookup yields min(current, default). This bounds the fallback; it is not proof of an exact historical deadline.
3. Add an injectable `warn` callback to the reader with stderr as its production default. Emit an actionable warning once per reader instance when history is untrusted, identifying the reason and the smaller-of-current-and-default fallback. Do not dump config contents. Keep memoization and return shape unchanged. Missing/malformed historical config retains the trusted default path.
4. Build hermetic real Git fixtures under the task's TMPDIR with explicit author and committer dates, local identity, disabled signing/hooks, argv-based execFileSync, bounded timeout/output, and cleanup in afterEach. Sanitize inherited Git location variables. Create `origin/main` locally with update-ref; no fetch or remote service is required. The main fixture has W1=10 at T0; a branch config W2=90 committed before T1; and a no-fast-forward merge at T2>T1. Include a later main commit before T1 so the fixture proves snapshot selection rather than only root selection. Assert the merge parents and timestamps as fixture preconditions.
5. Call the real reader with cwd only (no fake exec) and feed it to `windowMsAtLabelTime`. Check T1 before and after the merge using fresh reader instances. Feed the resulting window to `overlapYieldWaits` with an otherwise eligible pair at T1+11 minutes: no wait, even though current W2 would still hold it. Assert T2 sees W2. Keep explicit override and disabled behavior intact.

## MVP

Must deliver the late-merged side-branch regression, snapshot lookup correction, warning, and all historical fallback/boundary cases below. Keep the 45-minute default, CLI contract, label-time acquisition, and override precedence unchanged. No drain refactor, persistence, new settings, live GitHub calls, or shared fixture framework is needed.

## Test plan

Create we:scripts/conveyor/__tests__/land-overlap-yield-history.test.mjs with these named cases:

- `late integration cannot renew an expired epoch`: the non-fast-forward fixture above, fresh-reader restart, old 10-minute result at T1, new 90-minute result at T2, and no wait after expiry.
- `main snapshot boundary is inclusive`: a direct main commit and a merge commit each apply at their exact whole-second timestamp and not one second earlier; distinguish both values from current HEAD.
- `absent and malformed snapshots use the code default`: missing historical file, invalid JSON, and invalid window field, each followed by a valid wider config; historical lookup remains 45 minutes even with current=10.
- `shallow and unreadable history warn and bound the fallback`: create a real depth-one clone using a local file URL, assert Git reports shallow=true; also use a non-repository directory and a missing branch ref. Assert untrusted results, 10 minutes for current=10 and 45 for current=90, and one warning per reader across multiple lookups. Supply warnings to an array; do not mock Git.

Update we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs fake-command assertions for snapshot selection and warning deduplication. Retain the default/override assertions; add a computeOverlapContext assertion that explicit window override bypasses the reader lookup, and that disabled mode requires no history IO. Run the existing caller regression we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs unchanged.

## Done when

Acceptance commands below use this convention: execute repo-prefixed paths from the WE checkout after removing their `we:` locator prefix. Every test name refers to the new history test file unless stated otherwise.

- [A1] Executable — `late integration cannot renew an expired epoch` fails against the old reader and passes with snapshot selection, proving both historical window and caller-visible release after restart.
- [A2] Executable — `main snapshot boundary is inclusive` proves exact-time selection for main and merge commits. Run the named test against the old reader and against a strict-before mutation to capture the regression and boundary negative control.
- [A3] Executable — `absent and malformed snapshots use the code default` proves all three trusted fallback cases. Run against a mutation that reads current HEAD or substitutes current=10 for the default; it must fail, then pass with the final implementation.
- [A4] Executable — `shallow and unreadable history warn and bound the fallback` fails before the warning implementation and passes afterward, including unknown evidence and missing ref, with both sides of min(current,45) asserted.
- [A5] Executable — add these individually named cases in we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs and run them with the queued suite command in Proof plan:
  - `missing config preserves the enabled 45-minute default`: assert missing-file loading returns enabled=true and windowMinutes=45, and a trusted absent historical value produces exactly 2,700,000 ms without an explicit code-default argument. A mutation changing the shipped default must fail this case.
  - `explicit window override bypasses historical lookup`: give computeOverlapContext an eligible overlapping pair, a known ready timestamp, and an explicit 20-minute override while the historical fixture would return 90 minutes. Assert the wait deadline is readyAt+1,200,000 ms and zero calls to the returned configAt reader, observed through zero Git revision-lookup/show commands in the injected exec call log. Reader construction currently probes shallow status; that probe is permitted and is not a historical lookup. A mutation routing the override through configAt must fail this case.
  - `disabled overlap mode performs no history IO`: invoke computeOverlapContext with enable=false and an otherwise eligible pair. Assert settings.enabled=false, empty waits and skips, zero configAt reader calls, zero Git exec calls (including the shallow probe), and zero label-time ghExec calls. Use recording IO functions that throw if invoked so an early-return regression cannot silently pass. A mutation removing the disabled early return must fail this case.
  - Retain the unchanged caller regression in we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs, case `overlapContext: null (every pre-#4308 caller/test) changes NOTHING`, as an additional compatibility check. There is no changed default or CLI caller behavior to migrate. All three planned cases above must pass with the final implementation; record the named negative-control failures rather than claiming unchanged behavior failed on the baseline.

## Proof plan

Use the host heavy-run queue only. The executable suite command is `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npx vitest run we:scripts/conveyor/__tests__/land-overlap-yield-history.test.mjs we:scripts/conveyor/__tests__/land-overlap-yield.test.mjs we:scripts/__tests__/merge-ai-prs-overlap-yield.test.mjs` (remove locator prefixes as described above). Record red results for new regression tests against the old production module, then green results with the fix. Already-correct fallback guarantees use the targeted negative controls in Acceptance; do not claim they were broken on the baseline. Restore each mutation before proceeding. Record actual Git topology/timestamps and shallow status from fixture assertions, without wall-clock sleeps. Finally run `node we:scripts/readiness/heavy-admission.mjs run --wait-ms=60000 -- npm run check:standards`. If admission remains busy after the single bounded wait, stop and report the unavailable proof. The runner owns preparation stamping and review checks; this preparation does not claim a runtime test pass.

## Follow-ups

None required for this guard. Rewritten main history, intentionally backdated integration timestamps, and durable label-epoch storage are outside this contract; the fixture proves ordinary main integration history with controlled committer timestamps. If operational evidence demands those stronger guarantees, file a separate policy/storage item rather than extending this task silently.
