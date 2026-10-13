---
bornAs: xpisb03
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5466-revert-red-check-a-fix-push-s-new-tests-must-fail-with-the-f.md", "we:backlog/5469-stable-finding-identity-in-the-ledger-scoped-re-review-in-sh.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add the named planned cases and a deterministic backlog check requiring behavioral guarantees to… (from web-everything/web-everything#4505 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5466-revert-red-check-a-fix-push-s-new-tests-must-fail-with-the-f.md:37` — Add the named planned cases and a deterministic backlog check requiring behavioral guarantees to reference a repository-qualified test file, named case, and observable assertion.
2. `we:backlog/5469-stable-finding-identity-in-the-ledger-scoped-re-review-in-sh.md:24` — Require explicit divergent-result fixtures for shadow policies, and enforce test-reference completeness through a deterministic backlog check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4505@8e9f38aafb352031eb90f919b9a08b518d347c0a

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.

## Also raised by

- Also raised by web-everything/web-everything#5160 (finding 1: `we:backlog/5943-red-main-repair-patterns-resolve-host-wide-not-per-caller.md:63` — Add a preparation gate requiring each explicit behavioral guarantee to reference a named planned test and its observable assertion; review that assertion for semantic adequacy.) · key `approval-prevention-key:web-everything/web-everything#5160@bbbcd56e8249ec6895433e4b4959981c9c10eb35`
- Also raised by web-everything/web-everything#5225 (finding 1: `we:backlog/4674-file-the-prevention-guard-s-owed-by-chalbert-web-everything.md:27` — Add a preparation gate requiring each behavioral guarantee to map to a repository-qualified planned test, named case, and observable assertion; include omitted settings and override logging explicitly.) · key `approval-prevention-key:web-everything/web-everything#5225@cdaee5662950a8f02789cb92b4b1da765c2ea215`
