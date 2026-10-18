---
bornAs: xhrgr3d
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5510-red-main-gets-an-owner.md"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a card-lint rule in check:standards: every item under 'Edge cases this change must handle' mu… (from web-everything/web-everything#4523 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5510-red-main-gets-an-owner.md:26` — Add a card-lint rule in check:standards: every item under 'Edge cases this change must handle' must be matched by a named test in Done-when or a Test plan section.
2. `we:backlog/5510-red-main-gets-an-owner.md:14` — Add one Done-when/edge-case line: a claim counts only if the PR is trusted-author and still open and non-stale, plus a replay test with a spoofed or stale claim that still dispatches.
3. `we:backlog/5510-red-main-gets-an-owner.md:25` — Add a backlog write-gate requiring each behavioral edge constraint to reference a repository-qualified planned test, named case, and observable assertion; review whether those assertions actually defend the constraint.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4523@93ff39203a97952459c467913c39ac2c7495aa4b

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

- Also raised by web-everything/web-everything#5268 (finding 1: `we:backlog/5028-drain-and-lander-must-not-resolve-a-landed-card-whose-blocke.md:47` — Add a check:standards rule for backlog cards. Every we:...test path in scope: must be named in the Test plan section, and every Design item that mentions a test-relevant caller needs a matching planned case.) · key `approval-prevention-key:web-everything/web-everything#5268@7fb90745bf6111c94dd4cfd41ad653d8eb807d0e`
- Also raised by web-everything/web-everything#5525 (finding 6: `we:backlog/xyzpgol-overlap-yield-known-holds.md:27` — Add a deterministic card check requiring each acceptance guarantee to reference a repository-qualified test file, named implemented or planned case, and observable assertion; review whether the assertions actually defend the guarantees.)
