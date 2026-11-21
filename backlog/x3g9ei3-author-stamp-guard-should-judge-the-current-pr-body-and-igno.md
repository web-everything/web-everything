---
kind: task
status: open
scope: ["we:scripts/operations/open-pr.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Author-stamp guard should judge the current PR body and ignore angle-bracket placeholders

#7170 author-stamp guard refused on a historical body snapshot (2026-11-21T04:11:48Z); the offender was a literal angle-bracket threadId placeholder in prose, since removed. The guard should judge the CURRENT body and treat angle-bracket placeholders in prose as non-stamp text. Source: build-queue 00:21 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `judges author stamp from current PR body` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Supply different historical and current bodies; assert the decision follows the current body.
- [A2] **Executable** — Planned `ignores literal angle-bracket author placeholders` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Put literal template placeholders in the body; assert they do not create an invalid author stamp finding.
- [A3] **Executable** — Planned `rejects invalid current author stamp` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Supply an actual invalid stamp in the current body; assert PR admission refuses it.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No weakening of real stamp validation.

## Edge cases this change must handle

1. **Untrusted text** — Angle-bracket prose stays non-stamp text.
2. **Truncated reads** — An incomplete current-body read refuses approval.
3. **Shared state files** — Historical snapshots cannot replace the current body.
4. **Fail closed** — Body-read or stamp-parse errors retain refusal.
5. **Identity scoping** — Validate the body for the target PR.
6. **State over time** — Cover a stale snapshot followed by a corrected body.
7. **Who wrote it** — A placeholder cannot impersonate an author stamp.

## Duplicate admission

new-card-from-build-queue-CARD-line --json
