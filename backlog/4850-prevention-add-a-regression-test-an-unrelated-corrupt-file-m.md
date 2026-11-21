---
bornAs: xlz0cwo
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/timeout-retry-state.mjs", "we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/timeout-retry-state.test.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/operations/__tests__/ci-ghost-rerun.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-11-21"
preparedAgainstSha: "f8140d8cbd1ad6b28a197dbed6f9ccf2eba95b8c"
tags: []
---


# Prevention — Isolate timeout-state corruption, bound failure identities, and reject dependency-resolution fallbacks

Retain the prevention goals filed on approval of chalbert/web-everything#3559: unrelated corrupt state must not change another PR's budget; pending closed/aged-out PRs must stop polling; timeout failure identities must be bounded before scaffold interpolation; deleted dependencies must not become eligible through resolution fallbacks.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3559@73b10d286aa18f8c6d50968d32ddacf073f25f6a

## Progress

Preparation research against checkout f8140d8cbd1ad6b28a197dbed6f9ccf2eba95b8c. This is a source inspection, not a claim that new regression tests have run. Runner-owned preparation stamps are unchanged.

- Old premise: three outstanding guards in six files; citations reflected October's layout. Corrected premise: those guards remain outstanding, with a seventh test file required for the shared ghost-rerun caller. The new reader test file is still absent. Original size 3 remains size 3: approximately 30 changed lines in the reader, 30 in the classifier, 25 in the follow-up producer, and 70/90/60/35 in their four test files (about 340 lines total). No new subsystem or policy fork is required.
- Corruption validation still precedes identity filtering at `we:scripts/conveyor/timeout-retry-state.mjs:11`; JSON parsing also happens before filtering. Canonical presence suppresses legacy scanning. Thus the old proof's valid state must be a **legacy** file: a valid canonical file already ignores corrupt siblings. Matching legacy spend is imported by dispatch at `we:scripts/operations/ci-heal-pr-dispatch.mjs:994`.
- Pending retirement is already implemented at `we:scripts/operations/ci-heal-pr-dispatch.mjs:933`; closed and age-cap regressions exist at `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs:753` and `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs:764`. Preserve these; no retirement implementation is needed.
- Parser and impact walk moved to `we:scripts/conveyor/reconcile-pass.mjs:1989` and `we:scripts/conveyor/reconcile-pass.mjs:2019`. Failure path/name remain unbounded individually; follow-up interpolation is at `we:scripts/operations/ci-heal-pr-dispatch.mjs:907`. Persisted evidence bypasses reparsing, so parser-only restriction would leave historical state exposed: bound the producer too.
- Old scope claimed all documentation changes refuse. Current code deliberately permits backlog-only diffs; preserve the cases at `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs:1590`. Other documentation/config/data changes still refuse. The ordered resolution candidates still check only the resolved head file, missing deleted earlier candidates.
- Caller audit: `we:scripts/operations/ci-ghost-rerun.mjs:128` defaults to the shared reader; `we:scripts/operations/__tests__/ci-ghost-rerun.test.mjs:401` pins throwing-reader refusal and line 410 pins default wiring. Add a real-reader sibling-corruption case there. Infra budgets also consume the reader (existing coverage in `we:scripts/operations/__tests__/ci-heal-infra-dispatch.test.mjs:53`): the old claim that all shared spend is capped at two was inaccurate; dispatch uses a separate infra cap at `we:scripts/operations/ci-heal-pr-dispatch.mjs:1002`. This item changes neither cap.

## Design

1. In `we:scripts/conveyor/timeout-retry-state.mjs`, distinguish canonical reads from the legacy directory scan. Canonical parse/shape failures continue to throw. For legacy entries, read errors still throw; catch JSON syntax errors per entry and skip them, skip non-object/missing-evidence entries, and compare repo/pr/head before validating version and requests. Matching evidence with invalid version/requests still throws. Keep canonical precedence, valid legacy aggregation, pending accounting, rejected/released accounting and public return shapes unchanged.

   Retain the card's existing explicit trade-off: unattributable malformed legacy JSON is skipped, even if it once belonged to this PR. Its spend cannot be recovered or attributed. This is not a guarantee that historical spend remains globally capped; canonical state remains fail-closed. No permission/read error is reclassified as unrelated corruption.
2. In `we:scripts/conveyor/reconcile-pass.mjs`, reject parsed paths outside `/^[\w@./+-]+$/` or longer than 256 characters and names longer than 300 characters or containing C0/C1 controls or Unicode line/paragraph separators. Validate after ANSI/timestamp removal and before trimming away identity controls. Existing ANSI transport and ordinary suite separators remain accepted. Return the existing incomplete-failure-inventory refusal, with no partial failures, so classification authorizes no retry. The visible reason leaves investigation to the existing CI-heal/operator path; do not truncate evidence into eligibility.
3. In `we:scripts/operations/ci-heal-pr-dispatch.mjs`, bound the display fields from persisted failure evidence immediately before constructing a new scaffold digest: replace controls and Unicode line separators with spaces and cap path/name display text at 256/300 characters. Preserve raw persisted evidence and already-persisted card payloads/identity. This producer protection covers historical state that never passed the new parser. It does not authorize retries or reinterpret historical signatures. Keep the existing scope derivation separate from display text; this guard is single-line/length safety, not a general prompt-injection guarantee.
4. In `we:scripts/conveyor/reconcile-pass.mjs`, once a relative dependency resolves, inspect candidates strictly before that resolved candidate. If an exact candidate appears in changed filenames or previous filenames, return changed-dependency naming it. Bare candidates match exact filenames only. Keep unresolved edges fail-closed, preserve the existing candidate order and backlog-only exception, and keep later unrelated candidates eligible. Comparing base resolution remains a follow-up.

