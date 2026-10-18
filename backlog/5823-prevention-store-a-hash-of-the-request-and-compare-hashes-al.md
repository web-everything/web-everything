---
bornAs: xwkr91f
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/__tests__/cli-adapter-prefilled-seats.test.mjs", "we:scripts/operations/__tests__/parallel-judges.test.mjs", "we:scripts/operations/parallel-judges.mjs", "we:scripts/lib/judge-spawn.mjs", "we:scripts/lib/__tests__/judge-spawn.test.mjs", "we:scripts/operations/run-record.mjs", "we:scripts/operations/__tests__/run-record.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-stderr-redaction.test.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards.test.mjs"]
dateOpened: "2026-10-10"
preparedDate: "2026-10-18"
preparedAgainstSha: "4eede4b775e990b4092ec06f6fd707bee1e660bf"
tags: []
---

# Prevention — compact saved requests, validate fallback envelopes, and redact judge stderr

Filed mechanically on approval of web-everything/web-everything#4865. Preserve all three owed guards: compact saved judge requests, reject incomplete fallback result envelopes, and sanitize stderr before diagnostics or persistence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4865@f6d2033ddc3ce6e788277998028ffb441223f204

## Design

### Saved request identity and migration

Persist each successful saved seat with `requestHash`, never a full `request`. Add a shared request-digest helper in `we:scripts/operations/parallel-judges.mjs`, beside `sameJudgeRequest` at `we:scripts/operations/parallel-judges.mjs:85`. Hash the UTF-8 bytes of `JSON.stringify(request)` with SHA-256, yielding exactly 64 lowercase hexadecimal characters. Preserve serialization order and all fields, including mandate, input, shape, model, tools and `skipSpawn.answer`; do not sort or omit keys. Serialization that throws or yields no string returns an invalid identity, never a reusable sentinel. Full requests remain available for live batch execution.

In `we:scripts/operations/cli-adapter.mjs:1051`, normalize restored entries to a stored digest. An own `requestHash` is authoritative: malformed, missing-value or mismatched digests cannot fall back to a legacy request. Only entries with no digest property may derive one from a serializable legacy `request`; this preserves the existing byte-for-byte JSON identity. Invalid identity must be removed from both the restored map and the working record's saved list, so it neither blocks batching at `we:scripts/operations/cli-adapter.mjs:1126` nor survives the carry-forward save at `we:scripts/operations/cli-adapter.mjs:1077`.

At the reuse comparison in `we:scripts/operations/cli-adapter.mjs:1138`, require the same step name, matching pending step index and valid equal request digests. A valid-shaped but stale digest or wrong index discards only that answer and runs that seat again. Keep fresh in-memory batch results reusable through the same identity rule. Failed fresh seats retain their current failure handling.

At `saveRemainingSeats` in `we:scripts/operations/cli-adapter.mjs:1075`, normalize both the carry-forward list and every successful map entry. A loaded digest-only entry must keep its stored digest, not hash its absent request. A fresh seat derives its digest from the request. Omit unidentifiable answers while still recording real spawn spend. Preserve result values, timestamps and `telemetryRecorded`; fail → resume → fail → resume must keep the remaining saved answers reusable without double charging. Legacy entries migrate on the next save; do not rewrite historical records separately.

Keep structural saved-seat validation at `we:scripts/operations/run-record.mjs:530`: non-array lists, absent step names and negative/noninteger indexes remain record errors. Digest validation belongs to answer reuse, so one malformed identity cannot make the entire record unreadable. `driveRun` still defaults to sequential execution at `we:scripts/operations/cli-adapter.mjs:1022`; only the saved representation changes by default. The request-provided answer shortcut at `we:scripts/operations/cli-adapter.mjs:932` still spawns nothing, and its entire request participates in identity.

### Fallback result envelope

Tighten only the reverse line scan in `we:scripts/lib/judge-spawn.mjs:716`. Accept a candidate only when it is a non-array object with a non-empty string `session_id` and at least one own `structured_output`, `result` or `is_error` property. Continue scanning past incomplete trailing objects; if no candidate qualifies, retain the marked unparseable-stdout error and existing retry behavior. A result-less error envelope must remain eligible: `session_id` plus `is_error` and `stop_reason: 'tool_use'` with a supplied budget must still reach `JudgeBudgetError` at `we:scripts/lib/judge-spawn.mjs:757`.

