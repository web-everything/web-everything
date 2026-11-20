---
bornAs: xenrh2h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4774-a-red-verify-names-the-failing-tests-in-its-run-record-and-m.md", "we:scripts/lib/verify-failures.mjs", "we:scripts/lib/__tests__/verify-failures.test.mjs", "we:scripts/__tests__/lane-verify.test.mjs", "we:scripts/operations/__tests__/verify.test.mjs", "we:scripts/operations/__tests__/verify-integration.test.mjs", "we:scripts/lib/__tests__/gate-timeout-retry.test.mjs", "we:scripts/lib/__tests__/verify-shard-run.test.mjs", "we:scripts/lib/__tests__/verify-remote-routing-shard.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "cb057cf7c6104547c15892aed25af90cb14d8219"
tags: []
---

# Prevention — sanitize persisted verification identities and use fixed-form summaries

Filed mechanically ON APPROVAL from chalbert/web-everything#3400: require bounded, sanitized names and summaries, never persist raw log text as a summary, and add secret-like and injection-like collector inputs. The broader standards rule remains a follow-up.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3400@d3c0c3b230687098b086afd312f7fe7bb2a3eafc

## Progress

- Original premise/scope: add a Must to the still-developing #4774 card, plus a collector regression; scope listed only we:backlog/4774-a-red-verify-names-the-failing-tests-in-its-run-record-and-m.md. The old line-30 citation no longer locates acceptance criteria: those are now at we:backlog/4774-a-red-verify-names-the-failing-tests-in-its-run-record-and-m.md:63-68. That card is resolved and the collector exists.
- Corrected premise: the requested prevention is not delivered. Inspection shows arbitrary cleaned log lines appended to the summary at we:scripts/lib/verify-failures.mjs:35-40. The boundary clips file/name strings but does not sanitize them at we:scripts/lib/verify-failures.mjs:9-21. The existing control-character test checks byte size only (we:scripts/lib/__tests__/verify-failures.test.mjs:40-44), and another test explicitly expects raw unknown output in the summary (we:scripts/lib/__tests__/verify-failures.test.mjs:22-25).
- Corrected scope: retain the acceptance clarification in #4774 and include the existing collector with its matching unit test, plus boundary and integration regressions. Normalization already occurs when finishing/reading markers (we:scripts/lib/lane-verify.mjs:379,653) and classifying operation results (we:scripts/operations/verify-io.mjs:119), so those source files need no planned edits. Their existing tests must reflect the new normalized summary instead of assuming arbitrary summaries survive unchanged (we:scripts/__tests__/lane-verify.test.mjs:1180-1192; we:scripts/operations/__tests__/verify.test.mjs:268-273).
- Size remains 3: one shared normalization implementation, collector tests and existing transport fixtures; no new persistence, reporter or gate. The real subprocess seam already exists at we:scripts/operations/__tests__/verify-integration.test.mjs:146-172. Retry compares collected identities with separately parsed output at we:scripts/lib/gate-timeout-retry.mjs:35-38,80-83, so retain its regression coverage when sanitation discards evidence.
- Current-checkout correction: the prior seven-entry scope missed phase merging and shard-report callers. we:scripts/lib/verify-failures.mjs:89-102 interpolates phase labels and summaries and returns a single part without normalization; we:scripts/verify-lane.mjs:1106 consumes that merge. Normalize zero/one/multiple-part merges in the existing implementation and test them in we:scripts/lib/__tests__/verify-failures.test.mjs. we:scripts/lib/verify-shard-run.mjs:272-280 passes raw report JSON as summary and re-emits it; add its existing matching test, we:scripts/lib/__tests__/verify-shard-run.test.mjs, to scope. No shard source edit is expected because it already calls the boundary. Also include we:scripts/lib/__tests__/verify-remote-routing-shard.test.mjs:145,169, whose marker assertions require old raw summaries; update those assertions to the exact fixed summary without weakening outcome assertions. Additional legacy fixtures at we:scripts/__tests__/lane-verify.test.mjs:83-89 need the same adjustment. The old six-test claim was incorrect: the prior scope had five tests; the corrected scope has seven. Size remains 3 (old 3 → new 3): estimated implementation 60 changed lines, seven tests about 20–60 changed lines each, and the historical contract clarification about 5 lines; all exercise one shared boundary, with no new execution policy.
- Preparation is source inspection only; no implementation or passing-test claim is made. Stamping and repository checks belong to the runner.

## Design

