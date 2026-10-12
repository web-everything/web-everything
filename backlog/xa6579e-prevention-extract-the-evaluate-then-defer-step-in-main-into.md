---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-gate-check.mjs", "we:scripts/__tests__/merge-gate-check.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Extract the evaluate-then-defer step in main() into an exported function and test it with an env-… (from web-everything/web-everything#5035 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-gate-check.mjs:470` — Extract the evaluate-then-defer step in main() into an exported function and test it with an env-driven fixture (GITHUB_EVENT_NAME=pull_request versus merge_group). Alternatively, add a standards rule that every exported gate-policy helper has an importer under test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5035@98e72991a59b5e311aca77ba84ea203da133dc56

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
