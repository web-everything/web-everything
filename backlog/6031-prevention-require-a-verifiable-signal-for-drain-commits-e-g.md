---
bornAs: xwc2v2d
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/lib/renamed-pr-refresh.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs", "we:scripts/lib/__tests__/renamed-pr-refresh.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Require a verifiable signal for drain commits (e.g. %G? signature status, or a trailer/co-author… (from web-everything/web-everything#5082 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/queue-branch-numbering.mjs:16` — Require a verifiable signal for drain commits (e.g. `%G?` signature status, or a trailer/co-author the drain adds that is validated against the forge's commit-author login via the API). Add a test where the forger copies the trusted identity. Add a lint or standards rule against using `%an`/`%ae` as a trust anchor.
2. `we:scripts/lib/renamed-pr-refresh.mjs` — Add a deterministic regression test covering head movement for both triggers, and exclude mismatched heads from all refresh planning.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5082@0f5822e8c2ee1e441a040adc72d3819024a3d1f2

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
