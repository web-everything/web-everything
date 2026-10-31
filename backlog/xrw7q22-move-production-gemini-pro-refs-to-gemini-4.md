---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/dispatch-routing-policy.json", "we:scripts/lib/dispatch-routing-policy.mjs", "we:scripts/lib/model-probation.json", "we:scripts/lib/antigravity-model-effort.mjs", "we:scripts/gemini-direct-task.mjs", "we:scripts/operations/review-dispatch.mjs", "we:docs/agent/agent-cli-capability-map.md"]
dateOpened: "2026-10-30"
tags: []
---

# Move production Gemini Pro refs to Gemini 4

Delivered by PR #6103 (R280 retro card). Configured Gemini Pro ids were retired (gemini-3.1-pro was rejected as invalid). Production refs now use gemini-4-argon-high across routing policy, probation and the antigravity/gemini spawners. Core: we:scripts/lib/dispatch-routing-policy.json.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs` (delivered by #6103).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing beyond the digest is in scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new input path beyond the digest; existing handling unchanged.
2. **Truncated reads** — n/a: no new input path beyond the digest; existing handling unchanged.
3. **Shared state files** — n/a: no new input path beyond the digest; existing handling unchanged.
4. **Fail closed** — n/a: no new input path beyond the digest; existing handling unchanged.
5. **Identity scoping** — n/a: no new input path beyond the digest; existing handling unchanged.
6. **State over time** — n/a: no new input path beyond the digest; existing handling unchanged.
7. **Who wrote it** — n/a: no new input path beyond the digest; existing handling unchanged.
