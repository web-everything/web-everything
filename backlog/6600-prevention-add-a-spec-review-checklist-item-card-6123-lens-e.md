---
bornAs: xliu8lv
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6125-card-number-ledger-gate-rules.md", "we:backlog/6121-card-number-ledger-shadow.md"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a spec-review checklist item (card 6123 lens): every rule that compares an append-only row wi… (from web-everything/web-everything#5245 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6125-card-number-ledger-gate-rules.md:38` — Add a spec-review checklist item (card 6123 lens): every rule that compares an append-only row with mutable repo state must name a test where the state changes after the row is written.
2. `we:backlog/6121-card-number-ledger-shadow.md:176` — Extend the card 6123 rule: every behavioural guarantee stated in Design prose must map to a named test in a scoped test file.
3. `we:backlog/6121-card-number-ledger-shadow.md:96` — A check-standards rule (the card 6123 family): every file the card says it registers in `TRUST_CHAIN` must have a `gate-config` test naming it.
4. `we:backlog/6121-card-number-ledger-shadow.md:1` — Add a review-lens line, and ideally a standards rule, that any setting selecting a fail-closed gate's behaviour is registered in TRUST_CHAIN at `leash: 'spec'` and read from the base ref. This is the same lens line 6123 already proposes for trust roots, so extend it from allow-lists to mode switches.
5. `we:backlog/6121-card-number-ledger-shadow.md:96` — Add a check-standards rule: every new file a card says is registered in TRUST_CHAIN needs a gate-config test line naming that basename. Failing that, put 'one gate-config test per new TRUST_CHAIN member' in the 6123 review-lens checklist.
6. `we:backlog/6125-card-number-ledger-gate-rules.md:47` — Extend the planned we:scripts/__tests__/check-standards-rules.test.mjs legacyDuplicateBornAsAllowlisted case to seed the pair, delete its canonical member, and validate the unchanged ledger; specify preservation of existing assignments separately from initial seed selection.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5245@b34fed67900bc1edc9ff4839b3a70c556671eab9

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
