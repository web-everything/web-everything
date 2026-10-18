---
bornAs: x0xuo66
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5605-prevention-add-a-check-standards-rule-that-errors-on-an-open.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule, or extend the JIT-number step, so that a backlog card's scope entries… (from web-everything/web-everything#4614 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5605-prevention-add-a-check-standards-rule-that-errors-on-an-open.md:6` — Add a `check:standards` rule, or extend the JIT-number step, so that a backlog card's `scope` entries of the form `we:backlog/<id>-...` must resolve to an existing file, or are rewritten when the target card is renumbered.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4614@d78a757d38459e6dc796205822d9fd26719a7643

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

## Also raised by

- Also raised by web-everything/web-everything#5561 (finding 1: `we:backlog/6278-prevention-add-a-deterministic-filer-validation-that-flags-s.md:8` — Add a check:standards or filer rule that every scope entry must resolve to an existing file or a path the PR creates. For we:backlog/<slug> entries it should also try the JIT-renumbered name.) · key `approval-prevention-key:web-everything/web-everything#5561@fc1931a229f23ab2b412354950693786aaef5cff`
- Also raised by web-everything/web-everything#5532 (finding 1: `we:backlog/6245-prevention-require-structured-guarantee-to-test-mappings-thr.md:7` — Add a check:standards rule that every scope entry must resolve to an existing backlog file, or make the JIT-renumber step rewrite scope frontmatter as well as body text.) · key `approval-prevention-key:web-everything/web-everything#5532@3402fc5ad48952eeb8fa630eaa5a74a54b14d259`
