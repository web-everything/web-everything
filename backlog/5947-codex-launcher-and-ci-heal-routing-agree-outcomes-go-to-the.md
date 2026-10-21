---
bornAs: x5g1xfw
kind: story
size: 1
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/conveyor/fix-loop-ledger.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Codex launcher and ci-heal routing agree; outcomes go to the fix-loop ledger directly

The original routing fork has already been implemented in this checkout: fix-run accepts ci-heal, reads CI evidence without requiring a review finding, and appends structured outcomes directly to the fix-loop ledger. No new routing decision is made by this preparation.

## Acceptance

- [A1] `t=we:scripts/operations/__tests__/fix-run.test.mjs; q=we:scripts/readiness/heavy-admission.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — Existing regressions at lines 163, 174 and 240 launch ci-heal without review findings, record pre-lane refusals by head, and exercise the real Codex provider route; assert structured no-change/infra outcomes without parsing log prose. These verify existing behavior rather than define new work.

## Non-goals

- [N1] No new provider, route preference or ledger schema. No HTTP endpoint is added; body-size, rate-limit and CSRF controls are inapplicable to this launcher change.

## Edge cases this change must handle

1. **Untrusted text** — Treat CI logs and review prose as untrusted evidence; preserve bounded diagnostics and do not derive outcome enums from agent prose.
2. **Truncated reads** — Missing CI evidence must produce no-ci-failure refusal, never an invented repair or success.
3. **Shared state files** — Use appendFixLoopRow through the ledger owner; do not overwrite the shared journal or scrape it from console output.
4. **Fail closed** — A missing finding still refuses review-fix; ci-heal instead requires CI failure evidence. Ledger write failure must be visible without claiming successful recording.
5. **Identity scoping** — Each row carries repo, PR, head and session; a refusal before lane acquisition still belongs to the resolved PR head.
6. **State over time** — Repeated attempts retain per-head history; a later head must not inherit the previous head’s repair count.
7. **Who wrote it** — The launcher owns outcome classification; the agent’s final message is a note, not an authoritative ledger verdict.

## Grounding

- we:scripts/operations/fix-run.mjs:108 accepts fix and ci-heal; line 592 selects the CI-evidence path.
- we:scripts/operations/fix-run.mjs:552 appends structured outcomes; line 497 explicitly identifies card 5947.
- we:scripts/operations/__tests__/fix-run.test.mjs:163 covers ci-heal without a finding; line 174 covers pre-lane outcomes.

## Open questions

STALE: the CI-heal branch and direct ledger writer are present. Should this card be closed as already shipped? Historical PR references #4984/#4996 are not prerequisite backlog identities and no blockedBy edge is inferred.
