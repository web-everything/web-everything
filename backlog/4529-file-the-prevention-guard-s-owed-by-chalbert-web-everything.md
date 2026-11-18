---
bornAs: xkvqtrc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "32fbad6f48ce3ccdfd1df70dd42ba1a5da64cf96"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2974's independent review

Filed mechanically on approval to track two prevention debts: snapshot-enabled listing cost, and discovery of a requested-base candidate behind more than OPEN_PR_LIST_LIMIT off-base PRs. Preserve both goals; the current implementation requires the corrected design below.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2974@231c3429288e74c55e0a4b1bfd364a20f379218d

## Progress

- **2026-11-18 premise correction:** the previous preparation assumed all candidate listings used sized `gh pr list` calls and proposed one live call with identical fields in warm/cold modes. Current `we:scripts/merge-ai-prs.mjs:5700-5732` uses live GraphQL pages plus snapshot-seeded body/files hydration for a resolved slug; sized listing survives only when identity cannot be resolved. Context reuses the live rows at `we:scripts/merge-ai-prs.mjs:5308-5329`. The old citations to lines 3851/4137 and the previous preparation's 3898/4124 are superseded by these references.
- **Remaining debt, source evidence:** paging already exists, but `we:scripts/lib/pr-list-paged.mjs:276-291` stops at maxRows and reports truncation; the drain supplies OPEN_PR_LIST_LIMIT at `we:scripts/merge-ai-prs.mjs:5724`. Operator selection occurs afterward at `we:scripts/merge-ai-prs.mjs:5747`. Thus paging alone does not establish discovery beyond 500. Existing helper tests cover snapshot seed reuse (`we:scripts/lib/__tests__/pr-list-paged.test.mjs:551-568`), but the CLI cost harness still has no GraphQL handler and creates a repository without an origin (`we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:41-61`, `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:128-158`). Its existing oversized case puts the candidate first, not beyond the cap (`we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs:217-233`). These are source observations, not claimed execution results.
- **Scope correction:** old scope named `we:scripts/__tests__/merge-ai-prs.test.mjs`; corrected scope names the actual listing harness, `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs`, alongside `we:scripts/merge-ai-prs.mjs`. Read and reuse `we:scripts/__tests__/fixtures/open-pr-page-fixture.mjs:2-30`; no shared helper change is needed. Keep size **3**: approximately 60–90 changed source lines plus 180–240 harness/test lines across those two files. This is a story; no estimatedLoc is added. Existing preparation stamps are left untouched for the runner.

- **Validation repair (2026-11-18):** the publish scrubber flags the snapshot TTL environment-variable identifier in the design as an opaque token. Replace that identifier with a prose description of the same setting; the preparation's scope and guarantees remain unchanged.

## Design

1. **Measure the current snapshot path.** Extend the existing harness to log GraphQL page calls, heavy-field views, and legacy list calls separately. Reuse `we:scripts/__tests__/fixtures/open-pr-page-fixture.mjs` to serve cursor pages. Add a resolved-repository mode while retaining the no-origin mode. Keep all auth, snapshot, throttle and fixture state under the task temporary directory, with the existing synthetic auth helper. Use an explicit repo and a small nonempty fixture with deterministic updatedAt/head SHA and no checks requiring unrelated app lookups. Compare snapshots explicitly disabled (`WE_PR_SNAPSHOT=0`) with explicitly enabled and warm in WE_PR_SNAPSHOT_DIR. Seed the versioned format from `we:scripts/lib/pr-snapshot-store.mjs:17-18`, with matching body/files, current fetchedAtMs, a generous snapshot TTL override and no dirty marker. Both modes must list the live open set once per pass; cold hydrates each row and warm hydrates none. Neither may re-list the swept repo for context. Candidate results must agree. Include a changed-head seed case requiring fresh hydration: warm data is an optimization, never open-set authority.
2. **Bounded requested-base rescue on truncation.** In `we:scripts/merge-ai-prs.mjs`, after either live listing path reports truncation, and only when an explicit base is requested, issue one supplementary `gh pr list --base <base> --limit OPEN_PR_LIST_LIMIT` using the existing throttled execution path, repo selection and RECONCILE-dependent field selection. Carry no server-side label/search flag. Parse with the existing strict list parser and resolve listed checks as for primary rows. De-duplicate the union by PR number for candidate selection, then apply the existing operator predicate. Preserve primary raw rows, truncation and `complete:false` for context and state pruning; a filtered rescue cannot prove the base-blind inventory complete. Do not substitute the filtered union for context rows or clear the DEGRADED warning.
3. **Refuse incomplete rescue evidence.** A thrown read, invalid response, or rescue page at the cap is a listing failure for that repository, not an empty or complete candidate set. Include the requested base and the bound in its diagnostic; direct operators to inspect the oversized base manually or retry after reducing the queue. Propagate through the existing per-repo listing failure handling (`we:scripts/merge-ai-prs.mjs:5774-5781`), including exit 4 when every repo fails. The rescue adds at most one list invocation per repo per pass, and does not run for an untruncated listing, no explicit base, or round-snapshot candidate evidence. No settings/defaults or shared paging semantics change.

