---
kind: story
size: 1
parent: "xvi6k7s"
status: open
scope: ["we:scripts/operations/coroner-pr-postmortem.mjs", "we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: validate malformed records inside coroner core evidence pages

PR #5502 advisory (2026-10-21) owes a deterministic parameterized collector test gate for malformed records inside valid core-page containers. The runtime finding has a not-real ruling; this follow-up must honor that ruling and first establish the intended required fields for each core evidence kind.

## Design
Inspect we:scripts/operations/coroner-pr-postmortem.mjs and add parameterized collector coverage in we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs. Distinguish malformed evidence from legitimate pending or optional fields.

## Acceptance
Named test 'rejects malformed check-run records as incomplete' covers empty objects, missing required evidence fields, invalid field types and mixed valid/invalid records in otherwise valid pages. Assert rejection with incomplete:true for records established as malformed. Cover sibling core-page record schemas and retain valid-record controls, including pending checks.

## Test plan
Use injected collector transports; no network or live credentials. Run npm run test:unit -- coroner-pr-postmortem. Demonstrate a discriminating red proof against a collector that accepts a malformed record, without weakening existing guards.

## Edge cases this change must handle
Untrusted text: fixture data only. Truncated reads: valid containers must not hide bad records. Shared state: isolated temporary roots. Fail closed: incomplete:true on malformed core evidence. Identity scoping: matching PR/head fixtures. State over time: pending checks remain valid. Who wrote it: no trust parser or authorization changes.

## Non-goals
No runtime change or review-label change is authorized by filing this follow-up.
