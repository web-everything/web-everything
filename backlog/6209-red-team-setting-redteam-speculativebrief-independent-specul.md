---
bornAs: xq2bksy
kind: story
size: 5
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/lib/review-speculative-red-team.mjs", "we:scripts/settings/review.json", "we:scripts/operations/__tests__/review-red-team.test.mjs", "we:scripts/operations/__tests__/review-job-speculative-red-team.test.mjs", "we:scripts/lib/__tests__/review-speculative-red-team.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red team setting redTeam.speculativeBrief=independent: speculative brief from diff and card only

Make redTeam.speculativeBrief=independent the default: build the speculative brief from the pinned diff and card, without juror findings, and reuse it on acceptance of the same input. Juror findings arriving later must not alone invalidate it. Keep head/input freshness, independent recheck and confirmed-break routing. Operator approved 2026-10-17. Historical #5482 is not the local boundary-guard card and supplies no dependency edge.

## Acceptance

- [A1] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/operations/__tests__/review-red-team.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — add an accepted review with later juror findings: the independent brief contains only diff/card context, the same-input speculative pass is reused rather than returning stale, and its findings still pass independent recheck. The current juror-findings stale branch must fail this case.
- [A2] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/operations/__tests__/review-job-speculative-red-team.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — prove a moved head or changed diff/card discards the pass, rejected review publishes no result, and valid JSON falsely claiming a clean outcome cannot bypass confirmed recheck breaks; cover source/docs/config/data inputs without widening scheduling exemptions.
- [A3] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/lib/__tests__/review-speculative-red-team.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — add independent-default cascade cases, env/tool/platform precedence and source logging; unavailable or invalid settings retain the safe default. Preserve the existing speculation on/off switch.

## Non-goals

- [N1] No head-only reuse of changed input, no removal of rechecks or send-back guards, no new receiving/writing HTTP endpoint (body/rate/CSRF controls do not apply).

## Edge cases this change must handle

1. **Untrusted text** — Treat diff/card text as untrusted prompt data, never instructions to alter the review protocol.
2. **Truncated reads** — Incomplete diff/card reads cannot establish a reusable fingerprint; fall back to the sequential path without claiming clean evidence.
3. **Shared state files** — Reuse the existing atomic read sink and result effects; superseded passes cannot duplicate published results.
4. **Fail closed** — Failed or semantically wrong model output cannot become acceptance; retain the hold for all scheduled content kinds.
5. **Identity scoping** — Bind reuse to repo/PR/head and the exact diff/card fingerprint, never another session’s pass.
6. **State over time** — Late juror findings alone do not invalidate; head/input movement does, and non-accept cancels/discards speculation.
7. **Who wrote it** — Preserve provider/model/call provenance and independent recheck authorship when completing a reused pass.

## Grounding

`we:scripts/operations/review-extra-seats.mjs:1073` injects juror findings into briefs; `we:scripts/operations/review-extra-seats.mjs:1628` checks the fingerprint and `we:scripts/operations/review-extra-seats.mjs:1634` rejects later juror findings. `we:scripts/lib/review-speculative-red-team.mjs:61` implements the existing on/off cascade.
