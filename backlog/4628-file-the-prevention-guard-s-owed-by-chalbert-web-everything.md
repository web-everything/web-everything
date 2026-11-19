---
bornAs: xygrhwb
kind: story
size: 8
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/scope-bloat.test.mjs", "we:scripts/conveyor/__tests__/review-timing-dispatch.test.mjs", "we:scripts/conveyor/__tests__/dispatch-eligibility-shadow.test.mjs", "we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs", "we:scripts/conveyor/__tests__/pr-stack.test.mjs", "we:scripts/lib/__tests__/operator-send-backs.test.mjs", "we:scripts/operations/__tests__/land-advance-io.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/lib/fix-sort-sentinel-scan.mjs", "we:scripts/lib/__tests__/fix-sort-sentinel-scan.test.mjs", "we:scripts/__tests__/check-standards-fix-sort.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "46abe5d8e4fde88010e88f525ee7aa6a4e8f80fb"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3131's independent review

Filed mechanically on approval: the independent review owed timestamp-ordering, terminal-claim, and spawn-lag prevention guards. This item delivers those guards and the minimum timestamp correction needed to make them true.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3131@493a88f65af74c3b11df13e8c60b0d48b75508b0

## Progress

Preparation research (2026-11-19); no implementation or preparation stamp applied.

- Old premise/scope: four files, size 3, with sorting cited at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1451` and settlement at `we:scripts/conveyor/fix-dispatch-claim.mjs:248` and `we:scripts/conveyor/fix-dispatch-claim.mjs:253`. The short test-path citation omitted its directory.
- Corrected premise: both planner output branches copy a truthy timestamp without validating it (`we:scripts/conveyor/reconcile-fix-dispatch.mjs:388`, `we:scripts/conveyor/reconcile-fix-dispatch.mjs:512`). The MAX sentinel now lives in the ranking helper at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2733`, used by the comparator at `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2745`. The producer already falls back from an episode marker to PR creation at `we:scripts/conveyor/reconcile-core.mjs:4107`; this is not a request to invent a new age policy.
- Settlement moved to `we:scripts/conveyor/fix-dispatch-claim.mjs:456`. It releases current terminal sessions, retains missing sessions, and lets a live sibling win. Existing coverage is partial: `we:scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs:557` covers done/lag/old rows, and `we:scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs:591` covers stopped with session identity. The exhaustive matrix and unrelated-terminal/missing-session combination remain owed. This item is not already delivered.
- Retry bounds already exist upstream: `we:scripts/conveyor/reconcile-core.mjs:4087` refuses exhausted ordinary fix rounds and exposes human takeover. Preserve existing explicit operator-send-back semantics; tests at `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:3841` exercise that exception. Claim release must not reset durable attempts.
- Corrected scope includes a standards scanner, its wiring/tests, and existing caller fixtures. Direct callers are the normal pass, synthetic restack and claim inspection (`we:scripts/conveyor/reconcile-fix-dispatch.mjs:2045`, `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2090`, `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2470`) and landing evidence (`we:scripts/operations/land-advance-io.mjs:144`). Landing already fetches creation time (`we:scripts/operations/land-advance-io.mjs:118`); the restack reader drops it and its cached PR field list omits it (`we:scripts/conveyor/reconcile-fix-dispatch.mjs:553`, `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1867`). Existing producer fallback tests are at `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:3776`.
- Size changes from 3 to 8: approximately 100 changed lines in the planner/reader/ranker, up to 20 in claim documentation, 180 across the two primary regression suites, 120 across eight caller/producer fixture suites, and 180 across the scanner, scanner tests, standards wiring and wiring tests: about 600 changed lines across 16 scoped files. No `estimatedLoc` is added to this story. The larger estimate reflects the caller migration and independently testable standards guard absent from the original scope.

## Design

Normalize timestamp evidence once before emitting either planner branch: accept a string whose `Date.parse` result is finite, prefer valid `waitingSince`, otherwise use valid PR `createdAt`. Preserve the timestamp representation as a string. If neither is valid, emit an operator-visible `missing-waiting-time` refusal carrying the PR number and a reason to refresh PR metadata; do not dispatch or fabricate age from the current clock. This is a transient evidence refusal, not a permanent no-scope conclusion. Validate the same invariant at direct queue admission so legacy/persisted entries cannot silently bypass it. Remove the MAX sentinel; rank only validated entries, preserving the existing urgency, priority, age, score and tie-break order.

Request `createdAt` in the existing cached PR reader and carry it through synthetic restack entries. Normal reconcile already supplies the fallback. Landing's raw PR rows already carry `createdAt`; test that integration. Update timestamp-less test fixtures explicitly with historical dates, leaving malformed/missing cases for negative tests. Claim inspection must continue to identify valid historical entries. Do not change round-cap values, claim TTL, idle-release defaults, session identity precedence or operator-send-back policy.

Expand settlement tests across `done`, `stopped`, and `failed`: current dispatch releases; older same-name row, unbound row, unrelated name, missing listing, failed listing and live sibling retain. Cover exact session identity predating acquisition, timestamp-bound legacy claims, owner replacement, and awaiting-verification retention using existing injectable ports. For every release state, feed the resulting claim snapshot into reconcile with an exhausted durable ordinary-fix budget and assert no redispatch and the existing human-facing cap refusal. Keep the explicit authorized send-back exception covered separately.

