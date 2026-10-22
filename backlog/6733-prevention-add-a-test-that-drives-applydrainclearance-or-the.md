---
bornAs: xj1ibqw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/human-clearance-carry.mjs", "we:scripts/lib/numbering-carry.mjs", "we:scripts/lib/__tests__/human-clearance-carry.test.mjs", "we:scripts/lib/__tests__/numbering-carry.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a test that drives applyDrainClearance or the real merge-ai-prs path with a numbering-only mo… (from web-everything/web-everything#5233 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/human-clearance-carry.mjs:338` — Add a test that drives `applyDrainClearance` or the real `merge-ai-prs` path with a numbering-only move and asserts the observable outcome. Alternatively, keep the numbering tier gated off until its caller is wired.
2. `we:scripts/lib/numbering-carry.mjs` — Add a deterministic failure-injection regression covering a label-only hold during posting followed by a failed post-write read, and retain a recoverable obligation to validate or withdraw that specific posted record before treating recovery as complete.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5233@3401ef8bf1254eedb365a74d5554a3b258d1f53d

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
