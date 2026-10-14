---
bornAs: xwkr91f
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/__tests__/cli-adapter*.test.mjs", "we:scripts/operations/__tests__/parallel-judges.test.mjs", "we:scripts/operations/parallel-judges.mjs", "we:scripts/lib/judge-spawn.mjs", "we:scripts/lib/__tests__/judge-spawn.test.mjs", "we:scripts/operations/run-record.mjs", "we:scripts/operations/__tests__/run-record.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-stderr-redaction.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-10-10"
preparedDate: "2026-10-13"
preparedAgainstSha: "021c49b3f431f26caad567280bd305f1a7228f46"
tags: []
---

# Prevention — compact saved requests, validate fallback envelopes, and redact judge stderr

Filed mechanically on approval of web-everything/web-everything#4865. Preserve all three owed guards: compact saved judge requests, reject incomplete fallback result envelopes, and sanitize stderr before diagnostics or persistence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4865@f6d2033ddc3ce6e788277998028ffb441223f204

## Design

1. **Saved request identity.** In `we:scripts/operations/cli-adapter.mjs`, persist a SHA-256 hex `requestHash` in each saved successful seat instead of its full `request`. Hash the exact JSON serialization used by `sameJudgeRequest` in `we:scripts/operations/parallel-judges.mjs:85`; do not sort keys or omit request fields. Keep full requests for live in-memory batch execution. On resume, compare a valid stored digest with the current request digest, plus the existing step identity and its step index. Missing, malformed, or mismatched identity discards the saved answer and spawns that seat again. Use the UTF-8 serialization and a 64-character lowercase hexadecimal digest. Serialization that throws or returns no string must invalidate reuse, never yield a matching sentinel. Preserve timestamps, result values, and once-only spend accounting.
2. **Legacy records.** Accept old saved seats containing a request through the existing byte-for-byte comparison, also checking the step index. When retained seats are written again, replace their request with its digest. If both fields exist, the digest is authoritative; an invalid digest cannot fall back to a legacy request. The saved-seat validator in `we:scripts/operations/run-record.mjs:530` currently checks only the list, step name and nonnegative integer step index; it already accepts digest-bearing entries. Preserve that structural validation and test both representations; do not add a record-level digest rejection. Missing/malformed digests or a nonmatching valid step index discard only that answer at the adapter seam. Existing structural failures remain record validation errors. When saving after another failure, normalize every retained legacy entry, including the carry-forward list at `we:scripts/operations/cli-adapter.mjs:1053`; preserve a valid existing digest without trying to hash an absent request.
3. **Fallback envelope.** Tighten only the line-scanning fallback in `we:scripts/lib/judge-spawn.mjs:713`: a candidate must be a non-array object with a non-empty string `session_id` and either an own `structured_output` or own `result` field. Continue scanning past incomplete trailing JSON. Keep the downstream error/budget handling and structured-output object requirement. A standalone whole-document JSON response retains its existing behavior. This is a shape guard, not authentication of subprocess stdout; a forged complete envelope remains outside this guarantee.
4. **Shared redaction.** Reuse `redactCommandLine` from `we:scripts/operations/command-redact.mjs:115`. Apply it to raw stderr before any 160/600/1000-character excerpt, interpolation, retry log, failed-attempt field, timeout partial-stderr field, or telemetry field in `we:scripts/lib/judge-spawn.mjs`. Apply it defensively at `normalizeJudgeTelemetry` in `we:scripts/operations/run-record.mjs:156` and `seatFailureEvidence` in `we:scripts/operations/parallel-judges.mjs:90`, since callers can supply errors independently of the Claude spawner. Retain exit code, signal, attempts and useful sanitized text. Respect the helper's existing 4096-character input bound and truncation marker; do not tail-slice raw text first and lose a credential's marker. Do not promise preservation of the final raw stderr bytes after bounded sanitization.
5. **Prevention gate.** Add a pure source guard in `we:scripts/check-standards-rules.mjs` and wire it into `we:scripts/check-standards.mjs`, following the existing file-map guard pattern at `we:scripts/check-standards.mjs:1595`. Inventory the judge stderr sinks in the three modules above; require each to consume the shared sanitizer or a locally sanitized binding. Catch direct raw stderr interpolation, slicing into persisted properties, and removal/bypass of sanitization, with file/line diagnostics. Inspect executable code, not a token's mere presence in comments or an unused import. This first guard covers the named judge persistence/error paths; it is not a claim of whole-program taint analysis for every subprocess in the repository.

## MVP

- Implement digest save/reuse and legacy migration at the adapter seam, with identity helpers in `we:scripts/operations/parallel-judges.mjs` and preserved structural saved-seat validation in `we:scripts/operations/run-record.mjs`.
- Tighten fallback parsing and sanitize all stderr-bearing outputs of `we:scripts/lib/judge-spawn.mjs`; sanitize independently supplied telemetry and batch failures at their boundaries.
- Deliver the wired standards guard and regressions together. No live provider calls, provider-routing changes, health-cap increase, or new record-store migration command.

## Acceptance

