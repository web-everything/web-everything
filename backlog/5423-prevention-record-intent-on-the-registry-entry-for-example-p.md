---
bornAs: x7kcvr8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/free-scope.mjs", "we:scripts/operations/__tests__/free-scope.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Record intent on the registry entry (for example purpose: file-card) and apply the folder-vs-fold… (from web-everything/web-everything#4473 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/free-scope.mjs:84` — Record intent on the registry entry (for example `purpose: file-card`) and apply the folder-vs-folder exemption only when both entries carry it. Add a test for a non-filing folder claim that still collides. Add this as a backlog item; no existing gate covers it.
2. `we:scripts/operations/free-scope.mjs:84` — Add an explicit intent marker to registry entries, for example `new-card-only`, so that only claims carrying it are exempt. Alternatively stop registering `backlog/` for card filing at all, which the worker-brief change already points toward. File this as a backlog item. A check:standards rule is not a good fit.
3. `we:scripts/operations/free-scope.mjs:86` — Add a deterministic regression test requiring existing-card folder holders to remain occupied, and require explicit creation-only evidence before exempting folder claims.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4473@55c567e36be795f2acf0047fd18d8bddcc71cc90

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
