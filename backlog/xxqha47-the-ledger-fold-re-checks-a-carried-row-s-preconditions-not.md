---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# The ledger fold re-checks a carried row's preconditions, not only the append guard

Priority: expedite. In we:scripts/lib/verdict-ledger.mjs fold and foldWithWitness, a carried row's preconditions are checked only by the append guard, not re-checked at fold time. [A1] Executable. Must be fixed before ledger promotion (blocks cards x2sgweq/x9qibqz). Test in we:scripts/lib/__tests__/verdict-ledger.test.mjs.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/lib/__tests__/verdict-ledger.test.mjs` includes a named test that fails before the fix and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not promote the ledger to merge authority; that stays gated by the blocked cards.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: shadow-only ledger, handled by the test named in A1; no new surface beyond the cited code path.
2. **Truncated reads** — n/a: shadow-only ledger, handled by the test named in A1; no new surface beyond the cited code path.
3. **Shared state files** — n/a: shadow-only ledger, handled by the test named in A1; no new surface beyond the cited code path.
4. **Fail closed** — n/a: shadow-only ledger, handled by the test named in A1; no new surface beyond the cited code path.
5. **Identity scoping** — n/a: shadow-only ledger, handled by the test named in A1; no new surface beyond the cited code path.
6. **State over time** — n/a: shadow-only ledger, handled by the test named in A1; no new surface beyond the cited code path.
7. **Who wrote it** — n/a: shadow-only ledger, handled by the test named in A1; no new surface beyond the cited code path.
