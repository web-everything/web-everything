---
bornAs: xdbo9nr
kind: story
size: 5
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/settings/red-team.json", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs", "we:scripts/operations/__tests__/review-red-team.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red team setting: keep a red-team result whose comment failed to post; the drain hold reads the saved result

Preserve a completed red-team result when its comment errors or is withheld by the secret scrub, and let the drain evaluate that saved result for the live head. Persistence already precedes posting; the missing part is carrying validated findings into the hold decision. A clean saved result can satisfy the hold; confirmed breaks retain the posted-result disposition. Operator approved 2026-10-17: never weaken a hold. Historical #5482/#5480 references are not local prerequisites (their cards concern other work); #5462 is resolved.

## Acceptance

- [A1] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — add real temporary-store round trips from a completed result with failed/withheld posting to the drain: clean results clear the pending-result hold; confirmed breaks still hold. Both assertions must fail against the current boolean-only reader.
- [A2] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/lib/__tests__/drain-queue-safety.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — add adversarial cases: valid JSON with missing recheck evidence, incomplete findings, foreign repo/PR/head, and conflicting clean/broken records cannot clear a hold. Run the same cases for source, docs, config and data changes; no new content exemption.
- [A3] `q=we:scripts/readiness/heavy-admission.mjs; t=we:scripts/operations/__tests__/review-red-team.test.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — retain results on post failure without publishing scrubbed secrets, deduplicate retries and prove a storage failure cannot become a clean result. Exercise the existing policy cascade for saved-result consumption and log its resolved value/source; disabling consumption restores comment-only evaluation.

## Non-goals

- [N1] No relaxation of confirmed-break routing, no secret-scrub bypass, no new HTTP endpoint (body caps, rate limiting and CSRF are inapplicable to this internal store consumer).

## Edge cases this change must handle

1. **Untrusted text** — Treat summaries and model output as data; use validated recheck/disposition fields, never prose assertions of success.
2. **Truncated reads** — Partial or unreadable evidence cannot prove a clean result; retain the hold and expose the read error.
3. **Shared state files** — Reuse existing evidence writers/readers; retries must not create competing verdicts or replace a break with an incomplete row.
4. **Fail closed** — Must refuse clearance on evidence errors; must preserve the same guards for source, docs, config and data.
5. **Identity scoping** — Match repository, PR and exact head; a recorded boolean alone is not an authenticated verdict.
6. **State over time** — A head move invalidates old evidence; a later clean row cannot silently erase unresolved breaks.
7. **Who wrote it** — Require the existing trusted producer and recheck provenance; preserve call identity and source, reject lookalike model-authored evidence.

## Grounding

`we:scripts/operations/review-extra-seats.mjs:1283` writes evidence before posting. `we:scripts/lib/drain-red-team-evidence.mjs:31` reduces rows to a boolean. `we:scripts/lib/drain-queue-safety.mjs:35` evaluates comment disposition and does not consume saved findings.