## MVP

Ship the shared-reader isolation and caller regression, parser bounds plus historical producer display protection, and conservative earlier-candidate refusal. Preserve existing retirement behavior, retry caps, canonical precedence and the backlog-only exception. No new settings, filesystem cleanup, GitHub calls, or base-tree fetches.

## Acceptance

Each labeled test below is a proposed regression group: its new defect case must fail on the pre-build checkout and pass after implementation. Pair preserved fail-closed assertions inside the same group; those individual assertions may already pass.

- [A1] Executable — `we:scripts/conveyor/__tests__/timeout-retry-state.test.mjs`, test `isolates legacy corruption without resetting attributable budget`: compare budgets with/without malformed JSON, missing evidence, null entries and mismatched repo/pr/head with invalid shapes; include matching valid legacy spend. Pair matching corrupt state, canonical corruption and read errors with unreadable/pending assertions, and pin canonical precedence and released accounting.
- [A2] Executable — `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs`, test `imports legacy budget despite unrelated corrupt siblings`: real-reader dispatch succeeds with an unrelated sibling, imports prior confirmed spend, and does not exceed the existing timeout cap. Pair matching-corruption refusal with zero observe/request effects and unchanged state. This covers the changed default migration path, not an injected empty reader.
- [A3] Executable — `we:scripts/operations/__tests__/ci-ghost-rerun.test.mjs`, test `real shared reader isolates siblings and preserves own-state refusal`: unrelated corruption permits the otherwise valid fixture; matching/canonical corruption refuses before any POST or reservation. Use the actual imported reader, retaining existing default-wiring tests.
- [A4] Executable — `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`, test `rejects unsafe timeout identities without authorizing a retry`: overlong paths/names, unsafe path characters, controls and Unicode separators produce complete:false and classifier eligible:false with incomplete-failure-inventory; failures are empty. Boundary lengths, ANSI transport and normal names still classify normally.
- [A5] Executable — `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs`, test `bounds legacy failure display before scaffold filing`: seed historical canonical state with two confirmed requests and unsafe failure display text, invoke flush with a recording fileFollowup, and assert each failure bullet stays one bounded line. Pin unchanged evidence and idempotent replay of the saved payload; assert no rerun request occurs.
- [A6] Executable — `we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`, test `refuses removed earlier resolution candidates`: removed and renamed-away earlier extensions/index candidates cause changed-dependency and classifier ineligibility even when a later candidate survives. Pair later-candidate and exact-bare-name controls with existing unresolved, non-source/config/data refusals and backlog-only eligibility.

## Test plan

Use temporary directories under the task's `$TMPDIR` and injected effects only. Add the named tests to the four scoped test files, using existing fixtures and vi.importActual for the mocked ghost reader. For A1/A2, absence of the canonical file is essential: seed valid legacy spend and add corrupt siblings separately, rather than combining them into an ambiguous failure. Test repo, PR and head mismatches independently. For A4 test 256/257 path and 300/301 name boundaries, embedded and trailing controls, and multiple failures with one invalid entry. For A6 use removed and previous_filename entries with extensionless imports and ordered head candidates; verify the public classifier as well as the helper.

Run A1–A6 through the host queue with a single bounded admission wait. Command template: invoke `node` on `we:scripts/readiness/heavy-admission.mjs` with `run --wait-ms=60000 -- npx vitest run`, followed by the selected test filenames. Repository prefixes identify references here; strip `we:` when passing filenames from the WE repository root. Run the four scoped test files, plus existing infra dispatch coverage in `we:scripts/operations/__tests__/ci-heal-infra-dispatch.test.mjs` as a compatibility check. Do not weaken existing retirement, budget or backlog-only assertions. If admission remains busy after that wait, stop and report.

## Proof plan

The builder first adds the new regression groups and records their failing assertions against the unchanged implementations, then implements the guards and records the same groups passing through the queue. Use the current checkout baseline, not a moving remote branch or a new worktree. A1's fixture is the reproducible budget probe: record the valid legacy budget without siblings, the current unreadable result with siblings, and the corrected identical budget after implementation. Canonical and matching legacy corruption must still block; A2/A3 verify zero effects on those paths. A4/A6 prove classifier refusal; A5 inspects the actual recorded scaffold payload from historical state. Run `npm run check:standards` through the same admission wrapper after the targeted tests. Preparation itself changes only this card; the runner owns preparation checks and stamps.

## Follow-ups

- Add a static check:standards rule for unbounded interpolation of timeout failure fields; runtime parser/producer guards are this item's chosen branch.
- Compare dependency resolution against the base tree instead of conservative candidate-order refusal.
- Consider quarantining unattributable legacy garbage with an explicit recovery policy; do not delete it in this change.
