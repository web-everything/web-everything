---
bornAs: xenrh2h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4774-a-red-verify-names-the-failing-tests-in-its-run-record-and-m.md", "we:scripts/lib/verify-failures.mjs", "we:scripts/lib/__tests__/verify-failures.test.mjs", "we:scripts/__tests__/lane-verify.test.mjs", "we:scripts/operations/__tests__/verify.test.mjs", "we:scripts/operations/__tests__/verify-integration.test.mjs", "we:scripts/lib/__tests__/gate-timeout-retry.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-10-06"
preparedAgainstSha: "e93a583ab5c84530e7b4bdf858f92bf4f762fb92"
tags: []
---

# Prevention — sanitize persisted verification identities and use fixed-form summaries

Filed mechanically ON APPROVAL from chalbert/web-everything#3400: require bounded, sanitized names and summaries, never persist raw log text as a summary, and add secret-like and injection-like collector inputs. The broader standards rule remains a follow-up.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3400@d3c0c3b230687098b086afd312f7fe7bb2a3eafc

## Progress

- Original premise/scope: add a Must to the still-developing #4774 card, plus a collector regression; scope listed only we:backlog/4774-a-red-verify-names-the-failing-tests-in-its-run-record-and-m.md. The old line-30 citation no longer locates acceptance criteria: those are now at we:backlog/4774-a-red-verify-names-the-failing-tests-in-its-run-record-and-m.md:63-68. That card is resolved and the collector exists.
- Corrected premise: the requested prevention is not delivered. Inspection shows arbitrary cleaned log lines appended to the summary at we:scripts/lib/verify-failures.mjs:35-40. The boundary clips file/name strings but does not sanitize them at we:scripts/lib/verify-failures.mjs:9-21. The existing control-character test checks byte size only (we:scripts/lib/__tests__/verify-failures.test.mjs:40-44), and another test explicitly expects raw unknown output in the summary (we:scripts/lib/__tests__/verify-failures.test.mjs:22-25).
- Corrected scope: retain the acceptance clarification in #4774 and include the existing collector with its matching unit test, plus boundary and integration regressions. Normalization already occurs when finishing/reading markers (we:scripts/lib/lane-verify.mjs:295,569) and classifying operation results (we:scripts/operations/verify-io.mjs:119), so those source files need no planned edits. Their existing tests must reflect the new normalized summary instead of assuming arbitrary summaries survive unchanged (we:scripts/__tests__/lane-verify.test.mjs:1101-1113; we:scripts/operations/__tests__/verify.test.mjs:268-273).
- Size remains 3: one shared normalization implementation, collector tests and existing transport fixtures; no new persistence, reporter or gate. The real subprocess seam already exists at we:scripts/operations/__tests__/verify-integration.test.mjs:146-172. Retry compares collected identities with separately parsed output at we:scripts/lib/gate-timeout-retry.mjs:47-48, so retain its regression coverage when sanitation discards evidence.
- Preparation is source inspection only; no implementation or passing-test claim is made. Stamping and repository checks belong to the runner.

## Design

Implement the existing requested boundary in we:scripts/lib/verify-failures.mjs. Keep the payload shape (`tests`, `summary`, `truncated`) and existing limits: 20 identities, 512 Unicode code points per file/name, 2 KiB summary and 16 KiB serialized payload. Strip terminal escape sequences and C0/C1 control characters from file/name strings before applying length limits; also remove directional formatting controls that can visually reorder identity text. Preserve ordinary Unicode and null suite-only names. Discard identities whose file becomes empty. Mark `truncated` when sanitation, clipping or discarding loses identity evidence, so transformed names cannot silently authorize timeout retries.

Generate `summary` solely from bounded structured state, using fixed templates: “Verification failed; N failure identities retained.” when identities exist, otherwise “Verification failed; no recognized failure identities.” Append a fixed “Diagnostics truncated.” sentence when applicable. Never interpolate captured output, assertion messages, file names or test names into this summary. Recompute it in `boundFailureDetails`, including for older markers and operation input; do not trust an incoming summary merely because it is short. Make normalization idempotent. Remove the collector's rolling raw summary tail; preserve bounded parsing and stdout/stderr forwarding.

This is an untrusted-text boundary, not a claim that arbitrary test names cannot themselves contain secrets or instructions. Retained identity fields are bounded diagnostic data, never instructions; unknown output is omitted from persisted summaries. The original requirement permits names for actionable failures and does not authorize inventing a universal secret detector or dropping all names.

