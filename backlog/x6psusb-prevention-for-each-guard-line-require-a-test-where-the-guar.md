---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/test-cache-trace.test.mjs", "we:scripts/lib/test-cache-trace.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — For each guard line, require a test where the guard is the only thing that decides the outcome. A… (from web-everything/web-everything#7309 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/test-cache-trace.test.mjs:250` — For each guard line, require a test where the guard is the only thing that decides the outcome. A mutation-testing run over the tracer module would flag this.
2. `we:scripts/lib/__tests__/test-cache-trace.test.mjs:276` — Make the `denies` helper require an explicit op argument, so a default op cannot stand in for the case under test.
3. `we:scripts/lib/test-cache-trace.mjs:143` — Add a traced kind such as `probe` or `exists` whose hash is only present or absent, and add a hashing test for existence-only entries.
4. `we:scripts/lib/__tests__/test-cache-trace.test.mjs:251` — Run mutation testing on security allowlists: delete each guard and require a test to redden. As a cheaper rule, require any test that claims to cover a path-normalisation guard to use an allowed op and a target whose resolution lands exactly on an allowed path, so the result would flip without the guard. A check:standards rule is not practical here, so this is a review-lens item.
5. `we:scripts/lib/__tests__/test-cache-trace.test.mjs:253` — Add exact-directory symlink cases for both stat and exists, and a targeted mutation gate requiring a named test to fail when real(resolve(p)) is replaced with p.
6. `we:scripts/lib/test-cache-trace.mjs:140` — Add a deterministic regression test using a real directory symlink followed by '..', asserting a home-read denial and no traced admission.
7. `we:scripts/lib/__tests__/test-cache-trace.test.mjs` — Parameterize the boundary and credential tests over stat and exists, and add 'an exact allowed Bun directory symlinked to credentials stays denied'; assert home-read denial and no traced admission.
8. `(no file cited)` — Identify or add a deterministic integration test named 'shadow wouldSkip still executes the test and preserves its outcome', and record its repository-qualified file in Acceptance.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7309@f87b7d7afa9b8656474ba6d528148cd320e86325

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