Implement the existing requested boundary in we:scripts/lib/verify-failures.mjs. Keep the payload shape (`tests`, `summary`, `truncated`) and existing limits: 20 identities, 512 Unicode code points per file/name, 2 KiB summary and 16 KiB serialized payload. Strip terminal escape sequences and C0/C1 control characters from file/name strings before applying length limits; also remove directional formatting controls that can visually reorder identity text. Preserve ordinary Unicode and null suite-only names. Discard identities whose file becomes empty. Mark `truncated` when sanitation, clipping or discarding loses identity evidence, so transformed names cannot silently authorize timeout retries.

Generate `summary` solely from bounded structured state, using fixed templates: “Verification failed; N failure identities retained.” when identities exist, otherwise “Verification failed; no recognized failure identities.” Append a fixed “Diagnostics truncated.” sentence when applicable. Never interpolate captured output, assertion messages, file names or test names into this summary. Recompute it in `boundFailureDetails`, including for older markers and operation input; do not trust an incoming summary merely because it is short. Make normalization idempotent. Compute the count and truncation suffix after enforcing the serialized-payload cap so the summary describes the retained entries. Keep invalid top-level payloads rejected as undefined; malformed entries are dropped with `truncated` set. For oversized or transformed evidence, the operator-visible fallback is the fixed truncation sentence and a red result with automatic retry refused; inspect the live gate output to diagnose further. Remove the collector's rolling raw summary tail; preserve bounded parsing and stdout/stderr forwarding. In we:scripts/lib/verify-failures.mjs, normalize every nonempty `mergeFailureDetails` result, including the single-part fast path, omit phase labels from the fixed summary, retain deduplicated identities in phase order, and preserve loss flags; an empty merge stays undefined. Ordinary reporter ANSI decoration removed before identity parsing remains supported; sanitation of identity content at the boundary must flag evidence loss. The scope is persisted `failureDetails`, not arbitrary live terminal output or separate infrastructure diagnostics.

This is an untrusted-text boundary, not a claim that arbitrary test names cannot themselves contain secrets or instructions. Retained identity fields are bounded diagnostic data, never instructions; unknown output is omitted from persisted summaries. The original requirement permits names for actionable failures and does not authorize inventing a universal secret detector or dropping all names.

Add the same Must contract to we:backlog/4774-a-red-verify-names-the-failing-tests-in-its-run-record-and-m.md without changing its resolved status or rewriting historical results. Keep existing markers readable; normalize on read, without a historical marker migration.

## MVP

1. Update #4774 acceptance to require control-free, capped identities, fixed-form summaries and hostile-input regression coverage.
2. Centralize sanitation and fixed summary generation in we:scripts/lib/verify-failures.mjs; remove raw summary accumulation without changing exit classification, gate execution or output streaming.
3. Extend the scoped tests for collector input, direct boundary input, old-marker reads and operation transport. Adapt existing assertions that intentionally expected raw summaries.
4. Cover merge cardinalities and shard JSON report normalization; update remote-confirmation marker fixtures for the changed summary default.
5. Preserve ordinary failure identities and conservative retry refusal when identity evidence was transformed. No broader standards lint ships in this slice.

## Test plan

- we:scripts/lib/__tests__/verify-failures.test.mjs: feed secret-like tokens and “ignore previous instructions” text on ordinary stdout/stderr lines, including split chunks. Assert exact fixed summaries and absence of those sentinels in the resulting payload when they are outside recognized identities. Inject ANSI, NUL, tab, DEL, C1 and directional formatting controls into recognized names and direct boundary input; assert sanitation, limits and loss flag. Include ordinary Unicode, null names, unknown output, empty sanitized files, deduplication, long streams, byte caps and repeated normalization.
- we:scripts/__tests__/lane-verify.test.mjs: pass hostile legacy summaries and control-bearing identities through finish/read boundaries; assert normalized payloads, green clearing and foreign-SHA exclusion remain intact.
- we:scripts/operations/__tests__/verify.test.mjs: classify a hostile red JSON payload and assess the verdict; raw summary sentinels must not reach checks or blocking detail, while sanitized names remain actionable. Keep malformed/killed results unrun.
- we:scripts/operations/__tests__/verify-integration.test.mjs: extend the real failing Vitest fixture to print distinctive fake-secret and instruction sentinels outside its test name. Assert red exit, fixed summary and sentinel absence in the disk marker, returned verdict and subsequent read-only check; then fix the assertion and prove green clearing.
- we:scripts/lib/__tests__/gate-timeout-retry.test.mjs: ordinary complete timeout identities remain eligible under existing rules; sanitized or clipped identities refuse retry. Preserve the long-progress case that does not truncate a complete unchanged failure inventory.

