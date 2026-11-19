---
bornAs: xln1ya7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/sweep-orphan-backlog-cards.mjs", "we:scripts/lib/open-pr-items.mjs", "we:scripts/operations/machine-pr-title.mjs", "we:scripts/lib/forge-land-provider.mjs", "we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs", "we:scripts/lib/__tests__/open-pr-items.test.mjs", "we:scripts/operations/__tests__/machine-pr-title.test.mjs", "we:scripts/lib/__tests__/forge-land-provider.test.mjs", "we:scripts/lib/prevention-card-heading.mjs", "we:scripts/lib/__tests__/prevention-card-heading.test.mjs", "we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/__tests__/land-prevention-card.test.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.approval-prevention-filing.test.mjs", "we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/accept-carry-forward-retraction.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards-rules-prevention-heading.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "fb6c76988b0daba1f16e4f895934716da9222e21"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3207's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27). Preserve the four prevention debts: centralize the legacy heading/source grammar, prevent subject citations from becoming item identities, gate legacy normalization classification, and refuse absent titles at the real PR-create boundary.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3207@1b0dc6b662e73a26e6b426ae1159284dc0ea75a2

## Progress

- 2026-11-19 validation repair: the planned A2 test was scoped as we:scripts/__tests__/check-standards-prevention-heading.test.mjs, which did not match the required rule-test scope. Rename that planned file to we:scripts/__tests__/check-standards-rules-prevention-heading.test.mjs in scope and executable acceptance; it still covers both the pure rule and runner integration. The pure-rule testing contract at we:scripts/check-standards-rules.mjs:4-11 supports this placement. No implementation scope, guarantees, size or preparation stamps changed.

- 2026-11-19 premise correction against the acquired checkout. The previous preparation said four source files plus four tests were sufficient, and cited shortened/nonexistent paths. The debt remains: duplicated grammar is at we:scripts/operations/sweep-orphan-backlog-cards.mjs:120 and :128, we:scripts/operations/machine-pr-title.mjs:47 and :63, we:scripts/operations/land-prevention-card.mjs:546, we:scripts/operations/review-loop-cli.mjs:267, we:scripts/review-set-label.mjs:1023, and the additional strict notice consumer we:scripts/lib/accept-carry-forward.mjs:180. Scope now includes these consumers, their matching tests, the new shared module/test, and the standards rule, runner wiring and integration test. No implementation or delivery was inferred from the prior preparation commit 8d6f63dacf.
- The old Design prescribed sanitization in cleanTitle while its amendments correctly prohibited it. Consolidated below: sanitize only the subject in machinePrTitle. The broad scan remains at we:scripts/lib/open-pr-items.mjs:48. The old purported alphanumeric example `WE #4645:` was numeric; use `WE #x4645:`. Preserve numeric zero-padding and branch-derived identities.
- The old legacy-table claim confused missing coverage with a behavioral failure and claimed shadowing without an example. Current normalization is ordered conditional logic at we:scripts/operations/machine-pr-title.mjs:82; the new table/coverage contract is absent, but existing classifications are characterization assertions, not claimed red observations. Preserve the current mapping rather than adding review-prep semantics to legacy titles.
- The old create test citations moved: successful title-less fixtures are at we:scripts/lib/__tests__/forge-land-provider.test.mjs:101 and :134. The real create boundary is we:scripts/lib/forge-land-provider.mjs:168; its builder still permits missing titles at :86. The production getter is at we:scripts/pr-land.mjs:957. Keep pure-builder dry-run behavior and update successful create fixtures explicitly.
- Size remains 3: this is a bounded shared-grammar refactor plus three small guards, not a new policy. No estimatedLoc is added to this story. Preparation only; existing preparation stamps are left for the runner. Source inspection established the outstanding paths; no before/after execution is claimed here.

## Design

