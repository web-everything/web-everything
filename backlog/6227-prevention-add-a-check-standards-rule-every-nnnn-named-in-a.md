---
bornAs: xl3iwue
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xzlh2ts-prevention-require-structured-guarantee-to-test-mappings-thr.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a check:standards rule: every #NNNN named in a card's "Already tracked on open cards" line mu… (from web-everything/web-everything#5532 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xzlh2ts-prevention-require-structured-guarantee-to-test-mappings-thr.md:15` — Add a check:standards rule: every `#NNNN` named in a card's "Already tracked on open cards" line must resolve to a backlog card that contains an "Also raised by" line citing the same source PR and finding. Alternatively, make the filer verify the write before it emits the claim.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5659, finding 3 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5532@c5f746595f921c676b681369427f321dd6c40451

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

- Also raised by web-everything/web-everything#5555 (finding 1: `we:backlog/xwr4bos-prevention-make-the-card-template-require-path-test-name-on.md:16` — Make the filer emit the 'Already tracked' line only for cards whose 'Also raised by' edit is staged in the same change. Add a check:standards rule that fails a card citing '#N → recorded as Also raised by' when card N lacks the idempotency key.)
