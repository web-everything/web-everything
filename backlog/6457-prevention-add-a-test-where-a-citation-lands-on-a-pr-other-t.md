---
bornAs: xa1fsd7
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/review-precedents.mjs", "we:scripts/lib/review-precedents-io.mjs", "we:scripts/lib/review-precedents.mjs", "we:scripts/__tests__/review-precedents.test.mjs", "we:scripts/lib/__tests__/review-precedents-io.test.mjs", "we:scripts/lib/__tests__/review-precedents.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a test where a citation lands on a PR other than the precedent's source and an operator decis… (from web-everything/web-everything#5243 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/review-precedents.mjs:160` — Add a test where a citation lands on a PR other than the precedent's source and an operator decision exists for it. It should assert that the pair is counted.
2. `we:scripts/lib/review-precedents-io.mjs:165` — Add a test that captures the same comment twice with different `headRefOid` values and asserts the second run is skipped. Derive the id from the comment's identity, such as its url or id, instead of the moving head.
3. `we:scripts/lib/review-precedents.mjs:103` — Add an operator-signed status event (a signature verified against a repo-pinned key) or an operator-only write ref, with a test that a forged-actor status event stays draft. File it as a backlog item. The 6151 card follow-up text mentions the boundary but is not an executable gate.
4. `we:scripts/lib/review-precedents.mjs:232` — Require a path or lens hit for any not-real or dismissing precedent, so keywords alone can never inject one. Add a test where only the keywords are present and a not-real precedent is not injected. File it as a backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5243@e7f22679bdbc2e2e07694892fe827bb270217058

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