- [A1] Saved successful seats contain a fixed-size digest and no request copy; an unchanged resume reuses answers and charges no duplicate spend. Changed or invalid identity respawns only the affected seat.
- [A2] A forged trailing JSON object containing only `structured_output` cannot replace a preceding full result; without a valid envelope the noisy-output path refuses.
- [A3] Supported credential shapes and C0/C1 controls are absent from error messages, retry logs, exposed stderr properties and persisted telemetry after sanitization. Existing diagnostic length bounds remain enforced.
- [A4] The new regression cases fail on the current implementation and pass after delivery; removing a sanitizer at a guarded sink causes the standards guard to fail.

## Test plan

- `we:scripts/operations/__tests__/cli-adapter-prefilled-seats.test.mjs` (planned; covered by `we:scripts/operations/__tests__/cli-adapter*.test.mjs` in scope): add focused adapter save/reload/resume regressions for digest-only persistence, legacy migration, invalid identity and step-index rejection, and once-only spend. Exercise the real adapter with injected judges and a temporary run store; keep batch helper coverage in `we:scripts/operations/__tests__/parallel-judges.test.mjs`.
- `we:scripts/operations/__tests__/parallel-judges.test.mjs` (existing; covers both adapter and batch helper): extend the failed-seat/save/resume cases at lines 183–229. Assert digest-only persistence, unchanged reuse, changed mandate/input/shape/model/tools, wrong step index, missing/malformed digest, legacy request reuse and rewrite, and digest precedence. Check timestamps and once-only costs. Add an unsafely supplied error to exercise batch redaction independently.
- In the same test, use a synthetic multi-seat request with a repeated large payload such that the old saved request copies push the serialized run over the health reader's 8 MiB limit while the digest version fits. Measure UTF-8 bytes of the complete serialized record, not string length, and prove saved metadata grows with seat count rather than request length. This fixture proves removal of duplicated requests, not a universal bound on arbitrary findings or pending requests.
- `we:scripts/lib/__tests__/judge-spawn.test.mjs` (existing): valid noisy full envelope; CRLF; incomplete trailing verdict; no valid envelope; empty/wrong-type session; primitive/array candidates; error envelope with `result`; unchanged whole-document success/error/budget behavior. Inject stderr with assignment secrets, authorization headers, known credential prefixes, controls, and long/truncation-boundary values into fake subprocess failures, retries and timeouts. Inspect every exposed stderr surface and logs, not just the final message. Directly construct the exported errors too: sanitize copied failed-attempt stderr entries at the constructor boundary, since `we:scripts/lib/judge-spawn.mjs:252` currently assigns the caller-supplied list unchanged. Cover both retry-then-success and retry exhaustion.
- `we:scripts/operations/__tests__/run-record.test.mjs` (existing): legacy/new saved-seat shapes and defensive telemetry redaction, including limits and retained numeric evidence. Prove a structurally valid record with an invalid digest still parses, then prove adapter resume rejects that saved answer. Keep the existing structural rejection cases at `we:scripts/operations/__tests__/run-record.test.mjs:48`.
- `we:scripts/__tests__/check-standards-rules-stderr-redaction.test.mjs` (planned): pure guard fixtures for sanitized sinks, raw persistence/interpolation, alias bypass, comments and unused imports, plus path/line reporting.
- `we:scripts/__tests__/check-standards.test.mjs` (existing): prove the real gate invokes the guard and rejects a temporary source fixture with one sanitized sink reverted. Keep fixture writes isolated.

Run affected files only through the host heavy-run queue: invoke Node on `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` and the WE-relative test paths listed above (remove the display-only `we:` prefixes in shell arguments). Run `npm run check:standards` through the same queue. No bare test runner or live credential/provider dependency.

## Proof plan

Capture before/after regression results for digest persistence, forged trailing verdict rejection and stderr leakage. Use the real adapter with injected judges and a temporary run store: fail an early seat, serialize the run, reload and resume it, then report byte count, saved-seat keys, spawn count and total recorded cost. For the large fixture, also feed the persisted record to `probeOperationRuns` from `we:scripts/conveyor/health-watch.mjs:315` and prove it is read below its exported cap. Supply only the temporary root, an isolated empty jobs root and a controlled current time so the probe never reads host records; assert the fixture run ID is returned, not merely that the probe succeeds. Keep the health reader unchanged. Record a guard mutation failing and the restored guard passing. All execution belongs to delivery and uses the heavy queue; preparation's source observations are not claims of passing runtime behavior.

## Non-goals

- No arbitrary stdout authentication, generic secret scanner, record retention policy, global record-size guarantee, or rewriting historical records in place.
- No HTTP receive/write endpoint is introduced; body limits, rate limits, CSRF/origin checks and remote reset protection do not apply.

## Edge cases this change must handle

