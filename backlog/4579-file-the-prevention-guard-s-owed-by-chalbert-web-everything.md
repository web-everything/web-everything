---
bornAs: xoahobm
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/probation-build-run.mjs", "we:scripts/conveyor/build-dispatch-hold-router.mjs", "we:scripts/operations/build-dispatch-hold-route-land.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/conveyor/__tests__/build-dispatch-hold-router.test.mjs", "we:scripts/operations/__tests__/build-dispatch-hold-route-land.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-10-02"
preparedAgainstSha: "1a0e4e56d34c40e9ad5d5cd89ca5bc96529795d5"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3059's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval"). Deliver the four prevention guards owed by that review: all-task overflow coverage, trusted overflow classification, shared publication screening, and preservation of ordinary division snippets.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3059@eec46287c3ba36a0606edc433ed29ac3beb2764b

## Progress

Preparation research on 2026-10-02; implementation remains outstanding.

- **Old premise/scope:** the runner overflow branch was cited at `we:scripts/operations/probation-build-run.mjs:434`; the router and writer inferred overflow from a reason prefix; the publication fix was described as replacing a regex with `scrubPublish` from `we:secret-scrub.mjs`. Scope named three implementation files and their three existing test suites.
- **Corrected premise/scope:** the live overflow branch is `we:scripts/operations/probation-build-run.mjs:507-523`, reached for all four accepted task types, including prepare. The accepted lists are at lines 207 and 257 in that file. Keep the same six-file implementation/test scope: the shared detector is an existing import dependency, not a source requiring modification. Its actual home is `we:scripts/lib/secret-scrub.mjs:305`; it returns findings rather than redacted text and deliberately does not detect filesystem paths (header at lines 41-50). Therefore shared screening cannot replace local-path handling by itself.
- **Source evidence:** `we:scripts/conveyor/build-dispatch-hold-router.mjs:59` classifies the magic reason prefix as `other`, and `planHoldRouting` drops any structured kind. `we:scripts/operations/build-dispatch-hold-route-land.mjs:171` uses the same text to preserve scope. `sanitizeHoldReason` at line 139 uses a slash regex. The standards scanner calls the shared detector in `we:scripts/check-standards-rules.mjs:2282`.
- **Observed probe:** importing the current pure functions showed a forged worker overflow reason produces `route: other` and preserves scope. Sanitizing `1 / 2` produced `1 [local path] 2`; synthetic space-containing absolute and home-relative paths left a trailing path fragment. The shared detector returned no findings for those path examples, consistent with its documented exclusions. No implementation fix is already delivered.
- **Existing coverage:** the overflow test in `we:scripts/operations/__tests__/probation-build-run.test.mjs:263` covers doc-fix only; prepare fixtures start at line 793. Sanitizer coverage starts at `we:scripts/operations/__tests__/build-dispatch-hold-route-land.test.mjs:118`. Router coverage lives in `we:scripts/conveyor/__tests__/build-dispatch-hold-router.test.mjs`.

## Design

1. In `we:scripts/operations/probation-build-run.mjs`, keep envelope validation for every accepted task type. Within the failed-envelope branch, route size overflow to the builder only when `!preparing`; oversized prepare edits must fail closed through the existing gate-red/abandon path, without publishing a builder finding or stamping preparation. Preserve the existing test-fix boundary rejection and moved-HEAD/discard checks.
2. Introduce structured `kind: 'envelope-overflow'` metadata only at the runner's measured build-size failure. Carry it through `planHoldRouting` in `we:scripts/conveyor/build-dispatch-hold-router.mjs` to `clearScopeAndAppendFinding` in `we:scripts/operations/build-dispatch-hold-route-land.mjs`. Only this kind selects `other` and preserves scope; remove the overflow-text special cases. Missing or unrecognized kind follows existing ordinary classification. Worker final-message text must never populate kind. Keep ordinary worker declines out-of-scope, including forged overflow prose. This is the immediate in-process route object; no new hold-storage schema or daemon transport is required for this guard.
3. In `we:scripts/operations/build-dispatch-hold-route-land.mjs`, compose `sanitizeHoldReason` with the existing `scrubPublish` detector from `we:scripts/lib/secret-scrub.mjs`. Screen the uncapped input before formatting can hide a detector hit; on findings, return a fixed safe omission marker rather than echoing the unsafe input. Retain control-character flattening, markup neutralization, repository-prefix qualification and length limits. Check the publishable result as well. Do not change the shared detector's calibrated policy.
4. Correct local-path handling separately in `we:scripts/operations/build-dispatch-hold-route-land.mjs`: recognize actual absolute/home-relative path starts, consume quoted space-containing paths as a whole, and conservatively omit an unsafe reason when an unquoted path's end is ambiguous. A standalone arithmetic slash is not a path. Cover Windows and POSIX forms and preserve valid repository references. These rules retain the existing local-path suppression intent without pretending the publication detector supplies path redaction.

