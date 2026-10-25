---
bornAs: xq00j42
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/lib/review-core.mjs", "we:scripts/settings/tests-first.json", "we:scripts/__tests__/check-standards-rules.test.mjs", "we:scripts/lib/__tests__/review-core.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a lint test that enumerates non-literal bad acceptance shapes (empty section, no [An] line, a… (from web-everything/web-everything#5501 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-standards-rules.mjs:1443` — Add a lint test that enumerates non-literal bad acceptance shapes (empty section, no [A<n>] line, a TODO variant) and states which are in scope.
2. `we:scripts/lib/review-core.mjs:331` — When adding a settings switch, assert that the whole behaviour disappears (for example, the mandate has no 'COVERAGE' wording) rather than only the new string.
3. `we:scripts/settings/tests-first.json:2` — Add a layout test in we:settings-files.test.mjs that rejects top-level `$`-prefixed keys other than `$comment`.
4. `we:scripts/check-standards-rules.mjs:1443` — Extend the deterministic standards gate with a structured executable-acceptance requirement and negative tests for absent acceptance and prose-only acceptance.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5501@0324572dee9b0b22317d5918dbd812d5e8898d48

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
