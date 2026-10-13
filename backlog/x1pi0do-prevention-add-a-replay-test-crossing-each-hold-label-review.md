---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-workflow-edit-hold.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/drain-workflow-edit-hold.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a replay test crossing each hold label (review:changes, review:pending, review:human) with a… (from web-everything/web-everything#4965 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:848` — Add a replay test crossing each hold label (review:changes, review:pending, review:human) with a workflow edit, to pin the intended precedence.
2. `we:scripts/merge-ai-prs.mjs:852` — Add a dry-run purity test asserting no git fetch is issued when dryRun is true, or inject a read-only exec for dry-run.
3. `we:scripts/lib/drain-workflow-edit-hold.mjs:39` — Add a `check:standards` rule or a shared `renderPathsForComment()` helper that runs `neutralizeCommentMarkers` and strips mentions and links. Every reason builder must route PR-controlled paths through it. Also add a contract test that feeds a marker-shaped filename through each reason builder.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4965@2626b6330a875b31c6b187d5b384b14eacd8c615

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