Add a focused standards guard in planned `we:scripts/lib/fix-sort-sentinel-scan.mjs`, wired through `we:scripts/check-standards.mjs`. Its declared subject is the fix queue comparator and its timestamp/rank helpers, not every numeric MAX constant in the repository. Reject `Number.MAX_SAFE_INTEGER`/`Number.MAX_VALUE` missing-key fallbacks there, including a helper called by the comparator. Report file/line and remediation. Unreadable source or missing expected function boundaries must produce an error, not an empty successful scan. Keep the new section always running initially (the existing section gate defaults to running undeclared sections); do not broaden scoped-section infrastructure. Document this limited scanner contract and test comments/string literals and unrelated numeric caps as non-findings.

## MVP

Must deliver all three owed guards: total timestamp evidence or explicit refusal, a wired sentinel check, and complete terminal/lag regression coverage connected to the existing durable cap. Include the cached-reader and caller-fixture migration in this slice; they are necessary consequences of rejecting incomplete age evidence.

Could later generalize the scanner to other queue implementations. A repository-wide JavaScript data-flow analyzer, new rate-limit policy, new retry counters, and claim-lifecycle redesign are outside this item.

## Acceptance

All named tests below are proposed additions. Their invocation must also prove that the named cases ran (zero matching tests is failure). For coverage-only guarantees already implemented, record red-before-build as the missing required test manifest/case, and demonstrate behavioral sensitivity with the specific mutation in Proof plan; do not claim existing correct behavior was broken.

- [A1] Executable — Run `npm run test:unit -- we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs` (strip the `we:` locator before shell execution), requiring new cases `4628 finite planned age matrix`, `4628 missing age refuses admission`, and `4628 finite rank ordering`. Generated deterministic combinations cover both planner branches, invalid/missing/valid timestamps, creation fallback, legacy queue rows and stable tie-breaks. New negative assertions fail against the current planner/sentinel behavior and pass after implementation.
- [A2] Executable — Run `npm run test:unit -- we:scripts/lib/__tests__/fix-sort-sentinel-scan.test.mjs we:scripts/__tests__/check-standards-fix-sort.test.mjs` with locator prefixes stripped. Require `4628 comparator sentinel rejected`, `4628 helper sentinel rejected`, `4628 unreadable or missing subject fails closed`, and `4628 standards wiring emits failure`. The absent guard fails before build; afterward sentinel fixtures fail the gate and repaired fixtures pass, including scoped invocation and reported source location.
- [A3] Executable — Run `npm run test:unit -- we:scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs we:scripts/conveyor/__tests__/reconcile-core.test.mjs` with locator prefixes stripped. Require `4628 terminal retention and release matrix`, `4628 unrelated terminal cannot settle missing session`, and `4628 terminal release preserves durable cap`. Enforce all three terminal states and the retention/release rows in Design, checking claim storage and zero redispatch at cap, including after reload. Missing required matrix coverage fails before build; all cases must execute afterward.
- [A4] Executable — Run the caller suites in scope through `npm run test:unit --` with repo-relative arguments. Require `4628 restack creation fallback`, `4628 landing creation fallback`, and `4628 claim inspection historical timestamp`; preserve existing assertions in the scope-bloat, review-timing, operator-send-back, executor-routing, eligibility-shadow and stack suites. Missing fallback propagation fails before the reader change. Confirm malformed metadata refuses with its reason and no spawn; valid historical rows retain their prior routing. No default cap or TTL changes are permitted.

## Test plan

Use only the host heavy-admission queue (`npm run test:unit --` already invokes it). Resolve every `we:` locator in Acceptance to a repository-relative CLI argument; never hand the locus prefix to Vitest. Run the scoped tests, not the full suite. Use fixed clocks, temporary claim storage under the task's `TMPDIR`, injected PR reads and agents; no live agents or GitHub calls.

The new scanner suite owns positive, negative and malformed-input fixtures; the standards wiring suite owns error propagation and scoped-run coverage. Matrix tests must assert expected case counts so a removed terminal state or skipped row fails. Run `npm run check:standards` through its existing heavy-admission wrapper at build validation. If admission is busy, wait once using the queue's own wait option, then report unverified work instead of polling.

## Proof plan

Capture the required test-name inventory and baseline red results before production edits. For A1/A4, newly written fallback/refusal tests must demonstrate failures on the old implementation. For A2, inject a forbidden sentinel in the comparator and separately in its helper; show a nonzero standards result with file/line, then a passing result after repair. Also remove a subject boundary and simulate a read failure to prove fail-closed behavior.

For A3, preserve the green existing implementation and prove the new tests detect regressions: temporarily treat any terminal row as settlement, omit each terminal state in turn, and bypass the upstream cap check. Each mutation must fail its named case; restore the source after each probe. This distinguishes prevention coverage from an invented production defect. Verify the release-and-reconcile fixture reports the cap refusal and performs zero spawns for each terminal state. Record actual commands, named test counts and results; no claim of a live daemon exercise is needed for this hermetic prevention work.

## Follow-ups

A general sort-comparator scanner can be designed separately if another queue needs this invariant; the focused guard must state its coverage boundary. Broader changes to retry policy or claim identity semantics require separate work and are not prerequisites. No blockedBy changes are proposed.
