---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/main.ts", "we:src/__tests__/main.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Move the initial-load orchestration into we:route-mounts.ts as a function with injectable fetch, login ch… (from plateauapp/plateau-app#235 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/main.ts:996` — Move the initial-load orchestration into we:route-mounts.ts as a function with injectable fetch, login check and token, and add tests for the login gate, stale token, non-ok response and bad shape. Longer term, add a smoke test that loads each of the 7 routes directly.
2. `we:src/main.ts:996` — Move the initial-load block into an exported function in `we:route-mounts.ts`, taking injected `isLoggedIn`, `fetch` and `location`. Add a check:standards rule requiring each guard named in a PR description's guarantees to map to a named test.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#235@5db0c2cb46e2140ac413f1ea17133095a77d62be

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
