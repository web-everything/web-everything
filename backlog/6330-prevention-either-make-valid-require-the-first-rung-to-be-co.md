---
bornAs: x0wil2n
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/fix-executor-chain.mjs", "we:scripts/lib/__tests__/fix-executor-chain.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Either make valid() require the first rung to be codex, or make the critical gate key on the rung… (from web-everything/web-everything#5332 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/fix-executor-chain.mjs:46` — Either make `valid()` require the first rung to be `codex`, or make the critical gate key on the rung id (`!== 'codex'`) instead of `index > 0`. Add a chain-validation test for it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5332@6022d7aba5ca924ffb379dde4da79131d851e6fc

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
