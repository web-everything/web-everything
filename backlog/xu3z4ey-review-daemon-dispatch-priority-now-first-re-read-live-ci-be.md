---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-job.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Review daemon: dispatch priority:now first, re-read live CI before skipping, stacked PRs never outrank their base

HIGH cards-to-file entry 2026-10-30 16:50 ET. The review daemon skipped #6109 at 20:37Z as ci:failed using a stale failing test result. Needs: dispatch priority:now PRs first; re-read live CI before skipping as ci:failed; stacked PRs must not outrank their base. Core: we:scripts/operations/review-dispatch.mjs.

## Acceptance

- [A1] **Executable** — a new test, written first, that fails before this item lands and passes after, covering the behaviour in the digest.

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