Leave whole-document JSON handling and the downstream structured-output object requirement intact. This checks shape, not authenticity: a forged complete envelope is outside this guarantee.

### Stderr sanitation at producer and consumer boundaries

Reuse `redactCommandLine` from `we:scripts/operations/command-redact.mjs:115` without changing its policy. Sanitize before taking any excerpt, interpolating diagnostics, copying exposed stderr or persisting it. The helper neutralizes C0/C1/DEL controls, masks supported credential shapes and bounds its input to 4096 characters with a truncation marker. For single-line snippets, collapse whitespace before redaction; never tail-slice raw text first. Long diagnostics may lose their original final bytes. The guarantee covers stderr-derived content, not the formatting newlines of an error message or secrets separately supplied in stdout/result text.

Cover this complete sink inventory in `we:scripts/lib/judge-spawn.mjs`:

- `stderrSnippet` at `we:scripts/lib/judge-spawn.mjs:228`: sanitized 160-character retry/summary excerpts.
- `JudgeUnparseableError` at `we:scripts/lib/judge-spawn.mjs:234`: message's 600-character excerpt, 1000-character `stderrTail`, telemetry, and copied `failedAttempts[].stderrTail`. The constructor must sanitize caller-supplied attempt entries without mutating the caller's array.
- `JudgeTimeoutError` at `we:scripts/lib/judge-spawn.mjs:268`: message excerpt and `partialStderr`; the latter becomes sanitizer-bounded rather than an unbounded raw copy.
- `JudgeBudgetError` at `we:scripts/lib/judge-spawn.mjs:304`: stderr excerpt.
- `parseJudgeOutcome` at `we:scripts/lib/judge-spawn.mjs:727` and `we:scripts/lib/judge-spawn.mjs:775`: unparseable and result-less error excerpts.
- Failed-attempt capture at `we:scripts/lib/judge-spawn.mjs:976` and retry log at `we:scripts/lib/judge-spawn.mjs:983`: sanitize on retry-then-success as well as exhaustion; preserve exit code, signal, attempt count and timing evidence.

Defensively sanitize independently supplied `stderrTail` in `normalizeJudgeTelemetry` at `we:scripts/operations/run-record.mjs:163` and `seatFailureEvidence` at `we:scripts/operations/parallel-judges.mjs:97`, before their 1000-character limits. Batch logs then consume that sanitized evidence. Other error-message text supplied by arbitrary callers is outside this stderr boundary; examples are the error result at `we:scripts/operations/cli-adapter.mjs:1421` and raw error object retained at `we:scripts/operations/parallel-judges.mjs:126`.

### Prevention gate

Add a pure detector and explicit three-module file list in `we:scripts/check-standards-rules.mjs`; wire it into `we:scripts/check-standards.mjs` using the file-list/detector/diagnostic pattern at `we:scripts/check-standards.mjs:1604`. The guarded modules are `we:scripts/lib/judge-spawn.mjs`, `we:scripts/operations/parallel-judges.mjs` and `we:scripts/operations/run-record.mjs`.

Check executable expressions at the named sinks above. Accept a direct shared-sanitizer call or a locally bound sanitized value whose producer is checked. Reject raw interpolation, raw slices assigned to exposed/persisted fields, a raw alias substituted for a sanitized binding, and a removed or bypassed sanitizer. Comments, string literals mentioning the helper and unused imports do not establish sanitation. Report the affected file and line. Missing/unreadable guarded files or an unrecognized sink form must produce a diagnostic rather than silently skip coverage. Keep this an explicit, bounded source contract for these sinks; no repository-wide taint-analysis claim or exemption switch.

## MVP

Must deliver the digest save/restore/migration path, stricter fallback envelope, all inventoried stderr boundaries and the wired prevention gate together, with their matching test files in scope. Implement in that order so the guard checks the final sanitation expressions. Existing callers receive the behavior without a new opt-in, routing change or record migration command. Keep sequential execution, retry settings, model defaults and the health reader's size cap unchanged.

Could extend sanitation to stdout/result text or other subprocess providers later; those require their own sink inventory and are designed as follow-ups below. They are not prerequisites for this bounded fix.

## Acceptance

Each named regression below is to be authored in the indicated file and run through the heavy queue as specified in Test plan. Each case includes a new assertion that fails against the current implementation and passes after delivery; compatibility assertions within the case may already pass today.