1. Add we:scripts/lib/prevention-card-heading.mjs as the sole owner of the legacy heading text and escaped source grammar. Export text/regex fragments plus heading builder and source matcher. Preserve existing case, anchors and capture semantics at each caller: markdown headings, unprefixed titles, grep's basic-regex pattern, and the “Filed” notice are different envelopes around shared text. Do not substitute a JavaScript regex directly into git grep. Migrate every production occurrence listed in Progress. Keep current descriptive prevention titles unchanged. In we:scripts/lib/accept-carry-forward.mjs, replace only the shared fixed-text fragment; retain trusted-author/marker checks, bounded source fields, exact trailing text and full-input equality.
2. Add a pure literal-duplication rule in we:scripts/check-standards-rules.mjs and wire it into we:scripts/check-standards.mjs. Follow the existing script-source traversal at we:scripts/check-standards.mjs:2890. Scan production script modules, excluding tests/fixtures and the exact shared module; backlog/docs are outside this code scan. Detect both literal `guard(s) owed by` and regex-escaped `guard\(s\) owed` spellings, including constructor-string escaping. Do not reject ordinary “guard owed by”. Construct the detector without embedding a forbidden duplicate in its own implementation. Missing/unreadable scan inputs are errors, not a successful empty result; emit the offending path and actionable error. Operator recovery is to restore readable inputs or migrate the duplicate, then rerun the gate.
3. In we:scripts/lib/open-pr-items.mjs, recognize the leading `WE|FUI|PLATEAU #<alphanumeric-id>:` token case-insensitively. For recognized machine leads, scan only that id: numeric ids retain current supported length/padding; hash ids produce no title-derived number and never fall back to subject scanning. Preserve branch extraction and loose legacy-title scanning, including the review-suffix exclusion. In we:scripts/operations/machine-pr-title.mjs, replace `#` immediately before a digit with visible `＃` in the selected subject only, after provenance extraction and before bounding. Do not change cleanTitle, the lead identity, provenance suffix or preventionCardTitle. This covers both generated titles and old persisted machine titles containing citations.
4. Extract the existing ordered kind mapping and boilerplate recognition into exported legacy-template data consumed by publicationTitle in we:scripts/operations/machine-pr-title.mjs. Preserve precedence and fallback: gate-failure fix → gate-fix; prepare/complete prepare → prepare; CI-heal → ci-heal; converge/fix/address review:changes → fix; health daemon filing/file → file; otherwise build. Represent boilerplate predicates independently where they overlap kind rules. Test every alternative, default, already-normalized bypass, and missing-card refusal. Every ordered kind entry needs a witness selecting it; do not claim an existing shadowing bug without evidence. Pin expected annotation status using isAnnotationPr and delivery via deliveredItemNumsFromPr, with non-markdown changedFiles and a neutral branch so other exclusions do not hide classification.
5. At createGhLandProvider().create in we:scripts/lib/forge-land-provider.mjs, read the title exactly once into a local, validate it before building argv, and pass a plain snapshot to buildCreateArgs without re-reading the getter via object spread. Missing, undefined, null, empty, whitespace, sentinel and throwing-getter inputs must refuse before exec. Preserve valid-title publishing, body/draft behavior and throttle options. Keep buildCreateArgs's pure preview `--fill` default unchanged. The caller at we:scripts/pr-land.mjs:957 needs no source change; cover its lazy-getter shape in provider tests. A rejected create reports the title error and requires the caller to supply a concrete title, with no publish fallback.

## MVP

Deliver all four guards together: shared grammar and every consumer migrated; wired standards enforcement; machine-subject identity isolation; complete legacy normalization regression coverage; and fail-closed create validation. Include caller-fixture updates and exact notice-envelope regression tests. No new publication policy, delivery extractor redesign, or change to the pure preview builder.

## Acceptance

Run each named test file through the host heavy queue. For executable commands below, `RUN(we:<path>)` means the following executable shell function invoked with that repository-prefixed argument (run from the WE root):

```sh
RUN() { target="${1#we:}"; queue="we:scripts/readiness/heavy-admission.mjs"; node "${queue#we:}" run -- npx vitest run "$target"; }
```

