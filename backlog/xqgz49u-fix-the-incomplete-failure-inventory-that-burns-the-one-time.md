---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/merge-gate-inventory.mjs", "we:scripts/lib/merge-gate-ci.mjs"]
dateOpened: "2026-10-30"
tags: []
---

# Fix the incomplete failure inventory that burns the one-time recovery rerun

HIGH cards-to-file entry 2026-10-30 06:57 ET. The message 'incomplete failure inventory; one-time recovery rerun spent' hit #6059, #6023 and #6033 within 50 minutes, so it is systemic, likely the CI failure-inventory reader versus the current CI run shape after the we:.github/workflows/ci.yml restore. Trace once across all three and fix the reader. Core: we:scripts/lib/merge-gate-inventory.mjs.

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