- [A1] Executable — `we:scripts/operations/__tests__/cli-adapter-prefilled-seats.test.mjs`, test `digest-only saves survive two failed resumes without duplicate spend`: serialize/reload real adapter records, require 64-character digests with no saved requests, preserve timestamps/results and reuse digest-only seats across repeated failures with once-only costs. Parameterize resumed calls with omitted `parallelJudges` (the sequential default) and `true`. RED today: saved request copies and failure to reuse digest-only seats.
- [A2] Executable — `we:scripts/operations/__tests__/cli-adapter-prefilled-seats.test.mjs`, test `saved identity fails closed and legacy entries migrate`: cover wrong step index, changed request fields, digest precedence, absent/malformed identity, throwing/non-string serialization and removal before batching/carry-forward; retained legacy entries rewrite to digests. Include malformed digest plus matching legacy request and valid digest without a request. RED today: legacy rewrite, digest precedence and wrong-index reuse. Pair with `we:scripts/operations/__tests__/run-record.test.mjs` structural compatibility cases so an invalid digest discards an answer, not the record.
- [A3] Executable — `we:scripts/operations/__tests__/parallel-judges.test.mjs`, test `review caller saves compact seats below the health reader cap`: exercise the real review loop's save/resume caller, compare identical old/new records differing only in saved request representation, require old UTF-8 size above 8 MiB and new size below the exported cap, and require the isolated health probe to skip the old record but return the new run ID. RED today: full saved requests and missing compact record.
- [A4] Executable — `we:scripts/lib/__tests__/judge-spawn.test.mjs`, test `fallback ignores incomplete trailing envelopes and preserves budget errors`: a trailing verdict-only object cannot replace a preceding valid result; invalid/absent session identity and marker-only objects do not qualify, and no eligible envelope yields the marked parse error. Include valid noisy result-less budget errors, CRLF and whole-document compatibility. RED today: trailing `structured_output` replaces the preceding answer.
- [A5] Executable — `we:scripts/lib/__tests__/judge-spawn.test.mjs`, test `stderr is sanitized before every diagnostic and exposed field`: fake spawn failures/retries/timeouts and direct exported-error constructors must mask supported credentials and neutralize controls across every inventoried stderr surface, retain useful numeric evidence, and enforce 160/600/1000-character excerpts plus bounded `partialStderr`. Include retry-then-success, exhaustion and long/truncation-boundary secrets. RED today: raw secret leakage and unbounded timeout stderr.
- [A6] Executable — `we:scripts/operations/__tests__/run-record.test.mjs`, test `telemetry sanitizes independent stderr before truncating`, and `we:scripts/operations/__tests__/parallel-judges.test.mjs`, test `batch evidence sanitizes independently supplied stderr`: independently constructed raw errors/telemetry must be safe after normalization and in captured batch logs, with exit code, signal and attempts preserved. RED today: both boundaries copy raw tails.
- [A7] Executable — `we:scripts/__tests__/check-standards-rules-stderr-redaction.test.mjs`, test `guard rejects each raw sink and sanitizer bypass`, and `we:scripts/__tests__/check-standards.test.mjs`, test `standards invokes stderr guard and fails closed`: fixture mutations of every inventoried sink, alias bypasses, missing inputs and cosmetic helper mentions must produce file/line diagnostics; restored sanitized fixtures pass. The real gate must reject a temporary checkout with a bypass and accept its restored form. RED today: no detector or wired rejection exists.

## Test plan

The two planned files are `we:scripts/operations/__tests__/cli-adapter-prefilled-seats.test.mjs` and `we:scripts/__tests__/check-standards-rules-stderr-redaction.test.mjs`; all four other scoped test files exist. Keep adapter identity cases in the former, review-caller and batch evidence cases in `we:scripts/operations/__tests__/parallel-judges.test.mjs`, spawner cases in `we:scripts/lib/__tests__/judge-spawn.test.mjs`, structural/telemetry cases in `we:scripts/operations/__tests__/run-record.test.mjs`, and gate invocation cases in `we:scripts/__tests__/check-standards.test.mjs`.

Use the real adapter with injected judges and a temporary serialized run store. Test unchanged and changed mandate/input/shape/model/tools/`skipSpawn.answer`, key-order sensitivity, wrong index, invalid digest (including an own undefined value), digest precedence, legacy migration, and fail → resume → fail → resume. Unit-test the digest helper with undefined, cyclic and throwing-serialization inputs. A missing request plus malformed digest already respawns today: it is a compatibility case, not independent RED evidence. For `skipSpawn`, synthesize a request carrying an answer beside a failed sibling; verify the shortcut avoids provider calls, and that a changed supplied answer changes identity. Exercise invalid-load filtering followed by another failure so discarded entries cannot return through the carry-forward list.