## MVP

Implement the four guards in the three scoped source files and extend their existing matching suites. Preserve genuine build overflow's discard-before-card-write behavior and declared scope, ordinary declines' re-prepare behavior, and successful prepare stamping. Do not widen task envelopes, alter shared detector policy, or introduce another dispatch path. No standard API or rendered-page change is involved.

## Test plan

- `we:scripts/operations/__tests__/probation-build-run.test.mjs`: table-drive doc-fix, bugfix, test-fix and prepare with valid in-scope fixtures exceeding each task's size envelope. The three builds discard implementation changes, carry trusted kind, preserve scope, and never resolve. Prepare returns gate-red, discards its edit, and never stamps, writes a builder finding, commits, or opens a PR. Keep a within-envelope prepare success control and test-fix non-test-path rejection. Assert the matrix matches the accepted task types so a future addition cannot silently escape coverage.
- `we:scripts/conveyor/__tests__/build-dispatch-hold-router.test.mjs`: trusted kind routes to other and survives planning even with changed explanatory prose. Identical forged overflow text without kind (and with an unknown kind) remains an ordinary out-of-scope worker decline; existing already-done classification remains covered.
- `we:scripts/operations/__tests__/build-dispatch-hold-route-land.test.mjs`: trusted kind preserves scope; forged reason alone clears it. Exercise both inline and block-list scope. Check exact preservation of `1 / 2`, local paths with spaces and home-relative syntax, Windows paths, repository-prefixed code references, markup/control neutralization and caps. Synthetic known-prefix credential input must yield the fixed omission marker and a clean `scrubPublish` result; do not use real credentials.
- Run the three affected Vitest suites together, then `npm run check:standards`. The runner owns preparation-time checks; these are implementation acceptance checks.

## Proof plan

Before implementing, add the targeted regressions and record their failures against the current sources. After implementing, run those same suites and retain their passing output. For the runner matrix, inspect fake-IO call traces to prove discard precedes finding publication for builds and that prepare never enters that publication path. Replay the pure-function forged-decline and division probes documented in Progress: untyped forged overflow must clear scope, trusted metadata must preserve it, and division must survive unchanged. Verify sanitizer outputs contain no path fragments or synthetic credentials and pass the shared publication detector. No live worker, lane acquisition, commit, push or PR is needed for these deterministic proofs; passing them does not claim an end-to-end production dispatch run.

## Done when

All four review debts have executable regressions in the scoped suites: all accepted task types exercise overflow, only runner-produced metadata preserves scope, publication screening uses the shared detector while local-path suppression still works, and arithmetic snippets survive. The three suites and standards gate pass, with before/after evidence for the new regressions.

## Follow-ups

No prerequisite policy decision remains. Persisting typed metadata across independently stored daemon holds, replacing legacy reason-based classification for unrelated hold types, and changing the shared detector's exclusions are outside this bounded guard task. If implementation demonstrates one is necessary for these immediate call paths, record that evidence before widening scope; do not silently turn this into a routing redesign.