Add the same Must contract to we:backlog/4774-a-red-verify-names-the-failing-tests-in-its-run-record-and-m.md without changing its resolved status or rewriting historical results. Keep existing markers readable; normalize on read, without a historical marker migration.

## MVP

1. Update #4774 acceptance to require control-free, capped identities, fixed-form summaries and hostile-input regression coverage.
2. Centralize sanitation and fixed summary generation in we:scripts/lib/verify-failures.mjs; remove raw summary accumulation without changing exit classification, gate execution or output streaming.
3. Extend the scoped tests for collector input, direct boundary input, old-marker reads and operation transport. Adapt existing assertions that intentionally expected raw summaries.
4. Preserve ordinary failure identities and conservative retry refusal when identity evidence was transformed. No broader standards lint ships in this slice.

## Test plan

- we:scripts/lib/__tests__/verify-failures.test.mjs: feed secret-like tokens and “ignore previous instructions” text on ordinary stdout/stderr lines, including split chunks. Assert exact fixed summaries and absence of those sentinels in the resulting payload when they are outside recognized identities. Inject ANSI, NUL, tab, DEL, C1 and directional formatting controls into recognized names and direct boundary input; assert sanitation, limits and loss flag. Include ordinary Unicode, null names, unknown output, empty sanitized files, deduplication, long streams, byte caps and repeated normalization.
- we:scripts/__tests__/lane-verify.test.mjs: pass hostile legacy summaries and control-bearing identities through finish/read boundaries; assert normalized payloads, green clearing and foreign-SHA exclusion remain intact.
- we:scripts/operations/__tests__/verify.test.mjs: classify a hostile red JSON payload and assess the verdict; raw summary sentinels must not reach checks or blocking detail, while sanitized names remain actionable. Keep malformed/killed results unrun.
- we:scripts/operations/__tests__/verify-integration.test.mjs: extend the real failing Vitest fixture to print distinctive fake-secret and instruction sentinels outside its test name. Assert red exit, fixed summary and sentinel absence in the disk marker, returned verdict and subsequent read-only check; then fix the assertion and prove green clearing.
- we:scripts/lib/__tests__/gate-timeout-retry.test.mjs: ordinary complete timeout identities remain eligible under existing rules; sanitized or clipped identities refuse retry. Preserve the long-progress case that does not truncate a complete unchanged failure inventory.

## Proof plan

At implementation time, first add the hostile collector regression and observe failure against the unchanged collector specifically because raw sentinels survive or controls remain. After implementation, run all six scoped test files through the host queue. For each file, execute `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <repo-qualified-test-file>` after removing documentation-only `we:` prefixes from command paths. Run the standards gate only through `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` (likewise strip `we:` before executing).

Retain before/after assertion output and the real subprocess fixture's marker/verdict assertions as evidence. Verify the sentinel is actually emitted by the fixture so an empty-output fixture cannot satisfy the absence check accidentally. Evidence must show a deliberately red verification remains red, its identities remain useful, and its persisted summary contains only fixed text. Do not publish actual secrets in proof artifacts.

## Done when

- **Executable:** the hostile-input regression in we:scripts/lib/__tests__/verify-failures.test.mjs fails before the implementation and passes afterward, via the queued command above; all scoped regressions and the queued standards gate pass.
- **Must:** persisted summaries are fixed-form, never raw log excerpts; names and files have control characters removed and fixed caps at every existing normalization boundary.
- **Must:** unknown/custom output, malformed diagnostics, legacy markers and both process streams receive the same cautious treatment. Parsing or sanitation cannot upgrade red/unrun to pass or authorize retry from transformed evidence.
- **Must:** secret-like and injection-like ordinary log lines do not survive in persisted diagnostics or operation blocking detail; ordinary recognized failure identities still do. #4774 records this acceptance contract.

## Follow-ups

- Separately scope the original longer-term `check:standards` rule requiring cards that persist captured process output to state a redaction or untrusted-text policy. Research its detection predicate and matching gate tests before implementing it; no generic text-search heuristic belongs in this collector fix.
- Secret-bearing test identities and structured reporter provenance require separate policy work if broader guarantees are needed. This change does not claim content-based secret detection or authenticated failure identities.