Update existing request-dependent assertions at `we:scripts/operations/__tests__/parallel-judges.test.mjs:205`, `we:scripts/operations/__tests__/parallel-judges.test.mjs:236` and `we:scripts/operations/__tests__/parallel-judges.test.mjs:239`: derive the lens from known step/answer fixtures and tamper with the digest or an explicit legacy record. Preserve the existing once-only spend assertions at `we:scripts/operations/__tests__/parallel-judges.test.mjs:226`.

For the large-record fixture, use repeated large request input on multiple saved seats, small fixed findings and an unchanged pending request. Measure `Buffer.byteLength(JSON.stringify(record), 'utf8')` for the complete old/new record; assert both sides of the cap. Vary payload length and seat count to show saved identity metadata depends on seat count rather than request length. This proves removal of duplicated requests, not a universal run-size bound.

Spawner fixtures cover assignment/flag secrets, authorization headers, URL credentials, known credential prefixes, controls embedded in names/values, and tokens crossing excerpt/truncation boundaries. Capture logs and inspect error messages, stderr properties, failed-attempt entries and telemetry. Assert secrets absent; do not require preservation of the final raw stderr marker. Replace the old long-stderr expectations at `we:scripts/lib/__tests__/judge-spawn.test.mjs:1354`, `we:scripts/lib/__tests__/judge-spawn.test.mjs:1363` and `we:scripts/lib/__tests__/judge-spawn.test.mjs:1370` with sanitation/truncation assertions, retaining numeric evidence and first-line bounds. Preserve short benign stderr diagnostics. Whole-document JSON success/error/budget cases and the valid noisy envelope at `we:scripts/lib/__tests__/judge-spawn.test.mjs:1462` remain compatibility coverage. Also reject primitive/array candidates and empty/non-string session identities in fallback fixtures.

For the guard, use minimal source fixtures and copies of the real sink code; mutate one sink at a time. Test comments, unused imports, raw aliases, removed sanitation and sanitizing only after a raw cut. Missing guarded inputs and unknown sink shapes fail closed. Run real gate integration in a temporary checkout, following the isolated fixture approach already in `we:scripts/__tests__/check-standards.test.mjs`; never mutate the working sources for a proof.

All test execution uses `node <admission> run -- npx vitest run <test-file>` (optionally `-t <case>`), where `<admission>` is `we:scripts/readiness/heavy-admission.mjs` and `<test-file>` is one or more of the six scoped test paths. Remove display-only `we:` prefixes when executing filesystem arguments. Run `node <admission> run -- npm run check:standards` after affected suites. No bare test runner or live provider credentials.

## Proof plan

During delivery, run the new named regressions before implementation and capture their expected failures; after implementation run the six scoped suites and the standards gate through heavy admission. Record which assertions were RED and which preserve existing behavior, rather than claiming that every compatibility fixture must fail initially.

Capture the injected-judge fail/save/reload/resume sequence with saved-seat keys, digest format, spawn count, timestamps, total recorded cost and serialized byte counts. Repeat failure before all saved answers are consumed to prove digest carry-forward. Include the actual review caller in the same evidence, not only the pure digest helper.

For cap proof, call `probeOperationRuns` at `we:scripts/conveyor/health-watch.mjs:322` with only the temporary fixture root, an isolated empty jobs root and a controlled `nowMs` near the written files' real mtime. The exported per-file cap is at `we:scripts/conveyor/health-watch.mjs:310`; the size/recency filter is at `we:scripts/conveyor/health-watch.mjs:346`. Prove the old-format over-cap record is skipped and the compact fixture's exact run ID is returned. Never inspect host run directories or alter the cap.

Capture rejected forged trailing output and secret-absence assertions for every stderr sink, including retry success and independently supplied telemetry. Capture a failing real-gate mutation and passing restored fixture with the new diagnostic present/absent as appropriate; an unrelated gate failure is not evidence of guard wiring. Preparation establishes source facts only, not delivered runtime behavior. The runner owns preparation stamping and its checks.

## Non-goals

