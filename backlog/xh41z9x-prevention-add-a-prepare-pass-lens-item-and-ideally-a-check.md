---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5470-binding-prior-round-late-findings-on-unchanged-code-become-c.md"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a prepare-pass lens item (and ideally a check:standards rule) that every field a Design says… (from web-everything/web-everything#4734 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5470-binding-prior-round-late-findings-on-unchanged-code-become-c.md:88` — Add a prepare-pass lens item (and ideally a `check:standards` rule) that every field a Design says is journaled or recorded names a Test plan assertion on that field.
2. `we:backlog/5470-binding-prior-round-late-findings-on-unchanged-code-become-c.md:104` — Add a prepare-pass lens item that each Test plan bullet names a repository-qualified test file that exists or is declared new.
3. `we:backlog/5470-binding-prior-round-late-findings-on-unchanged-code-become-c.md:57` — Add a prepare-lens item: every 'ignored if written by X' guarantee must name the field that identifies X, and the Test plan must have a fixture that sets that field to a foreign value.
4. `we:backlog/5470-binding-prior-round-late-findings-on-unchanged-code-become-c.md:55` — Make 'unlandedCards is 0 or a landing sweep exists' an explicit precondition of the Follow-up that flips `scopedRereview` to `on`. Enforce it as a settings-validation check that refuses `on` while the sweep card is open.
5. `we:backlog/5470-binding-prior-round-late-findings-on-unchanged-code-become-c.md` — Add a preparation-review check requiring each coordination mechanism to identify a necessary invariant or measured performance requirement that the remaining mechanisms cannot provide; remove mechanisms with neither.
6. `we:backlog/5470-binding-prior-round-late-findings-on-unchanged-code-become-c.md:38` — Add a parameterized planned test over every model-supplied card field, checking the actual file-item payload for newline removal and fixed labels, plus explicit integer assertions for line.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4734@e9e87bc769a07252e83a851736cd9671bb9cf011

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