- we:scripts/lib/__tests__/verify-failures.test.mjs: add proposed `normalizes zero one and multiple phase results` with hostile phase labels, summaries and identities, final-count agreement after byte trimming, and idempotence. Empty input stays undefined; valid single-part input cannot bypass normalization.
- we:scripts/lib/__tests__/verify-shard-run.test.mjs: add proposed `does not re-emit raw report secrets as a diagnostic summary`; feed a failed JSON report with sentinels outside identities and assert emitted observed-failure summary is fixed, recognized identities survive and the failed inventory remains failed, including incomplete confirmation.
- we:scripts/lib/__tests__/verify-remote-routing-shard.test.mjs: update the existing remote/local confirmation matrix to assert exact normalized marker summaries, preserving failure-location and red/infrastructure distinctions.

## Proof plan

At implementation time, first add the hostile collector regression and observe failure against the unchanged collector specifically because raw sentinels survive or controls remain. After implementation, run all seven scoped test files through the host queue. For each file, execute `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <repo-qualified-test-file>` after removing documentation-only `we:` prefixes from command paths. Run the standards gate only through `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` (likewise strip `we:` before executing).

Retain before/after assertion output and the real subprocess fixture's marker/verdict assertions as evidence. Verify the sentinel is actually emitted by the fixture so an empty-output fixture cannot satisfy the absence check accidentally. Evidence must show a deliberately red verification remains red, its identities remain useful, and its persisted summary contains only fixed text. Do not publish actual secrets in proof artifacts.

## Acceptance

Each named test below is a proposed addition or extension, run using the queued single-file command in Proof plan. Record its failing assertion before the build and its passing assertion afterward; preservation checks run within the same case as the new failing assertion.

- [A1] Executable: `fixed summaries omit hostile ordinary output` in we:scripts/lib/__tests__/verify-failures.test.mjs must fail before and pass after: both streams, split chunks, unknown/custom output and fake-secret/instruction sentinels produce only the exact fixed summary, no invented identities and no raw-text persistence.
- [A2] Executable: `sanitizes identities with bounded idempotent evidence` in we:scripts/lib/__tests__/verify-failures.test.mjs must fail before and pass after: ANSI, C0/C1 and directional controls are removed, empty files and malformed entries are dropped with loss flagged, Unicode/null names survive, limits hold under oversized input, and final summary count matches retained entries. Invalid top-level input stays undefined.
- [A3] Executable: `normalizes hostile legacy diagnostics at finish and read` in we:scripts/__tests__/lane-verify.test.mjs must fail before and pass after: old summaries are replaced and identities sanitized at both boundaries; green clearing, foreign-SHA isolation and infrastructure/killed outcomes remain intact.
- [A4] Executable: `hostile red diagnostics remain red through assessment` in we:scripts/operations/__tests__/verify.test.mjs must fail before and pass after: normalized summary reaches verdict checks, ordinary identity remains actionable in blocking detail, sentinels outside identities cannot reach it, and malformed/killed results remain unrun.
- [A5] Executable: extend `records a real Vitest named failure through the marker and operation verdict, then clears green` in we:scripts/operations/__tests__/verify-integration.test.mjs; exact fixed-summary assertions must fail before and pass after while the fixture emits both hostile sentinels, remains red, retains its identity in marker/verdict/read-only check and clears on green. Update #4774's Must contract to describe this tested behavior without changing historical results.
- [A6] Executable: `transformed identities refuse isolated retry` in we:scripts/lib/__tests__/gate-timeout-retry.test.mjs must fail before and pass after for control-bearing timeout evidence; sanitized/clipped/dropped evidence returns no retry candidates, exposes the truncation fallback and stays red. Unchanged complete identities remain eligible, including after long progress output.
- [A7] Executable: `normalizes zero one and multiple phase results` in we:scripts/lib/__tests__/verify-failures.test.mjs must fail before and pass after: no single-part bypass or phase/raw-summary interpolation; deduplication, order, loss flags and empty-merge behavior are preserved.
- [A8] Executable: `does not re-emit raw report secrets as a diagnostic summary` in we:scripts/lib/__tests__/verify-shard-run.test.mjs must fail before and pass after, proving the report-producing caller emits the fixed summary without losing failed inventory. Extend the remote/local confirmation matrix in we:scripts/lib/__tests__/verify-remote-routing-shard.test.mjs with exact fixed-summary expectations that fail before and pass after; preserve its existing outcome and provenance checks.

## Follow-ups

- Separately scope the original longer-term `check:standards` rule requiring cards that persist captured process output to state a redaction or untrusted-text policy. Research its detection predicate and matching gate tests before implementing it; no generic text-search heuristic belongs in this collector fix.
- Secret-bearing test identities and structured reporter provenance require separate policy work if broader guarantees are needed. This change does not claim content-based secret detection or authenticated failure identities.
