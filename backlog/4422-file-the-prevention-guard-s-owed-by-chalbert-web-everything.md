---
bornAs: xh82kn6
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules*.test.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/backlog/scaffold.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs", "we:scripts/backlog.mjs", "we:scripts/__tests__/backlog-cli-born-as.test.mjs", "we:scripts/operations/scaffold.mjs", "we:scripts/operations/__tests__/scaffold.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-08"
preparedAgainstSha: "e9589d06683b0d301aae91ee6eb65cec127e4c88"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2856's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4361-specialist-agent-roles-a-role-registry-with-narrow-briefs-ro.md:1` — A check:standards validation rule that requires all backlog items with non-numeric filenames to have a `bornAs` frontmatter field matching their filename ID.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2856@f732f27dd6eaa0da31f346fa85e401cf970cea0f

## Progress

Preparation research corrected the original scope, which named only the review subject,
`we:backlog/4361-specialist-agent-roles-a-role-registry-with-narrow-briefs-ro.md:1`.
That card is now resolved and already carries its historical birth ID; editing it cannot implement
this prevention guard. The original goal remains: require a matching `bornAs` on non-numeric
backlog filename IDs.

The corrected scope is the per-item validator and the two scaffold callers, with matching tests.
`we:scripts/check-standards-rules.mjs:366` defines `validateBacklogItem` but contains no matching-birth-ID
check. `we:scripts/check-standards.mjs:851` already calls it for every loaded item, so no new gate
wiring is needed. The duplicate-birth check at `we:scripts/check-standards-rules.mjs:2883` ignores
missing values and detects duplicates, not filename/frontmatter disagreement.

The producer gap matters: `we:scripts/backlog.mjs:724` and
`we:scripts/operations/scaffold.mjs:151` call the shared renderer without the allocated ID;
`we:scripts/backlog/scaffold.mjs:92` starts frontmatter without `bornAs`.
The existing `we:scripts/backlog/id.mjs:92` birth-stamp helper is idempotent, and numbering calls
it at `we:scripts/backlog/id.mjs:266`. Preserve that numbering behavior while emitting the birth
ID earlier. This is a necessary compatibility correction to the guard's scope, not a new
numbering policy. Size remains **3**: one field invariant, one shared renderer input, and two
caller updates with focused regression coverage. No blocker changes are proposed.

## Design

Add a hard error to `validateBacklogItem` in `we:scripts/check-standards-rules.mjs` when the
filename-derived `num` is present and non-numeric and `bornAs` is not the identical string.
Missing, empty, non-string, and mismatched values fail. Numeric filename IDs remain exempt:
legacy numbered cards can omit `bornAs`, and numbered JIT cards retain their original hash.
Do not compare against the whole slug or require a numbered card's birth hash to equal its number.
Keep existing missing-ID diagnostics responsible for an absent filename ID.

Give the error a path-bearing descriptor for the item's frontmatter, using the existing
`backlogFile` and descriptor conventions at `we:scripts/check-standards-rules.mjs:373`.
This lets local checks attribute the finding to the changed card. Retain the existing duplicate
birth and stranded-on-main checks; they enforce different invariants.

Extend `renderItem` in `we:scripts/backlog/scaffold.mjs` with an optional birth-ID input and emit
it as frontmatter when supplied. Both `we:scripts/backlog.mjs` and
`we:scripts/operations/scaffold.mjs` must pass their final allocated hash, after collision retry.
Preserve renderer compatibility for callers without an allocated ID. Do not alter allocation,
renaming, reference rewriting, or proof-of-land lookup. The unchanged numbering helper in
`we:scripts/backlog/id.mjs:92` must continue preserving an already-correct birth field.

## MVP

- Implement the per-item hard error in `we:scripts/check-standards-rules.mjs` and its cases in
  `we:scripts/__tests__/check-standards.test.mjs`.
- Add the renderer input in `we:scripts/backlog/scaffold.mjs`, covered by
  `we:scripts/backlog/__tests__/scaffold.test.mjs`.
- Pass the allocated ID from `we:scripts/backlog.mjs`; add the planned isolated CLI test
  `we:scripts/__tests__/backlog-cli-born-as.test.mjs`.
- Pass the allocated ID from `we:scripts/operations/scaffold.mjs`, covered by
  `we:scripts/operations/__tests__/scaffold.test.mjs`.

The review subject is evidence, not an implementation target. No bulk rewrite of historical
numbered cards, role-registry changes, or new dispatch machinery belongs here.

## Test plan

In `we:scripts/__tests__/check-standards.test.mjs`, use the existing valid-item fixture and
assert a specific birth-ID diagnostic for a non-numeric filename ID with absent, empty,
non-string, or different `bornAs`. Cover matching values, numeric IDs with no birth field,
and numeric IDs with a historical hash as passing cases. Check the diagnostic's file attribution;
do not mistake an unrelated fixture error for proof of rejection.

In `we:scripts/backlog/__tests__/scaffold.test.mjs`, parse the rendered frontmatter and assert
one matching birth field when supplied, preserving the existing no-input behavior.
In `we:scripts/operations/__tests__/scaffold.test.mjs`, check the planned filename ID against
rendered frontmatter, including allocation collision/retry and both open and session-owned births.
In the planned `we:scripts/__tests__/backlog-cli-born-as.test.mjs`, run the real scaffold CLI in
an isolated temporary repository and compare the written filename ID with parsed frontmatter;
keep the working backlog untouched. Follow the existing CLI fixture isolation conventions in
`we:scripts/__tests__/backlog-cli-snapshot.test.mjs`.

Run these affected suites through the host heavy-run queue only. Also run the existing
`we:scripts/backlog/__tests__/id.test.mjs` through that queue to check birth-stamp preservation
through numbering; that file is verification-only, not a planned edit.

## Proof plan

Before implementation, add the negative validator and producer regression cases and run them
through `we:scripts/readiness/heavy-admission.mjs`: the missing/mismatched birth assertion must
fail because no birth diagnostic is returned, and producer assertions must fail because their
frontmatter lacks the field. After implementation, rerun the same suites and retain their
red/green output. The CLI proof must show the actual emitted file, not merely a source-text match.

For each test path listed above, invoke the queue with `run -- npx vitest run` followed by the
WE-relative test path (remove the documentation-only `we:` prefix). Finally invoke the queue
with `run -- npm run check:standards`. Record any unrelated baseline failures separately;
a green unit test alone is not evidence of a green repository gate. Preparation itself does
not implement these tests or claim the guard passes.

## Follow-ups

No prerequisite design decision or blocker is needed. If the implementation gate reveals other
live hash-card producers omitting `bornAs`, record their exact writer and test paths and extend
this same compatibility fix before delivery; do not weaken the guard or migrate numeric cards.
Broader backlog identity or numbering redesign remains outside this item.

## Done when

1. **Executable** — queued regression tests reject missing/mismatched birth IDs on non-numeric
   cards, accept matching and numeric-card cases, and prove both scaffold entry points emit a
   matching field. The same new regressions fail on the pre-change implementation.
2. **Executable** — the queued standards gate reports the new path-attributed violation for an
   invalid card and clears it when that card's birth field matches; unrelated baseline findings
   are reported separately. Existing numbering-preservation tests remain green.
