---
bornAs: xhdzaxo
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5473-prevention-add-the-named-planned-cases-and-a-deterministic-b.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — A filer unit test asserting every appended 'Also raised by' line ends with its idempotency key, o… (from web-everything/web-everything#5509 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/5473-prevention-add-the-named-planned-cases-and-a-deterministic-b.md:45` — A filer unit test asserting every appended 'Also raised by' line ends with its idempotency key, or a check:standards lint over backlog 'Also raised by' lines.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5605, finding 3 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5509@55e5ed6fedc3dfaa635b423edeb4e1d00eaf259d

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.
- [A2] **Regression guard (PR #5717 review)** — Add a deterministic appender test named `alsoRaisedBy_preservesExactApprovalKeyDespiteKeyExampleInDescription`: use prevention prose containing the placeholder `approval-prevention-key:...` and supply the event key `approval-prevention-key:web-everything/web-everything#5688@60d62f8d68721e9b8f2569dabe9b20ad64dfe821` separately. Assert that the appended line ends with exactly `· key ` followed by the supplied event key in one Markdown code span, with no trailing punctuation, and that retrying the same event adds no further attribution.

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

- Also raised by web-everything/web-everything#5688 (finding 1: `we:backlog/5360-prevention-add-a-check-standards-rule-that-fails-a-card-movi.md:85` — A unit test on the 'Also raised by' appender asserting every appended line ends with · key approval-prevention-key:... , plus a check:standards rule that flags 'Also raised by' lines without a key.) · key `approval-prevention-key:web-everything/web-everything#5688@60d62f8d68721e9b8f2569dabe9b20ad64dfe821`
