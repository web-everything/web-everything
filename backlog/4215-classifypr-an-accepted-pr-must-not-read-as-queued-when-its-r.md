---
bornAs: xx6kg3f
kind: story
size: 2
parent: "4075"
status: open
scope: ["we:scripts/progress-board.mjs", "we:scripts/__tests__/progress-board.test.mjs"]
dateOpened: "2026-09-26"
tags: []
---

# classifyPr: an accepted PR must not read as queued when its required check has already failed

LIVE 2026-09-26 13:52 ET: PR #2739 (chalbert/web-everything) carried review:accepted + the durable ci:failed label while its required test check had failed; one reconcile tick logged reconcile-refused nothing-owed / phase queued (we:scripts/conveyor/reconcile-core.mjs, borrowing we:scripts/progress-board.mjs#classifyPr for phase). classifyPr's own precedence already checks ci-red before queued, and against #2739's real fixture (review:accepted + ci:failed labels, statusCheckRollup with test:FAILURE) it correctly returns ci-red (confirmed live: ci-heal-2739 is already dispatched and running) — so the one bad tick was a transient race (the rollup read that tick likely caught the check still in flight), not an ordering defect. The real, fixable gap: classifyPr trusts ONLY the freshly-fetched statusCheckRollup for ci-red; when a caller's own gh read returns an empty/partial rollup (a documented gh degradation this same file's header already calls out: rate-limited, --no-gh, a partial GraphQL page), ciFailed([]) is false, and an accepted PR whose required check has ALREADY failed (evidenced by the durable ci:failed label a separate sweep already applied, we:scripts/merge-ai-prs.mjs#isRequiredCheckFailed/CI_LIFECYCLE_LABELS) silently reads as queued/safe-to-land instead of ci-red. Fix: classifyPr's ci-red branch should also trust the durable ci:failed label as a fallback OR'd with the live rollup scan, never replacing it, so a degraded/partial rollup read can never make an already-failed PR look queued. Add a regression test using PR #2739's real labels+checks as the fixture. Also confirmed live: we:scripts/operations/ci-heal-pr-dispatch.mjs never touches a review:* label (comment-only), and the drain's existing reviewed-sha/diff-fingerprint staleness check (we:scripts/merge-ai-prs.mjs, epic #3184/#2979) already covers whether an accept survives a head change from a heal — no change needed there.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