## MVP

Implement the two-file change: modernize the harness, add the warm/cold cost regression and the past-cap CLI regressions for both resolved and unresolved identities, and implement the bounded rescue with fail-closed errors. Keep base-blind context and existing no-base behavior. A candidate being discovered does not authorize merging with incomplete context; assert discovery separately from merge eligibility.

## Acceptance

Commands below run from the WE checkout. The shell removes the visible repository prefix to produce executable local paths. Use this queued command, with the named test filter substituted for TEST_NAME:

```sh
queue=we:scripts/readiness/heavy-admission.mjs
caseFile=we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs
node "${queue#we:}" run -- npx vitest run "${caseFile#we:}" -t 'TEST_NAME'
```

- [A1] **Executable** — run the queued command with `4529 past-cap base discovery`: 501 off-base PRs followed by one labelled requested-base PR, for both resolved GraphQL and unresolved legacy paths; require considered=1, no duplicate candidate, and exactly one rescue call. These cases must fail against pre-build source and pass with the fix.
- [A2] **Executable** — run the queued command with `4529 snapshot cost and freshness`: disabled/warm parity, one live page sequence per pass, cold N versus warm zero heavy-field reads, and changed-head rehydration. This is a regression guard for existing behavior, not a claimed current runtime defect. Prove RED by temporarily removing snapshot seed forwarding, then GREEN after restoring it; also force a redundant context listing and prove the call-count assertion catches it. Do not misrepresent a passing baseline pin as a failing baseline test.
- [A3] **Executable** — run the queued command with `4529 rescue failure closes repo`: throwing, malformed, non-array and cap-sized rescue responses must report an unreadable repository and exit 4 in a single-repo fixture; no merge or label mutation. The capped fixture must show the operator escalation diagnostic. These new rescue-path guarantees fail on pre-build source and pass after implementation.
- [A4] **Executable** — run the queued command with `4529 rescue preserves context and defaults`: rescued candidates are considered while raw context remains off-base-inclusive, truncated and incomplete; filtered evidence never prunes persisted stuck-unknown state. Assert unchanged call counts with no base, below cap, and round-snapshot evidence; exercise RECONCILE on/off field selection and label exclusion. The rescue branch fails before the build and passes afterward; prove the unchanged-path guards go RED with deliberate unconditional-rescue or filtered-context mutations before restoring GREEN.

## Test plan

Implement the named Acceptance groups in `we:scripts/__tests__/merge-ai-prs-listing-dedupe.test.mjs`. Teach the legacy fake to filter by base before applying limit; reject unexpected write operations and log all reads. Serve GraphQL cursors using the existing shared fixture, and return requested body/files for hydration. Use fixture files rather than oversized environment variables. Retain existing assertions instead of weakening them to accommodate the new production path. Disable or explicitly account for the empty-result repoll when measuring per-pass cost. Test both exact-cap and above-cap rescue results, plus a duplicate row appearing in primary and rescue lists.

Run the entire affected test file through the same queue command without the test-name filter after targeted cases pass. No real GitHub calls are needed. The helper seed tests are supporting evidence, not a substitute for driving the CLI caller.

## Proof plan

The builder records the local pre-build commit and runs the new tests against that source before changing it: A1 and A3 must demonstrate the missing rescue, not fail because the fake CLI cannot serve GraphQL. Then capture GREEN output from the same fixtures after the fix. For existing-behavior pins in A2/A4, record explicit temporary mutation diffs and failing assertions, restore the production source, and rerun GREEN. Record command logs split into live pages, hydration, rescue and context reads so a hidden extra call cannot be mistaken for a saving. Verify the final diff contains no proof mutations. This preparation edits documentation only; execution and stamping belong to the runner/build, and no test execution is claimed here.

## Follow-ups

- General base-blind inventory traversal beyond the current cap, with an explicit total call budget and escalation, remains outside this bounded rescue.
- Label-only past-cap discovery remains outside this item; never reintroduce search-backed label listing as a shortcut.
- Snapshot-authoritative context is not an optimization proposed here: current callers deliberately require live open-set freshness. Any future change must preserve discovery of newly opened blockers.
