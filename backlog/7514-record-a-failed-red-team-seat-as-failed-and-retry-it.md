---
bornAs: xfo5nr2
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/red-team-run-result.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-job.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Record a failed red-team seat as failed and retry it

Delivered by PR #6099 (R280 retro card). A non-ok red-team seat was reported as ran/unpublished, which held #6096 for 48 min. We now return status failed with a reason and retry via the existing cooldown/cap-guarded retry. Drain evidence stays fail-closed. Touches we:scripts/lib/red-team-run-result.mjs, we:scripts/operations/review-job.mjs.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/review-red-team.test.mjs we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs` (delivered by #6099).

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
