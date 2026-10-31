---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/codex-direct-task.mjs", "we:scripts/gemini-direct-task.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Keep raw seat answers and robust JSON extraction for red-team seats

Delivered by PR #6107 (R280 retro card). Codex and agy-gemini seat calls ended unparseable and classifySeatCall kept only stderr, losing the raw answer. The raw final message (cap 64 KB) is now saved to seat-raw/<callId>.txt for any non-ok call, and JSON extraction handles fenced, echoed, truncated and trailing-prose answers. Core: we:scripts/operations/review-extra-seats.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/review-extra-seats.test.mjs` (delivered by #6107).

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
