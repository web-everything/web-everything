---
bornAs: xfjxryx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/lib/rebase-drop-content.mjs", "we:scripts/lib/rebase-drop-manifest.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:scripts/lib/__tests__/rebase-drop-content.test.mjs", "we:scripts/lib/__tests__/rebase-drop-manifest.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a check-standards fixture test, or a rule in we:check-standards-rules.mjs that takes the diff… (from web-everything/web-everything#5075 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards.mjs:1045` — Add a check-standards fixture test, or a rule in we:check-standards-rules.mjs that takes the diff as an argument, so wiring regressions redden a named test. File this as a backlog item.
2. `we:scripts/lib/rebase-drop-content.mjs:346` — Add a grep gate or lint that fails on `!== manifest` / `=== manifest` path comparisons outside we:transient-paths.mjs, so every drain resolver shares one transient-path predicate. File this as a backlog item.
3. `we:scripts/lib/rebase-drop-manifest.mjs:211` — Add deterministic regression tests injecting ls-tree and evidence-removal failures, requiring an error before current, commit-tree, or push; check both command statuses.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5075@244670b0294003e9a3c440667104d709f8667d8d

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
