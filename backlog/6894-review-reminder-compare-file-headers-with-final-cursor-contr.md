---
bornAs: xkpzufw
kind: story
size: 1
parent: "6895"
status: open
scope: ["we:skills-src/review/SKILL.md"]
dateOpened: "2026-10-21"
tags: []
---

# Review reminder: compare file headers with final cursor control flow

PR #5502 advisory (2026-10-21) found a stale header claiming the merge cursor advances per item, while receipts and retries persist per item and the cursor advances only after the batch completes without an unquarantined error. The header was corrected in the PR. This is the owed documentation prevention note, not a proposed deterministic gate.

## Design
Add a concise reminder to the applicable prose-accuracy review guidance in we:skills-src/review/SKILL.md: compare file header behavior claims with final control flow, especially batch versus per-item state updates and error paths.

## Acceptance
The review guidance includes the reminder and explains that prose accuracy requires judgment; it does not demand a source-shape test.

## Test plan
Named manual verification case: **review reminder distinguishes per-item receipts from batch-end cursor advancement**. Review the reminder against the PR #5502 example and confirm it directs the reviewer to compare the header with both the successful batch-end cursor update and cursor-retaining error paths, using judgment rather than a source-shape test. Run scoped standards checks for the changed guidance.

## Edge cases this change must handle
Untrusted text, truncated reads, shared state, identity scoping and who wrote it: n/a, review guidance only. Fail closed: do not claim a deterministic prose gate. State over time: reread headers after final control-flow edits.

## Non-goals
No runtime change or review-label change is authorized by filing this follow-up.
