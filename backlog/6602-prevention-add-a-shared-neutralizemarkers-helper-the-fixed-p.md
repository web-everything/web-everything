---
bornAs: xm7rxg0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/land-human-only.mjs", "we:scripts/operations/land-human-only-io.mjs", "we:scripts/operations/__tests__/land-human-only.test.mjs", "we:scripts/operations/__tests__/land-human-only-io.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a shared neutralizeMarkers() helper (the fixed-point strip) and a check:standards rule that a… (from web-everything/web-everything#5339 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/land-human-only.mjs:172` — Add a shared `neutralizeMarkers()` helper (the fixed-point strip) and a check:standards rule that any comment-body builder interpolating a free-text input must route it through that helper.
2. `we:scripts/operations/land-human-only-io.mjs:59` — Require a positive human-presence step (a typed confirmation of the PR number and head read from /dev/tty) in the sink, and document the env check as defense-in-depth only.
3. `we:scripts/operations/land-human-only-io.mjs:183` — Add a deterministic sink regression test that creates an approved plan, revokes approval without changing its SHA, and asserts that fresh gate evaluation prevents every write.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5339@0a24c76cf45e143df8609058cf82bd3638b253c7

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
