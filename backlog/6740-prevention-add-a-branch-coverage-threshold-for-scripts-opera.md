---
bornAs: xkjei87
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/land-human-only-io.mjs", "we:scripts/operations/__tests__/land-human-only-io.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Prevention — Add a branch-coverage threshold for scripts/operations/*-io.mjs in the vitest config. Alternative… (from web-everything/web-everything#5752 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/land-human-only-io.mjs:126` — Add a branch-coverage threshold for `scripts/operations/*-io.mjs` in the vitest config. Alternatively, have the review lens require one assertion per `reasons.push` site.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5752@3c3cda0db97e6cc665630fa31a6055617f8699a4

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
