---
bornAs: xp6omtj
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xg7whui-card-number-rename-after-land-batch.md", "we:backlog/x5qtv82-card-number-ledger-shadow.md"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Implement xpr5245's rule, which requires every concrete test file named in Acceptance or Test pla… (from web-everything/web-everything#5245 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6126-card-number-rename-after-land-batch.md:6` — Implement xpr5245's rule, which requires every concrete test file named in Acceptance or Test plan to be covered by `scope`. The rule is filed in this PR but not yet captured as a gate.
2. `we:backlog/6121-card-number-ledger-shadow.md:30` — Add a review-lens line to xpr5245: append-only ledger plans must state ref protection (no force-push or deletion on the ops branch), a monotonic check against the last verified tip or the checkpoint, and the history-walk method (`--first-parent` or reject merges). Pair it with a named rewind fixture.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5245@a503a16bd5038546ec4c4249a5e24bf62c3f5486

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
