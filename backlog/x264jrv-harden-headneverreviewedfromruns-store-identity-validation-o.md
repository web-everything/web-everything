---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/review-red-team-on-skip.mjs", "we:scripts/lib/review-run-index.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Harden headNeverReviewedFromRuns store-identity validation (op, filename PR, abandoned id, archive keys)

Audit follow-ups on the option-G never-reviewed proof in we:scripts/lib/review-red-team-on-skip.mjs: validate op=review-pr, the PR encoded in modern filenames, malformed repo ids (we:scripts/lib/review-run-index.mjs), abandoned-sidecar run ids, and archive keys under other PR directories; keep the bounded-parse convergence (401 records, 300 budget) visible to operators; restore index-test expectations for contradictory identity. Worst case today is one extra full review (R640), never a red-team release.

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