No stdout authentication, arbitrary secret detection, stdout/result-text sanitation, global record-size guarantee, retention policy, historical rewrite, provider-route change or new HTTP endpoint. Keep run/session provenance and existing run-store write discipline. A digest is request identity, not author authentication.

## Follow-ups

- Other provider/subprocess stderr: inventory their constructors, logging and persistence seams before adding them to the sanitizer guard. Extend the explicit sink list and mutation fixtures together; no whole-program claim here.
- Stdout/result-text sanitation: separately inventory the stdout excerpt at `we:scripts/lib/judge-spawn.mjs:730`, parsed error text at `we:scripts/lib/judge-spawn.mjs:768` and parsed-object excerpt at `we:scripts/lib/judge-spawn.mjs:778`, then specify coverage and compatibility before implementation. Arbitrary caller error messages need the same separate review.
- Remaining record growth: if observations identify oversized findings or pending inputs, measure those fields and design their own compaction. Keep the health cap as-is; request hashing only removes saved duplicates.

## Progress

- Original review premise/scope: compact saved requests, strengthen fallback parsing and redact stderr in the adapter, spawner and run-record modules, originally sized 3. Earlier preparation expanded this to six source modules plus matching tests and size 5. The earlier nonexistent adapter test reference was `we:scripts/operations/__tests__/cli-adapter.test.mjs`; focused adapter coverage remains planned, now explicitly scoped as `we:scripts/operations/__tests__/cli-adapter-prefilled-seats.test.mjs` instead of a wildcard.
- Rechecked against current checkout `4eede4b775e990b4092ec06f6fd707bee1e660bf` on 2026-10-18. Old working citations were restore/save/compare at `we:scripts/operations/cli-adapter.mjs:1032`, `we:scripts/operations/cli-adapter.mjs:1061` and `we:scripts/operations/cli-adapter.mjs:1117`; current code places them at `we:scripts/operations/cli-adapter.mjs:1051`, `we:scripts/operations/cli-adapter.mjs:1082` and `we:scripts/operations/cli-adapter.mjs:1138`. Full requests are still persisted, so this goal is not already delivered. The old prepared-against commit is unavailable in this checkout; no claim of a complete historical diff is made.
- Corrected premise/scope: fallback still accepts any one marker at `we:scripts/lib/judge-spawn.mjs:720`; telemetry still copies unsanitized stderr at `we:scripts/operations/run-record.mjs:163`; the batch helper does likewise at `we:scripts/operations/parallel-judges.mjs:97`. Saved-seat structure already permits digest fields at `we:scripts/operations/run-record.mjs:530`; preserve that validator and reject bad identity only at reuse. Scope remains the six implementation modules and six matching test files; the sanitizer and health reader are read-only dependencies. All five preparation sections are refreshed without changing the original three-guard goal or selecting new policy.
- Concrete caller drift: review seat observations were added before the adapter restore path, and saved-request test assertions now sit at `we:scripts/operations/__tests__/parallel-judges.test.mjs:205` and `we:scripts/operations/__tests__/parallel-judges.test.mjs:236`. Existing raw-tail expectations at `we:scripts/lib/__tests__/judge-spawn.test.mjs:1354` conflict with the already-chosen bounded sanitizer at `we:scripts/operations/command-redact.mjs:119`; the test plan explicitly replaces them. Invalid-load entries must also leave the saved record because `we:scripts/operations/cli-adapter.mjs:1077` otherwise carries them forward. These are implementation/test corrections, not unresolved design forks.
- Size stays 5 (old 5 → new 5). Current touch estimate: adapter ~80 lines across restore/save/compare at `we:scripts/operations/cli-adapter.mjs:1051`; batch helper ~30 around identity/evidence at `we:scripts/operations/parallel-judges.mjs:85`; spawner ~65 across constructors/parser/retry at `we:scripts/lib/judge-spawn.mjs:228`; telemetry ~10 at `we:scripts/operations/run-record.mjs:163`; source guard ~100 following `we:scripts/check-standards-rules.mjs:4598`; gate wiring ~20 following `we:scripts/check-standards.mjs:1604`; six test files ~360 total. Approximately 665 changed lines across twelve files, with no added runtime or cross-repository dependency. This is a story; no estimatedLoc field is added.
- Preparation only: executable acceptance replaces the previous prose-only guarantees and includes changed persistence defaults, actual callers and fail-closed paths. Existing stamps and all other frontmatter are preserved except the concrete test scope. No claim, resolution, new lane, commit, push or PR; stamping belongs to the runner.
