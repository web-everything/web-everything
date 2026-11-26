---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:protocols/tools/validate-protocols.mjs", "we:tests/unit/protocols.test.ts", "we:protocols/tools/__tests__/validate-protocols.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a check:standards rule or CI assertion that the Standards-status merge gate (standards/validate requi… (from plateauapp/plateau-app#246 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:protocols/tools/validate-protocols.mjs:402` — Add a check:standards rule or CI assertion that the Standards-status merge gate (standards/validate required status) exists and is required, so exit 0 with NOT RUN is only possible when the compensating gate is verified. Alternatively exit non-zero in CI unless a repo-level explicit allow flag is set.
2. `we:tests/unit/protocols.test.ts:637` — File a backlog card for a deterministic gate (a required-status-check assertion in the drain or merge path) that fails when standards/validate is not required for protocols changes, and link it from the README claim.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#246@ecd4f94ae4fef6b744af6c97f3ec4eafa2d5c84c

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