- [A1] Executable — `RUN we:scripts/lib/__tests__/prevention-card-heading.test.mjs`: “shared heading round-trips all legacy envelopes” fails before the shared export exists, passes after; covers title/source capture and basic-grep compatibility. Consumer tests listed below pin unchanged historical outputs.
- [A2] Executable — `RUN we:scripts/__tests__/check-standards-rules-prevention-heading.test.mjs`: “wired gate rejects literal and escaped duplicates” and “unreadable scan refuses” fail before the rule/wiring exists, pass after. Test permitted homes, constructor escapes, harmless wording and diagnostics, plus a real runner subprocess over an isolated fixture root.
- [A3] Executable — `RUN we:scripts/lib/__tests__/open-pr-items.test.mjs`: “machine lead excludes subject citations for numeric and hash ids” fails on current broad scanning, passes after; include every repo prefix, persisted unsanitized titles, ordinary legacy titles, branch ids and padding. `RUN we:scripts/operations/__tests__/machine-pr-title.test.mjs`: “every machine kind isolates subject citations” fails before subject sanitization, passes after; preserve lead/suffix and descriptive prevention-card output.
- [A4] Executable — `RUN we:scripts/operations/__tests__/machine-pr-title.test.mjs`: “exported legacy templates have complete reachable classification witnesses” fails before the exported data contract exists, passes after. Each recognized alternative and fallback has a fixed expected kind, annotation result and delivered ids. Existing classification/boilerplate behavior is regression coverage, not a claimed pre-build behavioral defect.
- [A5] Executable — `RUN we:scripts/lib/__tests__/forge-land-provider.test.mjs`: “create refuses missing titles before publish” fails for omitted/undefined/null on the baseline, passes after. “create reads a lazy title once” catches repeated reads; empty/whitespace/sentinel/throwing getter rows, valid title/body/draft/throttle and pure preview defaults are regression rows in the same suite. Update the two title-less success callers to explicit machine titles.

## Test plan

- A1 consumer integration: extend we:scripts/operations/__tests__/sweep-orphan-backlog-cards.test.mjs, we:scripts/operations/__tests__/land-prevention-card.test.mjs and we:scripts/operations/__tests__/review-loop-cli.test.mjs with historical heading detection, source extraction and malformed-heading nonmatches. Run each with RUN.
- A1 notice pair: extend we:scripts/__tests__/review-set-label.approval-prevention-filing.test.mjs and we:scripts/lib/__tests__/accept-carry-forward-retraction.test.mjs. Assert exact producer output for existing-card and queued-job outcomes and acceptance by the consumer. Reject spoofed authors, malformed source/marker and appended arbitrary text. Run each with RUN. Shared fragments must not broaden clearance.
- A2 new integration test covers both we:scripts/check-standards-rules.mjs and we:scripts/check-standards.mjs, using injected/isolated enumeration and reads to exercise unreadable evidence without depending on host permissions. Temporary fixtures live under the task TMPDIR.
- A3 property matrix: every MACHINE_TITLE_KINDS member × WE/FUI/PLATEAU × numeric/hash lead × subjects with one/multiple `#1234` citations and bounded long text. A neutral branch isolates title-derived identities; separately pin lane branch unions and legacy title fallback.
- A4 separate witnesses for all kind alternatives and all boilerplate alternatives, with and without card metadata; normalized-title and untagged-title bypass cases. Reachability assertions apply to ordered kind rules, not intentionally overlapping boilerplate predicates.
- A5 inject exec; assert no call for all invalid inputs and one call with the captured title for a valid getter. Preserve preview-builder tests rather than weakening them.

## Proof plan

The builder records baseline and candidate SHAs and runs the same newly added tests on both through the heavy queue. Report actual red cases separately from regression-only assertions. Use the producer/consumer fixture tests above as the executable surface; no live PR creation or sweep invocation is necessary. In particular, the unrestricted sweep dry-run can require repository/service state and is not a hermetic equivalence proof.

Run the standards gate through the same queue after the targeted tests:

```sh
queue='we:scripts/readiness/heavy-admission.mjs'
node "${queue#we:}" run -- npm run check:standards
```

A2's isolated fixture proves the gate turns red on a planted duplicate and on unreadable input, then green after correction; do not plant production scratch files. If queue admission is busy, wait once using its supported wait option and report if still unavailable. The preparation worker does not stamp or execute the future implementation checks; the runner owns preparation checks and stamping.

## Follow-ups

- Consider removing the pure preview-builder missing-title fallback only after its dry-run callers supply titles; outside this card's create-boundary guarantee.
- Consider a shared lead-token parser for deliveredItemNumsFromPr separately, preserving its stricter delivery rules. No change to that classifier's policy here.
