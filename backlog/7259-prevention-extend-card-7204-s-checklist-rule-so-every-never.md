---
bornAs: xq5qugo
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/delivery-policy.mjs", "we:scripts/lib/__tests__/delivery-policy.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Extend card 7204's checklist rule so every 'never cached' promise must map to one cache-warm-then… (from web-everything/web-everything#5936 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/delivery-policy.mjs:87` — Extend card 7204's checklist rule so every 'never cached' promise must map to one cache-warm-then-revoke test for each cached source kind (defaults, root, pointer, external). Ideally add a table-driven test that loops over source kinds.
2. `we:scripts/lib/delivery-policy.mjs:135` — File a card to key worktree policy caches on size and mtime, or a content hash. Policy files are capped at 1 MiB, so hashing is cheap. This could be a lint on 'cached(...)' callers in trust-boundary modules, but it is a future item.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5360, finding 4 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5936@030e7ffb5bfaeadc2899c9e9e41db601cf8c5710

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
