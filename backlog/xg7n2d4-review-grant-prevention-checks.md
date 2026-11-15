---
kind: story
status: open
size: 5
parent: "4075"
dateOpened: "2026-11-15"
tags: [review, prevention]
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/conveyor/__tests__/review-referral-hold.test.mjs"]
scopeRationale: "Settings and implementation paths in acceptance are read-only comparison and mutation subjects; the standards rules and fixture tests are the predicted writes."
---

# Review grant prevention checks

PR #6872's changes-requested review at head 781f277f6c5f7af0cc40600231806d18843bf385 owes broader enforcement after the immediate regression repair. The repair adds grant scope and guard matrices, allowed-CI publisher cases, marker escaping, and a settings-default consistency test. This card tracks the requested enforcement beyond those concrete tests.

## Acceptance

- [A1] Add a scoped standards rule comparing numeric literal timing defaults quoted in `we:scripts/settings/review.json` with `REVIEW_TIMING_DEFAULTS` in `we:scripts/lib/review-timing.mjs`. A fixture documenting 1500000 for the 120000 wait must fail, while matching values pass.
- [A2] Add the marker rule requested by the review: comment-body sanitizers using direct HTML-comment deletion outside the shared helper are flagged for provenance review. Distinguish display-only readers from text reposted by trusted writers. Reuse the helper work and broader free-text writer rule already tracked in #6602; do not duplicate that implementation.
- [A3] Extend the guard mutation prevention pattern tracked in #5849 to new grant predicates in `we:scripts/conveyor/reconcile-core.mjs` and run-derived grants in `we:scripts/conveyor/review-referral-hold.mjs`. Require negative cases for head, PR, repo, pending, human hold, scope, CI and cap with a positive grant control. Record redundant predicates separately: draft promotion precedes the grant branch, so removing only the local draft predicate cannot change observable dispatch.
- [A4] Run the new standards fixture at `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` through `npm run test:unit` with the file argument, and the affected reconciliation tests through the existing required gate. Check that a rejected fixture reports the setting or guard name.

## Non-goals

- Changing review eligibility, strict CI policy, round budgets or marker author trust.
- Removing guards by hand in a fix-agent lane to manufacture red evidence. Mutation verification uses the sanctioned isolated harness.

## Edge cases this change must handle

1. **Untrusted text** — scan source and settings as data; never execute description strings or interpolate them into shell commands.
2. **Truncated reads** — missing or unreadable settings and incomplete mutation evidence report an explicit failure.
3. **Shared state files** — n/a: checks consume fixtures and checkout files; no daemon or queue state is changed.
4. **Fail closed** — unsupported default descriptions and missing fixture mappings cannot count as a successful comparison.
5. **Identity scoping** — independently vary head, PR and repo; foreign evidence can neither grant nor spend the current head's grant.
6. **State over time** — retain tests for legacy hold, later attempt and S2b consumption; preserve historical defaults in explicitly historical fixtures.
7. **Who wrote it** — flag reposted free text at the trusted writer boundary; reader-only stripping has different authority and must be classified explicitly.
