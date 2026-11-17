---
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
tags: []
---

# Extend decidePublish proof to every review publication path (review-hold v2 reinforce-later)

In we:scripts/operations/review-pr-io.mjs, `assertPublishable` requires the `decidePublish` proof only on the early/push accept path. The other timing modes and the STACK_HOLD and ADVISORY_NOTE payloads skip it; they still void on a red row, so this is not a new bypass. Apply the same proof on every publication path. Found by the Codex audit of review-hold v2 and ruled a residual under R825.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- review-pr-io-decide-publish` (the vitest filename filter for we:scripts/operations/__tests__/review-pr-io-decide-publish.test.mjs) has a test per path (non-early accept, STACK_HOLD, ADVISORY_NOTE) where a review-gate row in the rollup with decidePublish false holds publication.

## Non-goals

- [N1] n/a: nothing excluded beyond changing the marker or workflow.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reuses decidePublish, which handles it.
2. **Truncated reads** — n/a: reuses decidePublish, which handles it.
3. **Shared state files** — n/a: no state files.
4. **Fail closed** — any decidePublish false or error holds with `review held: review-gate unproven (<reason>)`.
5. **Identity scoping** — n/a: repo, PR and head are bound inside decidePublish.
6. **State over time** — n/a: decidePublish re-reads to close races.
7. **Who wrote it** — n/a: decidePublish trusts only the v1 marker.

## Review prevention follow-up (PR #6938)

When extending the publication paths, add a review-lens checklist item requiring a named test with
the input omitted for each new `x === undefined` fallback. Test each fallback's identity guards,
incomplete evidence and refusal reason. The former run-record file fallback is removed: net files
against current main must never stand in for GitHub's PR files list. The sink regression
`publishes-with-omitted-files-despite-different-run-record-net-basis` covers that production shape.
