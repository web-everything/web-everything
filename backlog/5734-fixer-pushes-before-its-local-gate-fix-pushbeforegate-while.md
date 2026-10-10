---
bornAs: x377nvq
kind: story
size: 3
status: resolved
scope: ["we:scripts/lib/fix-push-policy.mjs", "we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/merge-ai-prs.mjs", "we:skills-src/conveyor/fix-agent-brief.md"]
dateOpened: "2026-10-10"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Fixer pushes before its local gate (fix.pushBeforeGate) while keeping the fix claim until green

Operator go 2026-10-10: the harness pushes a fixer's marked commit to the PR branch right after mark so CI starts while the local verify runs (slot wait ~6 min + gate ~5 min). The fix claim stays held until the local gate is green; review, ci-heal, draft promotion and the drain refuse a claimed PR (drain gained the guard). Setting fix.pushBeforeGate via the policy cascade (standard true, platform preference in we:scripts/lib/delivery-platform-preferences.json, tool settings, env WE_FIX_PUSH_BEFORE_GATE); false = old flow exactly.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs we:scripts/lib/__tests__/fix-push-policy.test.mjs` passes (fails before: no early push, no drain claim guard, no policy module).
- [A2] Push-before-gate: a `fix` await record whose verdict is still running is pushed once per sha through the same claim/ref/PR-bound port as the green push (never force); the log line carries the push time and the policy source.
- [A3] Claim held until green: the reconcile planner (review/advisory/fix/ci-heal/promote-draft), ci-heal spawn, draft promotion and the drain merge site all refuse a claimed PR; the drain refuses on an unreadable claim store (fail closed).
- [A4] Red → fix → push → green releases once; `fix.pushBeforeGate=false` (any layer) is today's behaviour exactly.
- [A5] The fix brief's "never push red" rule now reads: pushing while the claim is held is allowed; releasing on red is never allowed; never amend a marked commit.

## Non-goals

- [N1] ci-heal, delivery and prepare waits keep their current push timing (only `kind: fix` pushes early).
- [N2] The platform preference file (we:scripts/lib/delivery-platform-preferences.json) is introduced by open PR #4708; this card reads it when present and does not create it (an add/add conflict). Declaring `fix.pushBeforeGate` there is a one-line follow-up once #4708 lands.

## Edge cases this change must handle

1. **Untrusted text** — the record's repo/pr/ref are fixer-typed; the early push reuses the green push port, which binds them to the fix claim, the open PR's head ref and the lane pool.
2. **Truncated reads** — an incomplete session listing defers the early push (logged), never pushes on a guess.
3. **Shared state files** — the early-push attempt is persisted on the await record BEFORE the push, so a crash cannot repeat it unboundedly (transient retries capped at maxRetries).
4. **Fail closed** — invalid setting values fall to the next layer and are logged; the drain refuses a merge when the claim store is unreadable (`attachLiveFixClaim` in we:scripts/merge-ai-prs.mjs; pinned by the test 'merge-site reread refuses an unreadable fix claim store', which injects a throwing claim reader).
5. **Identity scoping** — the push names the record's session id, which must hold the fix claim on that exact branch.
6. **State over time** — a re-mark writes a fresh record, so each new sha gets exactly one early push; a known red is never pushed early.
7. **Who wrote it** — only the fix daemon pushes; the fixer never pushes the PR ref itself.