1. **Untrusted text** — envelope shape checks and the existing shared redactor; unmarked arbitrary secrets remain outside its documented coverage.
2. **Truncated reads** — sanitize before excerpting; preserve truncation indication. Never infer a result from incomplete JSON.
3. **Shared state files** — retain the existing run-store write discipline; no new shared file or lock.
4. **Fail closed** — invalid saved identity respawns, never accepts the stale answer; incomplete fallback envelopes never produce a verdict.
5. **Identity scoping** — compare within the same run and step/index using the entire serialized request; digest equality is not author authentication.
6. **State over time** — legacy records remain resumable and retained seats migrate on write; consumed/discarded seats disappear as before.
7. **Who wrote it** — preserve existing run/session provenance and timestamps; add no claimed authentication to saved data.

## Follow-ups

Audit other providers and subprocess persistence paths before extending the sanitizer guard repository-wide. The original review's broad prevention aspiration extends beyond this bounded judge-path fix; a cross-repository or universal taint-analysis rule is not delivered here. Any later stdout/result-text sanitization needs its own sink inventory: this item guards stderr, while parsed result text and stdout excerpts still have separate paths at `we:scripts/lib/judge-spawn.mjs:727` and `we:scripts/lib/judge-spawn.mjs:767`. Separately consider record growth from findings and pending input if observations show it reaches the health cap; do not raise the cap to hide duplicated requests.

## Progress

- Original premise/scope: three review locations at `we:scripts/operations/cli-adapter.mjs:1050`, `we:scripts/lib/judge-spawn.mjs:720`, and `we:scripts/operations/run-record.mjs:123`, with three matching test paths. The original adapter test path `we:scripts/operations/__tests__/cli-adapter.test.mjs` does not exist in this checkout.
- Corrected premise: full requests are still saved at `we:scripts/operations/cli-adapter.mjs:1058`, restored at line 1029, and compared at line 1114. Equality lives at `we:scripts/operations/parallel-judges.mjs:85`; actual resume tests are `we:scripts/operations/__tests__/parallel-judges.test.mjs:183`. The health reader skips files above 8 MiB at `we:scripts/conveyor/health-watch.mjs:303` and line 339. Hashing removes redundant request copies but cannot bound every run field.
- Parser fallback still accepts a disjunction of individual envelope markers at `we:scripts/lib/judge-spawn.mjs:719`. Raw stderr reaches error/telemetry surfaces at lines 227–280 and failed-attempt evidence at line 977. `we:scripts/operations/run-record.mjs:163` bounds stderr without redacting; `we:scripts/operations/parallel-judges.mjs:97` similarly copies a raw tail. These source observations establish remaining work, not an already-delivered goal.
- Corrected scope adds the batch helper and standards guard/wiring with explicit matching tests; reuses the existing sanitizer without changing it. Existing tests and source reads support a bounded implementation with no unresolved policy fork.
- Size changed from 3 to 5: estimated changes are adapter ~60 lines, batch helper ~25, spawner ~45, record normalization/validation ~25, guard ~80, gate wiring ~15, and five test files ~220 total (~470 lines across eleven files). The save/restore/compare seams, multiple stderr constructors, and gate wiring above justify the wider touch set. This remains a story, so no estimatedLoc field is added.
- Preparation only: source inspection completed; no implementation, stamp, status change, commit, push, or PR authored. The runner owns stamping and checks.

- Validation repair: the prior scope relied on adapter coverage in `we:scripts/operations/__tests__/parallel-judges.test.mjs:183`, but omitted the required matching adapter test scope. Added `we:scripts/operations/__tests__/cli-adapter*.test.mjs` and a concrete planned adapter regression file. No matching adapter test file currently exists; the save/restore seam at `we:scripts/operations/cli-adapter.mjs:1029` and `we:scripts/operations/cli-adapter.mjs:1058` supports that planned coverage. Size remains 5: redistribute the previously estimated ~220 test lines across six test files (~470 changed lines across twelve files), with focused adapter cases in the new file and batch integration assertions retained in the existing suite. The implementation goal and completed design sections are unchanged.

- Current-checkout recheck: the original three prevention gaps remain at `we:scripts/operations/cli-adapter.mjs:1058`, `we:scripts/lib/judge-spawn.mjs:719`, and `we:scripts/operations/run-record.mjs:163`; no already-delivered outcome is supported. The previous preparation's instruction to extend saved-seat validation was too broad: `we:scripts/operations/run-record.mjs:534`–`we:scripts/operations/run-record.mjs:537` validates structure only and already tolerates either identity representation. Corrected scope keeps that module for telemetry sanitization, preserves structural validation, and locates digest rejection at the adapter reuse seam. Source/test scope remains six implementation files and six matching test files (two planned), with size 5 unchanged.
- Migration evidence: `we:scripts/operations/cli-adapter.mjs:1053` carries retained entries forward separately from the in-memory loop; both paths must drop legacy request copies on save. Constructor evidence: `we:scripts/lib/judge-spawn.mjs:252` exposes the supplied failed-attempt list directly, requiring defensive sanitization as well as the producer fix at `we:scripts/lib/judge-spawn.mjs:977`. These refine the existing touch set rather than add a policy fork. Existing adapter assertions read saved request lenses at `we:scripts/operations/__tests__/parallel-judges.test.mjs:191` and must use known step/answer fixtures after digest-only persistence.
- This recheck edits the body only. Existing preparation stamps are left untouched for the runner; no execution results or delivering commit are claimed.
