---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xyasq62-worker-wrapper-never-count-unverified-or-unknown-work-as-don.md", "we:backlog/xylfibs-quiet-hours-digest-never-lose-held-alerts-oversized-stranded.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule that fails when WE_WORKER_WRAPPER is set in config or defaults while c… (from web-everything/web-everything#4635 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xyasq62-worker-wrapper-never-count-unverified-or-unknown-work-as-don.md:22` — Add a check:standards rule that fails when WE_WORKER_WRAPPER is set in config or defaults while card xyasq62 is not status: done. Also reject open gate-type cards whose A1 or Fail closed lines still contain TODO.
2. `we:backlog/xylfibs-quiet-hours-digest-never-lose-held-alerts-oversized-stranded.md:22` — Add a check:standards rule that blocks moving a card to in-progress while any TODO placeholder remains in Acceptance or Edge cases.
3. `we:backlog/xyasq62-worker-wrapper-never-count-unverified-or-unknown-work-as-don.md:16` — Add a deterministic backlog gate requiring gate-designated cards to provide repository-qualified planned test files, named cases, and assertions for each behavioral requirement.
4. `we:backlog/xylfibs-quiet-hours-digest-never-lose-held-alerts-oversized-stranded.md:16` — Add a deterministic backlog completeness check requiring repository-qualified planned test files, named cases, and observable assertions for behavioral guarantees.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4635@c2afa9c29288d019e170b187ebad1acfcf3d1b07

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
