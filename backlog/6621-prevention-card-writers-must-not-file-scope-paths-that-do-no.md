---
bornAs: xc5yahg
kind: story
size: 3
status: open
scope: ["we:scripts/lib/approval-prevention-notice.mjs", "we:scripts/lib/review-loop-policy.mjs", "we:scripts/lib/__tests__/approval-prevention-notice.test.mjs", "we:scripts/lib/__tests__/review-loop-policy.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Prevention card writers must not file scope paths that do not exist when a tracked file with that basename does

The approval-time and review-loop prevention writers guess a test sibling as a __tests__/<stem>.test.mjs next to the cited source, and copy juror-cited paths verbatim. When the real file lives elsewhere (e.g. we:scripts/__tests__/pr-state.test.mjs), the card lands with a stale scope entry that the check-standards #3337 rule then warns on. This drift drove the real-backlog finding count to 29 on main; cards 6398 (#5646) and 6457 (#5678) each added one more and broke every merge group on 2026-10-20 (fixed cap of 30 in we:scripts/__tests__/check-standards.test.mjs). Fix at write time: resolve each scope entry against the tracked-file index (buildTrackedPathIndex and scopeBasenameMismatches in we:scripts/check-standards-rules.mjs); when an entry does not exist but exactly one tracked file shares its basename at the best tier, write that path instead; otherwise keep it. Must: never write a scope entry that the #3337 rule would flag with a single suggestion. Separately undecided: whether the real-backlog cap should become a rate (a 1% bound was audited WEAKENED by Codex, so it was withheld).

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
